import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import { runEvaluation } from "../../src/modules/evaluation/runner.js";
import { dbAvailable, testContext, tokensFor } from "../helpers.js";

const ok = dbAvailable();

describe.skipIf(!ok)("HTTP API", () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  let A: Record<string, Record<string, string>>;
  beforeAll(async () => { ctx = await testContext(); app = await buildApp(ctx, { serveUi: false }); A = await tokensFor(ctx, ["u_riya", "u_zoya"]); });
  afterAll(async () => { await app.close(); await ctx.close(); });
  const search = (body: unknown, user = "u_riya") => app.inject({ method: "POST", url: "/api/v1/search", headers: { ...A[user], "content-type": "application/json" }, payload: JSON.stringify(body) });

  it("GET /health reports database, pgvector and provider status", async () => {
    const j = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(j).toMatchObject({ status: "ok", database: "ok", pgvector: true });
    expect(j.providers.embedding.kind).toBe("test-only");
    expect(j.providers.embedding.reason).toMatch(/TEST-ONLY/);
    expect(j.providers.llm.configured).toBe(false);
    expect(j.providers.webSearch.configured).toBe(false);
  });
  it("validates input with structured errors", async () => {
    const bad = await search({ query: "hi", mode: "nope", limit: 99, surprise: true });
    expect(bad.statusCode).toBe(400);
    const e = bad.json().error;
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.details.map((d: any) => d.path)).toEqual(expect.arrayContaining(["query", "mode", "limit"]));
    expect((await search({ query: "x".repeat(501) })).statusCode).toBe(400);
  });
  it("enforces request-size limits", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/search", headers: { ...A.u_riya, "content-type": "application/json" }, payload: JSON.stringify({ query: "a".repeat(20000) }) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });
  it("returns 503 with a clear code when semantic retrieval is unavailable", async () => {
    const c = await testContext({ embedding: false });
    const a = await buildApp(c, { serveUi: false });
    try {
      const res = await a.inject({ method: "POST", url: "/api/v1/search", headers: { ...A.u_riya, "content-type": "application/json" }, payload: JSON.stringify({ query: "dark streets", mode: "semantic" }) });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("SEMANTIC_RETRIEVAL_UNAVAILABLE");
    } finally { await a.close(); await c.close(); }
  });
  it("search response carries intent, provider status, candidates with component scores, evidence, latency and warnings", async () => {
    const j = (await search({ query: "Mumbai taxis late at night", mode: "hybrid" })).json();
    for (const k of ["runId", "intent", "providers", "candidates", "selected", "adequacy", "channels", "latencyMs", "warnings", "appliedFilters", "retrieval"]) expect(j).toHaveProperty(k);
    expect(j.candidates[0].components).toHaveProperty("lexical");
    expect(j.latencyMs.total).toBeGreaterThan(0);
    expect(j.answer.mode).toBe("deterministic-fallback");
  });
  it("evaluation endpoints: summary 404 before any run; POST /evaluation/run is dev-only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/evaluation/summary" })).statusCode).toBe(401); // sign-in required
    expect((await app.inject({ method: "GET", url: "/api/v1/evaluation/summary", headers: A.u_riya })).statusCode).toBe(404); // nothing run yet
    const prod = await testContext({ embedding: false, config: { ENABLE_DEV_ENDPOINTS: "false" } });
    const pa = await buildApp(prod, { serveUi: false });
    try {
      expect((await pa.inject({ method: "POST", url: "/api/v1/evaluation/run", headers: A.u_riya })).statusCode).toBe(404);
    } finally { await pa.close(); await prod.close(); }
    const noSem = await testContext({ embedding: false });
    const na = await buildApp(noSem, { serveUi: false });
    try {
      const run = await na.inject({ method: "POST", url: "/api/v1/evaluation/run" });
      expect(run.statusCode).toBe(200);
      const sum = (await na.inject({ method: "GET", url: "/api/v1/evaluation/summary", headers: A.u_riya })).json();
      expect(sum.summary.configs.lexical.all["P@5"]).toBeGreaterThan(0);
    } finally { await na.close(); await noSem.close(); }
  });
});

