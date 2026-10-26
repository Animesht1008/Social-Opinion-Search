import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, testContext } from "../helpers.js";
import type { AppContext } from "../../src/context.js";
import { runSearch, SearchRequestSchema, type SearchRequest } from "../../src/modules/search/search-service.js";
import { TestHashEmbeddingProvider } from "../../src/modules/embeddings/test-hash.js";
import { AppError } from "../../src/shared/errors.js";
import type { LlmProvider } from "../../src/modules/llm/provider.js";
import type { WebSearchProvider } from "../../src/modules/web-search/provider.js";
import { ProviderError } from "../../src/shared/errors.js";

const ok = dbAvailable();
const HEADLINE = "I'm visiting Mumbai with my sister. Find a hotel area suitable for returning late at night; consider lighting, isolation and transport.";
const req = (query: string, o: Partial<SearchRequest> = {}): SearchRequest => SearchRequestSchema.parse({ query, generateAnswer: false, includeWeb: false, ...o });

describe.skipIf(!ok)("retrieval modes (PostgreSQL FTS + pgvector)", () => {
  let ctx: AppContext;
  beforeAll(async () => { ctx = await testContext(); });
  afterAll(async () => { await ctx.close(); });

  it("lexical: ranked FTS candidates with scores, no semantic component", async () => {
    const { response, internals } = await runSearch(ctx, "u_riya", req("dark streets nobody around", { mode: "lexical" }), { persist: false });
    expect(response.retrieval.effectiveMode).toBe("lexical");
    expect(response.retrieval.fallback).toBeNull();
    const ranked = internals.ranked;
    expect(ranked.length).toBeGreaterThan(2);
    expect(ranked.every((c) => c.raw.lexical !== null && c.raw.lexical > 0 && c.raw.semantic === null)).toBe(true);
    const scores = ranked.map((c) => c.finalScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(ranked.map((c) => c.id)).toContain("op_m11"); // "dark in patches and nobody is around"
  });
  it("lexical: metadata and hard-constraint filters are applied in SQL", async () => {
    const f = await runSearch(ctx, "u_riya", req("hotel lit streets night", { mode: "lexical", filters: { city: "Mumbai", firsthandOnly: true, since: "2026-01-01" } }), { persist: false });
    expect(f.internals.ranked.length).toBeGreaterThan(3);
    for (const c of f.internals.ranked) {
      expect(c.record.city).toBe("Mumbai");
      expect(c.record.firsthand).toBe(true);
      expect(c.record.writtenAt >= new Date("2026-01-01")).toBe(true);
    }
  });
  it("semantic: vector search over stored embeddings, ordered by cosine similarity", async () => {
    const { internals } = await runSearch(ctx, "u_riya", req("well lit road taxis waiting after midnight", { mode: "semantic" }), { persist: false });
    const sims = internals.retrieval.candidates.map((c) => c.semantic!);
    expect(sims.length).toBeGreaterThan(5);
    expect(internals.retrieval.candidates.every((c) => c.lexical === null && c.semantic !== null)).toBe(true);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
  });
  it("hybrid: unions both candidate sets, deduplicates by id and completes component scores", async () => {
    const q = "dark lanes and taxis late at night in Mumbai";
    const lex = (await runSearch(ctx, "u_riya", req(q, { mode: "lexical" }), { persist: false })).internals.retrieval.candidates.map((c) => c.id);
    const sem = (await runSearch(ctx, "u_riya", req(q, { mode: "semantic" }), { persist: false })).internals.retrieval.candidates.map((c) => c.id);
    const hyb = (await runSearch(ctx, "u_riya", req(q, { mode: "hybrid" }), { persist: false })).internals.retrieval.candidates;
    const ids = hyb.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set([...lex, ...sem]));
    expect(hyb.some((c) => c.foundBy.length === 2)).toBe(true);
    for (const c of hyb) expect(c.semantic).not.toBeNull(); // completed for lexical-only hits
  });
  it("hybrid can surface opinions that share no query words (indirect match)", async () => {
    const { internals } = await runSearch(ctx, "u_riya", req(HEADLINE, { mode: "hybrid" }), { persist: false });
    const m12 = internals.ranked.find((c) => c.id === "op_m12"); // "well lit even at 1 am" — no 'lighting'/'isolation'/'transport'
    expect(m12).toBeDefined();
    expect(m12!.raw.lexical).toBeNull();
    expect(m12!.isRelevant).toBe(true); // admitted via aspect/semantic signal, not keywords
  });
});

