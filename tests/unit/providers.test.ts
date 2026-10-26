import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConfigError, loadConfig } from "../../src/config/env.js";
import { GLOVE_MAGIC, GloveEmbeddingProvider } from "../../src/modules/embeddings/glove.js";
import { OpenAiEmbeddingProvider } from "../../src/modules/embeddings/openai.js";
import { createEmbeddingProvider } from "../../src/modules/embeddings/provider.js";
import { TestHashEmbeddingProvider } from "../../src/modules/embeddings/test-hash.js";
import { createLlmProvider, extractJsonObject } from "../../src/modules/llm/provider.js";
import { createWebSearchProvider, fetchWebEvidence } from "../../src/modules/web-search/provider.js";
import { ProviderError } from "../../src/shared/errors.js";
import { cosine } from "../../src/shared/text.js";
import { mockServer } from "../helpers.js";

const base = { DATABASE_URL: "postgresql://x" } as NodeJS.ProcessEnv;

describe("environment validation (fails fast, never silently switches)", () => {
  it("accepts a minimal environment", () => {
    const c = loadConfig({ ...base });
    expect(c.EMBEDDING_PROVIDER).toBe("none");
    expect(c.INNER_CIRCLE_TYPES).toEqual(["FRIEND", "FAMILY"]);
  });
  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
  it("requires keys for configured providers", () => {
    expect(() => loadConfig({ ...base, EMBEDDING_PROVIDER: "openai" })).toThrow(/EMBEDDING_API_KEY/);
    expect(() => loadConfig({ ...base, LLM_PROVIDER: "anthropic" })).toThrow(/LLM_API_KEY/);
    expect(() => loadConfig({ ...base, WEB_SEARCH_PROVIDER: "brave" })).toThrow(ConfigError);
  });
  it("blocks the test-only embedding provider outside tests", () => {
    expect(() => loadConfig({ ...base, EMBEDDING_PROVIDER: "test-hash", NODE_ENV: "production" })).toThrow(/test-only/);
    expect(() => loadConfig({ ...base, EMBEDDING_PROVIDER: "test-hash", NODE_ENV: "development" })).toThrow(/ALLOW_TEST_EMBEDDINGS/);
    expect(loadConfig({ ...base, EMBEDDING_PROVIDER: "test-hash", NODE_ENV: "test" }).EMBEDDING_PROVIDER).toBe("test-hash");
  });
  it("validates the inner-circle definition and reference date", () => {
    expect(() => loadConfig({ ...base, INNER_CIRCLE_TYPES: "BOSS" })).toThrow();
    expect(() => loadConfig({ ...base, REFERENCE_DATE: "not-a-date" })).toThrow(/REFERENCE_DATE/);
    expect(loadConfig({ ...base, INNER_CIRCLE_TYPES: "friend, family", INNER_CIRCLE_MIN_CLOSENESS: "3" }).INNER_CIRCLE_MIN_CLOSENESS).toBe(3);
  });
  it("embedding provider 'none' yields no provider", async () => {
    expect(await createEmbeddingProvider(loadConfig({ ...base }))).toBeNull();
    expect(createLlmProvider(loadConfig({ ...base }))).toBeNull();
    expect(createWebSearchProvider(loadConfig({ ...base }))).toBeNull();
  });
});

function gloveFixture(): Buffer {
  const words: [string, number[]][] = [
    ["the", [0.5, 0.5, 0, 0]], ["street", [1, 0.1, 0, 0.1]], ["road", [0.95, 0.15, 0, 0.1]], ["lit", [0.9, 0, 0.1, 0]],
    ["bright", [0.85, 0.05, 0.15, 0]], ["breakfast", [0, 0.1, 1, 0.2]], ["buffet", [0, 0.05, 0.9, 0.3]], ["pool", [0.05, 0, 0.7, 0.7]],
  ];
  const head = Buffer.alloc(13);
  head.write(GLOVE_MAGIC, 0, "latin1");
  head.writeUInt32LE(4, 5);
  head.writeUInt32LE(words.length, 9);
  const recs = words.map(([w, v]) => {
    const wb = Buffer.from(w);
    const b = Buffer.alloc(2 + wb.length + 16);
    b.writeUInt16LE(wb.length, 0);
    wb.copy(b, 2);
    v.forEach((x, i) => b.writeFloatLE(x, 2 + wb.length + i * 4));
    return b;
  });
  return Buffer.concat([head, ...recs]);
}