describe.skipIf(!ok)("seeded corpus and evaluation harness", () => {
  let ctx: AppContext;
  beforeAll(async () => { ctx = await testContext({ embedding: false }); });
  afterAll(async () => { await ctx.close(); });

  it("seed is large, fully labelled as synthetic, and covers the required cases", async () => {
    const ops = await ctx.db.opinion.findMany();
    expect(ops.length).toBeGreaterThanOrEqual(100);
    expect(ops.every((o) => o.isSynthetic && o.provenanceSource === "synthetic-seed-v1" && !!o.provenanceNote)).toBe(true);
    expect((await ctx.db.user.findMany()).every((u) => u.isSynthetic && /synthetic/i.test(u.displayName))).toBe(true);
    expect(new Set(ops.map((o) => o.visibility))).toEqual(new Set(["PUBLIC", "CONNECTIONS", "INNER_CIRCLE", "PRIVATE"]));
    expect(new Set(ops.map((o) => o.sourceType))).toEqual(new Set(["SOCIAL_USER", "PUBLIC_REVIEW"]));
    expect(ops.some((o) => !o.firsthand)).toBe(true);
    expect(ops.some((o) => o.repostOfId)).toBe(true);
    const rels = await ctx.db.relationship.findMany();
    expect(new Set(rels.map((r) => r.status))).toEqual(new Set(["ACCEPTED", "PENDING", "BLOCKED"]));
    const years = new Set(ops.map((o) => o.writtenAt.getUTCFullYear()));
    expect(years.size).toBeGreaterThanOrEqual(3);
    expect(await ctx.db.opinionAspect.count()).toBeGreaterThan(200);
    // Original text is preserved separately from derived aspects.
    const sample = await ctx.db.opinion.findUniqueOrThrow({ where: { id: "op_m01" } });
    expect(sample.text).toMatch(/^Stayed near Causeway/);
  });
  it("benchmark has >=30 judged queries covering the required scenario types", async () => {
    const qs = await ctx.db.evalQuery.findMany({ include: { judgments: true } });
    expect(qs.length).toBeGreaterThanOrEqual(30);
    const tags = new Set(qs.flatMap((q) => q.tags));
    for (const t of ["indirect", "multi_aspect", "negative_evidence", "contradiction", "near_duplicates", "duplicates", "empty_results", "wider_only", "no_inner_circle_evidence", "unauthorized_private", "unverifiable_constraint", "hard_constraint_time", "hard_constraint_firsthand", "hard_constraint_channel", "inner_circle"]) expect(tags.has(t), `missing tag ${t}`).toBe(true);
    expect(qs.flatMap((q) => q.judgments).every((j) => j.grade >= 0 && j.grade <= 3)).toBe(true);
    expect(new Set(qs.flatMap((q) => q.judgments.map((j) => j.grade)))).toEqual(new Set([1, 2, 3]));
    expect(qs.filter((q) => q.expectInsufficient).length).toBeGreaterThanOrEqual(2);
  });
  it("runs reproducibly; semantic modes are reported UNAVAILABLE (not faked) without embeddings; no leaks", async () => {
    const a = await runEvaluation(ctx, { includeAblations: false });
    const b = await runEvaluation(ctx, { includeAblations: false });
    expect(a.summary.configs.semantic.unavailable).toMatch(/UNAVAILABLE/);
    expect(a.summary.configs["hybrid (relevance-first)"].unavailable).toMatch(/UNAVAILABLE/);
    const lex = a.summary.configs.lexical.all;
    expect(lex["P@5"]).toBeGreaterThan(0);
    expect(lex["NDCG@5"]).toBeGreaterThan(0);
    expect(lex["unauthorized leaks"]).toBe(0);
    expect(a.summary.leakSweep.unauthorizedCandidates).toBe(0);
    for (const k of ["P@5", "NDCG@5", "candidate recall", "aspect coverage", "hard-constraint satisfaction"]) expect(lex[k]).toBe(b.summary.configs.lexical.all[k]);
  });
  it("test-only embeddings are never reported as semantic metrics", async () => {
    const c = await testContext(); // TEST-ONLY hash provider with stored vectors
    try {
      const r = await runEvaluation(c, { includeAblations: false });
      expect(r.summary.embedding.available).toBe(false);
      expect(r.summary.configs.semantic.unavailable).toMatch(/TEST-ONLY/);
    } finally { await c.close(); }
  });
});