describe.skipIf(!ok)("unavailable semantic retrieval is reported, never silently replaced", () => {
  it("semantic/hybrid without an embedding provider -> explicit error", async () => {
    const ctx = await testContext({ embedding: false });
    try {
      for (const mode of ["semantic", "hybrid"] as const) {
        const err = await runSearch(ctx, "u_riya", req("dark streets", { mode }), { persist: false }).catch((e) => e);
        expect(err).toBeInstanceOf(AppError);
        expect(err.code).toBe("SEMANTIC_RETRIEVAL_UNAVAILABLE");
        expect(err.statusCode).toBe(503);
      }
    } finally { await ctx.close(); }
  });
  it("explicit fallback is labelled in fallback, warnings and effectiveMode", async () => {
    const ctx = await testContext({ embedding: false });
    try {
      const { response } = await runSearch(ctx, "u_riya", req("dark streets", { mode: "hybrid", allowFallback: true }), { persist: false });
      expect(response.retrieval.requestedMode).toBe("hybrid");
      expect(response.retrieval.effectiveMode).toBe("lexical");
      expect(response.retrieval.fallback?.reason).toMatch(/unavailable/);
      expect(response.warnings.join(" ")).toMatch(/FALLBACK.*LEXICAL ONLY/);
      expect(response.providers.embedding.semanticAvailable).toBe(false);
    } finally { await ctx.close(); }
  });
  it("a configured provider with no stored vectors for its model is also unavailable", async () => {
    class Unindexed extends TestHashEmbeddingProvider { override readonly modelKey = "never-indexed-v0"; }
    const ctx = await (await import("../../src/context.js")).createContext((await import("../helpers.js")).testConfig(), { embedding: new Unindexed(), llm: null, web: null });
    try {
      const err = await runSearch(ctx, "u_riya", req("dark streets", { mode: "semantic" }), { persist: false }).catch((e) => e);
      expect(err.code).toBe("SEMANTIC_RETRIEVAL_UNAVAILABLE");
      expect(err.message).toMatch(/embeddings:index/);
    } finally { await ctx.close(); }
  });
});