describe("embedding providers", () => {
  it("GloVe static vectors: related texts are closer than unrelated ones; vectors are unit length", async () => {
    const p = new GloveEmbeddingProvider(gloveFixture(), "fixture");
    expect(p.kind).toBe("static-word-vectors");
    expect(p.modelKey).toBe("fixture-4@sif-v1");
    const [a, b, c] = await p.embed(["the lit road", "bright street", "breakfast buffet"]);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 5);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
  it("GloVe refuses to embed text with no known words and rejects corrupt files", async () => {
    const p = new GloveEmbeddingProvider(gloveFixture());
    await expect(p.embed(["zzzz qqqq"])).rejects.toThrow(ProviderError);
    expect(() => new GloveEmbeddingProvider(Buffer.from("garbage-garbage-garbage"))).toThrow(/magic/);
  });
  it("test-hash provider is deterministic, normalised and labelled test-only", async () => {
    const p = new TestHashEmbeddingProvider();
    const [a1] = await p.embed(["well lit road"]);
    const [a2] = await p.embed(["well lit road"]);
    expect(a1).toEqual(a2);
    expect(Math.hypot(...a1!)).toBeCloseTo(1, 5);
    expect(p.kind).toBe("test-only");
  });
  it("OpenAI-compatible provider sends the documented request and reorders by index", async () => {
    const srv = await mockServer((req) => ({ json: { data: (req.body.input as string[]).map((_: string, i: number) => ({ index: i, embedding: [i + 1, 0, 0] })).reverse() } }));
    try {
      const p = new OpenAiEmbeddingProvider({ apiKey: "k", baseUrl: srv.url, model: "m1" });
      const out = await p.embed(["a", "b"], { inputType: "document", timeoutMs: 2000 });
      expect(out).toEqual([[1, 0, 0], [2, 0, 0]]);
      expect(srv.calls[0].url).toBe("/embeddings");
      expect(srv.calls[0].headers.authorization).toBe("Bearer k");
      expect(srv.calls[0].body).toMatchObject({ model: "m1", input: ["a", "b"] });
      expect(p.modelKey).toBe("openai-compat:m1");
      expect(p.dimensions).toBe(3);
    } finally { await srv.close(); }
  });
  it("OpenAI-compatible provider surfaces HTTP errors and dimension drift as ProviderError", async () => {
    const bad = await mockServer(() => ({ status: 500, json: {} }));
    const drift = await mockServer((req) => ({ json: { data: [{ index: 0, embedding: new Array(req.body.input[0] === "x" ? 3 : 4).fill(0.1) }] } }));
    try {
      await expect(new OpenAiEmbeddingProvider({ apiKey: "k", baseUrl: bad.url, model: "m" }).embed(["a"], { inputType: "query", timeoutMs: 1000 })).rejects.toThrow(/HTTP 500/);
      const p = new OpenAiEmbeddingProvider({ apiKey: "k", baseUrl: drift.url, model: "m" });
      await p.embed(["x"], { inputType: "query", timeoutMs: 1000 });
      await expect(p.embed(["y"], { inputType: "query", timeoutMs: 1000 })).rejects.toThrow(/dimension changed/);
    } finally { await bad.close(); await drift.close(); }
  });
});

describe("LLM providers", () => {
  const schema = z.object({ ok: z.boolean() });
  it("extracts JSON from fenced or chatty output", () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJsonObject("no json here")).toThrow();
  });
  it("Anthropic Messages request shape and validation", async () => {
    const srv = await mockServer(() => ({ json: { content: [{ type: "text", text: '{"ok": true}' }] } }));
    try {
      const p = createLlmProvider(loadConfig({ ...base, LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk", LLM_BASE_URL: srv.url, LLM_MODEL: "anthropic-test" }))!;
      expect(await p.generateJson({ system: "S", user: "U", schema, timeoutMs: 1000 })).toEqual({ ok: true });
      const c = srv.calls[0];
      expect(c.url).toBe("/v1/messages");
      expect(c.headers["x-api-key"]).toBe("sk");
      expect(c.headers["anthropic-version"]).toBe("2023-06-01");
      expect(c.body).toMatchObject({ model: "anthropic-test", system: "S", messages: [{ role: "user", content: "U" }] });
    } finally { await srv.close(); }
  });
  it("OpenAI-compatible chat request shape", async () => {
    const srv = await mockServer(() => ({ json: { choices: [{ message: { content: '{"ok": false}' } }] } }));
    try {
      const p = createLlmProvider(loadConfig({ ...base, LLM_PROVIDER: "openai", LLM_API_KEY: "sk", LLM_BASE_URL: srv.url, LLM_MODEL: "gpt-test" }))!;
      expect(await p.generateJson({ system: "S", user: "U", schema, timeoutMs: 1000 })).toEqual({ ok: false });
      expect(srv.calls[0].url).toBe("/chat/completions");
      expect(srv.calls[0].body.response_format).toEqual({ type: "json_object" });
    } finally { await srv.close(); }
  });
  it("uses Groq strict structured output for supported GPT-OSS models", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok": true}' } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const p = createLlmProvider(loadConfig({
        ...base,
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "k",
        LLM_BASE_URL: "https://api.groq.com/openai/v1",
        LLM_MODEL: "openai/gpt-oss-120b",
      }))!;
      expect(await p.generateJson({ system: "Return JSON only.", user: "U", schema, timeoutMs: 1000 })).toEqual({ ok: true });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.max_completion_tokens).toBe(1200);
      expect(body.reasoning_effort).toBe("low");
      expect(body).not.toHaveProperty("max_tokens");
      expect(body.response_format.type).toBe("json_schema");
      expect(body.response_format.json_schema).toMatchObject({ name: "grounded_response", strict: true });
      expect(body.response_format.json_schema.schema).toMatchObject({ required: ["ok"], additionalProperties: false });
      expect(body.response_format.json_schema.schema).not.toHaveProperty("minLength");
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("rejects non-JSON and schema-violating output; times out", async () => {
    const junk = await mockServer(() => ({ json: { content: [{ type: "text", text: "I think so" }] } }));
    const wrong = await mockServer(() => ({ json: { content: [{ type: "text", text: '{"ok": "yes"}' }] } }));
    try {
      const mk = (url: string) => createLlmProvider(loadConfig({ ...base, LLM_PROVIDER: "anthropic", LLM_API_KEY: "k", LLM_BASE_URL: url }))!;
      await expect(mk(junk.url).generateJson({ system: "", user: "", schema, timeoutMs: 1000 })).rejects.toThrow(/valid JSON/);
      await expect(mk(wrong.url).generateJson({ system: "", user: "", schema, timeoutMs: 1000 })).rejects.toThrow(/schema validation/);
      await expect(mk("http://127.0.0.1:9").generateJson({ system: "", user: "", schema, timeoutMs: 500 })).rejects.toThrow(ProviderError);
    } finally { await junk.close(); await wrong.close(); }
  });
});

