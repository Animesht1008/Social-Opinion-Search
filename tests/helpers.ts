import { inject } from "vitest";
import { loadConfig, type AppConfig } from "../src/config/env.js";
import { createContext, type AppContext } from "../src/context.js";
import { TestHashEmbeddingProvider } from "../src/modules/embeddings/test-hash.js";
import { createSession } from "../src/modules/auth/sessions.js";
import type { LlmProvider } from "../src/modules/llm/provider.js";
import type { WebSearchProvider } from "../src/modules/web-search/provider.js";

export const dbAvailable = () => inject("dbAvailable");

export const DEMO_PASSWORD = "test-demo-password-1";

/** Fast scrypt, no rate limiting by default (tests that exercise limits turn it on explicitly). */
export function testConfig(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: "test", DATABASE_URL: inject("dbUrl"), REFERENCE_DATE: "2026-10-20", ENABLE_DEV_ENDPOINTS: "true", AUTH_SCRYPT_LOG2N: "10", RATE_LIMIT_ENABLED: "false", ...extra } as NodeJS.ProcessEnv);
}

/** Real sessions (created like a login would) returned as Authorization headers: { u_riya: { authorization: "Bearer sos_..." } }. */
export async function tokensFor(ctx: AppContext, ids: string[]): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const id of ids) out[id] = { authorization: `Bearer ${(await createSession(ctx.db, id, { ttlHours: 24 })).token}` };
  return out;
}

export async function testContext(o: { embedding?: boolean; llm?: LlmProvider | null; web?: WebSearchProvider | null; config?: Record<string, string> } = {}): Promise<AppContext> {
  return createContext(testConfig(o.config), {
    embedding: o.embedding === false ? null : new TestHashEmbeddingProvider(),
    llm: o.llm ?? null,
    web: o.web ?? null,
  });
}

/** Tiny in-process HTTP mock used for provider tests (no real network). */
import { createServer, type Server } from "node:http";
export async function mockServer(handler: (req: { url: string; method: string; headers: Record<string, any>; body: any }) => { status?: number; json?: unknown; text?: string }): Promise<{ url: string; calls: any[]; close: () => Promise<void> }> {
  const calls: any[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = undefined;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const call = { url: req.url ?? "", method: req.method ?? "", headers: req.headers, body };
      calls.push(call);
      const out = handler(call);
      res.statusCode = out.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(out.text ?? JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