describe.skipIf(!ok)("end-to-end search behaviour", () => {
  let ctx: AppContext;
  beforeAll(async () => { ctx = await testContext(); });
  afterAll(async () => { await ctx.close(); });

  it("headline query: sufficient evidence from both channels, with scores, reasons and attribution", async () => {
    const { response: r } = await runSearch(ctx, "u_riya", req(HEADLINE, { generateAnswer: true }), { persist: false });
    expect(r.adequacy.status).toBe("sufficient");
    expect(r.selected.length).toBeGreaterThanOrEqual(3);
    expect(r.selected.length).toBeLessThanOrEqual(6);
    expect(new Set(r.selected.map((s) => s.channel))).toEqual(new Set(["inner_circle", "wider_social"]));
    for (const s of r.selected) {
      expect(["SOCIAL_USER", "PUBLIC_REVIEW"]).toContain(s.sourceType);
      expect(s.authorId).toBeTruthy();
      expect(s.selectionReason).not.toBe("");
      expect(s.components).toHaveProperty("specificity");
      expect(s.isSynthetic).toBe(true);
    }
    expect(r.intent.aspects).toEqual(expect.arrayContaining(["lighting", "activity_isolation", "transport"]));
    expect(r.answer?.mode).toBe("deterministic-fallback");
    for (const c of r.answer!.citations) expect(r.selected.map((s) => s.opinionId)).toContain(c.id);
    expect(r.channels.web.status).toBe("skipped");
  });
  it("duplicates are collapsed while the repost and copy stay out of the selected set", async () => {
    const { response: r } = await runSearch(ctx, "u_riya", req("Bandra West well lit busy until 1 am autos Uber", { limit: 8 }), { persist: false });
    const ids = r.selected.map((s) => s.opinionId);
    expect(ids.includes("op_m05") && ids.includes("op_m20")).toBe(false);
    const q2 = await runSearch(ctx, "u_riya", req("Colaba Causeway brightly lit taxis lined up walking back at night", { limit: 8 }), { persist: false });
    const ids2 = q2.response.selected.map((s) => s.opinionId);
    expect(ids2.includes("op_m01") && ids2.includes("op_m21")).toBe(false);
    expect(q2.response.suppressedDuplicates.length + r.suppressedDuplicates.length).toBeGreaterThan(0);
  });
  it("negative and conflicting evidence is retained and flagged", async () => {
    const { response: r } = await runSearch(ctx, "u_riya", req("Is Mumbai well lit at night? lighting after midnight", { limit: 8 }), { persist: false });
    const lighting = r.aspectBalance.find((b) => b.aspect === "lighting")!;
    expect(lighting.positive).toBeGreaterThan(0);
    expect(lighting.negative + lighting.mixed).toBeGreaterThan(0);
    expect(lighting.conflicting).toBe(true);
  });
  it("hard constraints hold for every selected opinion", async () => {
    const a = await runSearch(ctx, "u_riya", req("Mumbai hotel area at night, from people who actually stayed there, in the last 6 months", { limit: 8 }), { persist: false });
    expect(a.response.appliedFilters).toMatchObject({ city: "Mumbai", firsthandOnly: true, since: "2026-04-20" });
    expect(a.response.selected.length).toBeGreaterThan(0);
    for (const s of a.response.selected) { expect(s.city).toBe("Mumbai"); expect(s.firsthand).toBe(true); expect(s.writtenAt >= "2026-04-20").toBe(true); }
    const b = await runSearch(ctx, "u_riya", req("What do only my close friends say about Mumbai at night?", { limit: 8 }), { persist: false });
    expect(b.response.appliedFilters.channels).toEqual(["inner_circle"]);
    expect(b.response.selected.length).toBeGreaterThan(0);
    expect(b.response.selected.every((s) => s.channel === "inner_circle")).toBe(true);
  });
  it("a hard constraint is never overridden by ranking: inner-circle-only with no inner evidence -> empty, not a wider fallback", async () => {
    const { response: r } = await runSearch(ctx, "u_aman", req("Mumbai at night", { filters: { channels: ["inner_circle"], city: "Goa" } }), { persist: false });
    expect(r.selected.every((s) => s.channel === "inner_circle")).toBe(true);
  });
  it("unverifiable hard constraints are disclosed and not applied", async () => {
    const { response: r } = await runSearch(ctx, "u_riya", req("Mumbai hotel area that must have a swimming pool and be safe at night"), { persist: false });
    expect(r.warnings.join(" ")).toMatch(/cannot be verified.*NOT applied/);
    expect(r.intent.hardConstraints.find((c) => c.kind === "unverifiable")?.verifiable).toBe(false);
  });
  it("unknown location -> insufficient evidence, no fabricated recommendation", async () => {
    const { response: r } = await runSearch(ctx, "u_riya", req("I'm visiting Lisbon alone, which hotel area is safe at night?", { generateAnswer: true }), { persist: false });
    expect(r.selected).toEqual([]);
    expect(r.adequacy.status).toBe("insufficient");
    expect(r.answer?.mode).toBe("insufficient-evidence");
    expect(r.answer?.text).toMatch(/No recommendation is made/);
    expect(r.warnings.join(" ")).toMatch(/Lisbon/);
  });
  it("no relevant inner-circle opinions -> falls back to wider sources with an explicit warning", async () => {
    const { response: r } = await runSearch(ctx, "u_aman", req("Delhi hotel area close to the airport with easy metro access"), { persist: false });
    expect(r.channels.inner_circle.selected).toBe(0);
    expect(r.selected.length).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toMatch(/No relevant inner-circle opinions/);
    expect(r.warnings.join(" ")).toMatch(/says nothing about the place/);
  });
  it("social-aware ranking adds relationship context but never admits irrelevant opinions", async () => {
    const rf = await runSearch(ctx, "u_riya", req(HEADLINE, { ranking: "relevance_first", limit: 8 }), { persist: false });
    const sa = await runSearch(ctx, "u_riya", req(HEADLINE, { ranking: "social_aware", limit: 8 }), { persist: false });
    const eligible = (x: typeof rf) => new Set(x.internals.ranked.filter((c) => c.isRelevant).map((c) => c.id));
    expect(eligible(sa)).toEqual(eligible(rf)); // relevance gate is independent of social context
    expect(sa.internals.selection.selected.every((c) => c.isRelevant)).toBe(true);
    expect(rf.internals.ranked.every((c) => c.components.social === 0)).toBe(true);
    expect(sa.internals.ranked.some((c) => c.components.social > 0)).toBe(true);
    const innerShare = (x: typeof rf) => x.internals.selection.selected.filter((c) => c.channel === "inner_circle").length;
    expect(innerShare(sa)).toBeGreaterThanOrEqual(innerShare(rf));
  });
  it("persists run metadata (ids, scores) but never opinion text", async () => {
    const { response } = await runSearch(ctx, "u_riya", req(HEADLINE));
    const row = await ctx.db.searchRun.findUniqueOrThrow({ where: { id: response.runId } });
    expect(row.userId).toBe("u_riya");
    expect(row.selectedIds).toEqual(response.selected.map((s) => s.opinionId));
    const blob = JSON.stringify(row);
    for (const s of response.selected) expect(blob).not.toContain(s.text.slice(0, 40));
    for (const c of row.candidates as Record<string, unknown>[]) expect(Object.keys(c)).not.toContain("text");
  });
});