describe("web search channel", () => {
  it("is explicitly unavailable when not configured", async () => {
    const w = await fetchWebEvidence(null, "q", 100);
    expect(w).toMatchObject({ status: "unavailable", results: [] });
  });
  it("labels real provider results and never throws on failure", async () => {
    const srv = await mockServer((req) => req.url.includes("fail") ? { status: 500 } : { json: { web: { results: [{ title: "T", url: "https://e.x", description: "<b>snip</b>" }] } } });
    try {
      const mk = () => createWebSearchProvider(loadConfig({ ...base, WEB_SEARCH_PROVIDER: "brave", WEB_SEARCH_API_KEY: "k", WEB_SEARCH_BASE_URL: srv.url }))!;
      const ok = await fetchWebEvidence(mk(), "mumbai", 1000);
      expect(ok.status).toBe("ok");
      expect(ok.results[0]).toMatchObject({ id: "W1", title: "T", snippet: "snip", provider: "brave" });
      expect(srv.calls[0].headers["x-subscription-token"]).toBe("k");
      const down = await fetchWebEvidence({ id: "brave", search: async () => { throw new ProviderError("brave", "HTTP 500"); } }, "q", 100);
      expect(down.status).toBe("error");
    } finally { await srv.close(); }
  });
  it("sends Tavily search requests and maps results into web evidence", async () => {
    const srv = await mockServer((req) => ({
      json: {
        results: [{ title: "T", url: "https://e.x", content: "<b>snippet</b>" }],
      },
    }));
    try {
      const p = createWebSearchProvider(loadConfig({ ...base, WEB_SEARCH_PROVIDER: "tavily", WEB_SEARCH_API_KEY: "k", WEB_SEARCH_BASE_URL: srv.url }))!;
      const result = await fetchWebEvidence(p, "mumbai hotels", 1000);
      expect(result.status).toBe("ok");
      expect(result.provider).toBe("tavily");
      expect(result.results[0]).toMatchObject({ id: "W1", title: "T", url: "https://e.x", snippet: "snippet", provider: "tavily" });
      expect(srv.calls[0].url).toBe("/search");
      expect(srv.calls[0].body).toMatchObject({ api_key: "k", query: "mumbai hotels", max_results: 5, search_depth: "basic", include_answer: false });
    } finally { await srv.close(); }
  });
});
