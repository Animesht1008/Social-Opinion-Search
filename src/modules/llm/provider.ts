import type { ZodType } from "zod";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";
import { ProviderError } from "../../shared/errors.js";

export interface LlmProvider {
  readonly id: string; // provider and configured model identifier
  readonly kind: "anthropic" | "openai";
  readonly model: string;
  /** Ask for a JSON object and validate it. Throws ProviderError on transport/shape failures. */
  generateJson<T>(args: { system: string; user: string; schema: ZodType<T>; maxTokens?: number; timeoutMs: number }): Promise<T>;
}

export interface LlmStatus {
  configured: boolean;
  provider: string;
  service: string;
  model: string | null;
  note: string;
}

/** Extract the first top-level JSON object from model text (tolerates code fences / preamble). */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, provider: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    throw new ProviderError(provider, name === "TimeoutError" ? `request timed out after ${timeoutMs}ms` : `request failed: ${(err as Error).message}`, err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(provider, `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

class AnthropicProvider implements LlmProvider {
  readonly kind = "anthropic" as const;
  readonly id: string;
  constructor(readonly model: string, private apiKey: string, private baseUrl: string) {
    this.id = `anthropic:${model}`;
  }
  async generateJson<T>({ system, user, schema, maxTokens = 1200, timeoutMs }: Parameters<LlmProvider["generateJson"]>[0] & { schema: ZodType<T> }): Promise<T> {
    const json = await postJson(
      `${this.baseUrl.replace(/\/$/, "")}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      { model: this.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
      timeoutMs,
      this.id,
    );
    const text: string = (json?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
    return parseModelJson(text, schema, this.id);
  }
}

class OpenAiChatProvider implements LlmProvider {
  readonly kind = "openai" as const;
  readonly id: string;
  private readonly groqSchemaMode: boolean;
  constructor(readonly model: string, private apiKey: string, private baseUrl: string) {
    this.id = `openai:${model}`;
    const host = baseUrl.match(/^https?:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase();
    this.groqSchemaMode = host === "api.groq.com" && /^openai\/gpt-oss-(?:20b|120b)$/i.test(model);
  }
  async generateJson<T>({ system, user, schema, maxTokens = 1200, timeoutMs }: Parameters<LlmProvider["generateJson"]>[0] & { schema: ZodType<T> }): Promise<T> {
    const host = this.baseUrl.match(/^https?:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase();
    const responseFormat = this.groqSchemaMode
      ? { type: "json_schema", json_schema: { name: "grounded_response", strict: true, schema: strictJsonSchema(schema) } }
      : host === "api.groq.com"
        ? undefined
        : { type: "json_object" };
    const json = await postJson(
      `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        ...(this.groqSchemaMode ? { max_completion_tokens: maxTokens, reasoning_effort: "low" } : { max_tokens: maxTokens }),
        ...(responseFormat ? { response_format: responseFormat } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      },
      timeoutMs,
      this.id,
    );
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    return parseModelJson(text, schema, this.id);
  }
}

function strictJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  const unsupportedKeywords = new Set([
    "$schema", "default", "description", "title", "minLength", "maxLength", "minItems", "maxItems",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "format",
  ]);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of unsupportedKeywords) delete record[key];
    if (record.type === "object" && record.properties && typeof record.properties === "object") {
      record.additionalProperties = false;
      record.required = Object.keys(record.properties as Record<string, unknown>);
    }
    Object.values(record).forEach(visit);
  };
  visit(jsonSchema);
  return jsonSchema;
}

function parseModelJson<T>(text: string, schema: ZodType<T>, provider: string): T {
  let raw: unknown;
  try {
    raw = extractJsonObject(text);
  } catch (err) {
    throw new ProviderError(provider, `model did not return valid JSON (${(err as Error).message})`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProviderError(provider, `model output failed schema validation: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ").slice(0, 300)}`);
  return parsed.data;
}

export function createLlmProvider(cfg: AppConfig): LlmProvider | null {
  if (cfg.LLM_PROVIDER === "none") return null;
  const key = cfg.LLM_API_KEY!; // presence validated in loadConfig
  if (cfg.LLM_PROVIDER === "anthropic") return new AnthropicProvider(cfg.LLM_MODEL, key, cfg.LLM_BASE_URL ?? "https://api.anthropic.com");
  return new OpenAiChatProvider(cfg.LLM_MODEL, key, cfg.LLM_BASE_URL ?? "https://api.openai.com/v1");
}

export function llmStatus(cfg: AppConfig, p: LlmProvider | null): LlmStatus {
  const host = cfg.LLM_BASE_URL?.match(/^https?:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase();
  const service = cfg.LLM_PROVIDER === "anthropic"
    ? "Anthropic"
    : host === "api.groq.com"
      ? "Groq (OpenAI-compatible)"
      : host === "api.openai.com" || !host
        ? "OpenAI"
        : "OpenAI-compatible API";
  return p
    ? { configured: true, provider: cfg.LLM_PROVIDER, service, model: p.model, note: "LLM available for intent parsing (validated) and grounded answers." }
    : { configured: false, provider: "none", service: "Not configured", model: null, note: "No LLM configured: rule-based intent parser and deterministic evidence-summary fallback are used." };
}