describe.skipIf(!ok)("providers and graceful degradation", () => {
  const mkLlm = (fn: (user: string) => unknown): LlmProvider & { prompts: string[] } => {
    const prompts: string[] = [];
    return { id: "mock:llm", kind: "openai", model: "llm", prompts, generateJson: async ({ user, schema }: any) => { prompts.push(user); return schema.parse(fn(user)); } };
  };
  it("LLM answer only sees authorized, selected evidence and its citations are verified", async () => {
    const llm = mkLlm((u) => (u.includes("QUESTION") && !u.includes("Known cities")) ? { answer: "A friend found the road lit [op_m01]." , citations: [{ id: "op_m01" }] } : { aspects: ["lighting"] });
    const ctx = await testContext({ llm });
    try {
      const { response: r } = await runSearch(ctx, "u_zoya", req(HEADLINE, { generateAnswer: true }), { persist: false });
      const answerPrompt = llm.prompts.find((p) => p.includes("SOCIAL OPINION EVIDENCE"))!;
      // Zoya has no relationships: INNER_CIRCLE/CONNECTIONS-visibility opinions (e.g. Meera's op_m15, Kabir's op_m01) must never reach the model.
      expect(answerPrompt).not.toContain("op_m15");
      expect(answerPrompt).not.toContain("Marine Drive promenade has lamp posts");
      for (const id of answerPrompt.match(/\[op_[a-z0-9]+\]/g) ?? []) expect(r.selected.map((s) => `[${s.opinionId}]`)).toContain(id);
      // op_m01 is not authorized for Zoya, so the model citing it must be rejected.
      expect(r.answer?.mode).toBe("deterministic-fallback");
      expect(r.warnings.join(" ")).toMatch(/op_m01/);
    } finally { await ctx.close(); }
  });
  it("an LLM outage does not break search; the limitation is disclosed", async () => {
    const llm: LlmProvider = { id: "down:llm", kind: "openai", model: "llm", generateJson: async () => { throw new ProviderError("down", "503"); } };
    const ctx = await testContext({ llm });
    try {
      const { response: r } = await runSearch(ctx, "u_riya", req(HEADLINE, { generateAnswer: true }), { persist: false });
      expect(r.selected.length).toBeGreaterThan(0);
      expect(r.answer?.mode).toBe("deterministic-fallback");
      expect(r.warnings.join(" ")).toMatch(/LLM answer generation failed/);
      expect(r.intent.warnings.join(" ")).toMatch(/LLM query understanding failed/);
      expect(r.intent.parser).toBe("rule-v1");
    } finally { await ctx.close(); }
  });
  it("web evidence is a separate channel; a web outage is disclosed and does not break social retrieval", async () => {
    const okWeb: WebSearchProvider = { id: "mock-web", search: async () => [{ id: "W1", title: "Guide", url: "https://example.org", snippet: "s", retrievedAt: "2026-10-20T00:00:00Z", provider: "mock-web" }] };
    const badWeb: WebSearchProvider = { id: "mock-web", search: async () => { throw new ProviderError("mock-web", "timeout"); } };
    const c1 = await testContext({ web: okWeb });
    const c2 = await testContext({ web: badWeb });
    try {
      const a = await runSearch(c1, "u_riya", req(HEADLINE, { generateAnswer: true, includeWeb: true }), { persist: false });
      expect(a.response.channels.web.status).toBe("ok");
      expect(a.response.channels.web.results).toHaveLength(1);
      expect(a.response.selected.every((s) => !s.opinionId.startsWith("W"))).toBe(true);
      expect(a.response.answer?.text).toMatch(/Web results \(separate evidence channel/);
      const b = await runSearch(c2, "u_riya", req(HEADLINE, { includeWeb: true }), { persist: false });
      expect(b.response.channels.web.status).toBe("error");
      expect(b.response.selected.length).toBeGreaterThan(0);
      expect(b.response.warnings.join(" ")).toMatch(/Web search failed/);
      const none = await runSearch(await testContext(), "u_riya", req(HEADLINE, { includeWeb: true }), { persist: false });
      expect(none.response.channels.web.status).toBe("unavailable");
    } finally { await c1.close(); await c2.close(); }
  });
});
