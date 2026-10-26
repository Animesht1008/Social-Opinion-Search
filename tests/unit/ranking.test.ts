import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, withWeights } from "../../src/modules/ranking/config.js";
import { aspectScore, contextScore, freshnessScore, provenanceScore, rankCandidates, specificityScore } from "../../src/modules/ranking/rank.js";
import { selectEvidence } from "../../src/modules/ranking/select.js";
import { parseQueryRules } from "../../src/modules/query-understanding/parser.js";
import { extractAspects } from "../../src/modules/query-understanding/aspects.js";
import { buildAccessContext } from "../../src/modules/social-access/access.js";
import type { OpinionRecord, RawCandidate } from "../../src/modules/retrieval/types.js";

const NOW = new Date("2026-10-20T00:00:00Z");
const pctx = { cities: ["Mumbai"], neighborhoods: { Mumbai: ["Colaba"] }, now: NOW };
const intent = parseQueryRules("hotel area in Mumbai for returning late at night; lighting, isolation and transport", pctx);

let n = 0;
function rec(text: string, o: Partial<OpinionRecord> = {}): OpinionRecord {
  return {
    id: o.id ?? `o${++n}`, authorId: o.authorId ?? `a${n}`, authorName: "x", placeName: null, text, city: "Mumbai", neighborhood: "Colaba",
    category: "hotel_area", writtenAt: new Date("2026-08-01T00:00:00Z"), sourceType: "SOCIAL_USER", firsthand: true, visibility: "PUBLIC", rating: 4,
    provenanceSource: "synthetic-seed-v1", provenanceNote: null, repostOfId: null, isSynthetic: true,
    dataSource: { id: "synthetic-seed-v1", name: "Synthetic demo corpus", license: "synthetic", url: null, attribution: null, commercialUseAllowed: true, isSynthetic: true },
    aspects: extractAspects(text).map((a) => ({ aspect: a.aspect, polarity: a.polarity, matchedTerms: a.matchedTerms })), ...o,
  };
}
const raw = (id: string, lexical: number | null, semantic: number | null): RawCandidate => ({ id, lexical, semantic, lexicalRank: null, semanticRank: null, foundBy: [] });
const access = buildAccessContext("me", [{ requesterId: "me", addresseeId: "friend", status: "ACCEPTED", type: "FRIEND", closeness: 5 }], { types: ["FRIEND"], minCloseness: 4 });

function rank(records: OpinionRecord[], raws: RawCandidate[], mode: any = "hybrid", ranking: any = "relevance_first", params = DEFAULT_PARAMS) {
  return rankCandidates({ records: new Map(records.map((r) => [r.id, r])), raw: raws, intent, ctx: access, mode, ranking, params, now: NOW });
}

describe("component scores", () => {
  it("freshness halves every half-life", () => {
    const o = rec("x", { writtenAt: new Date(NOW.getTime() - 365 * 86400000) });
    expect(freshnessScore(o, NOW, 365)).toBeCloseTo(0.5, 2);
    expect(freshnessScore(rec("y", { writtenAt: NOW }), NOW, 365)).toBe(1);
  });
  it("aspect score is coverage of the query's aspects; null when the query has none", () => {
    const o = rec("The main road is brightly lit and taxis wait outside after midnight.");
    const s = aspectScore(o, intent);
    expect(s.matched).toEqual(expect.arrayContaining(["lighting", "transport", "late_night"]));
    expect(s.score).toBeCloseTo(s.matched.length / intent.aspects.length, 3);
    expect(aspectScore(o, parseQueryRules("something unrelated", pctx)).score).toBeNull();
  });
  it("context score rewards matching city/topic and penalises other topics", () => {
    expect(contextScore(rec("a"), intent)).toBeGreaterThan(contextScore(rec("a", { category: "cafe" }), intent));
  });
  it("specificity prefers concrete firsthand detail over generic praise", () => {
    const concrete = rec("We stayed three nights and walked back at 12:30 am past Leopold; the road was lit and taxis waited.");
    const generic = rec("Great place, loved it!", { firsthand: false });
    expect(specificityScore(concrete)).toBeGreaterThan(specificityScore(generic));
  });
  it("provenance down-weights explicit reposts (not independent evidence)", () => {
    expect(provenanceScore(rec("x", { repostOfId: "o1" }))).toBeLessThan(provenanceScore(rec("x")));
  });
});

describe("rankCandidates", () => {
  const relevant = rec("Streets well lit, taxis waiting at 1 am, people around.", { id: "rel" });
  const irrelevant = rec("Best breakfast buffet and a spotless room, five stars!", { id: "irr", rating: 5 });
  it("keeps a highly rated but irrelevant opinion out of the evidence pool", () => {
    const r = rank([relevant, irrelevant], [raw("rel", 0.2, 0.6), raw("irr", null, 0.1)]);
    expect(r[0]!.id).toBe("rel");
    expect(r.find((c) => c.id === "irr")!.isRelevant).toBe(false);
  });
  it("retains matching city-and-topic evidence when semantic phrasing scores just below the generic threshold", () => {
    const gurugramIntent = parseQueryRules("find me some good hotel or area to stay in Gurugram?", {
      cities: ["Gurugram"],
      neighborhoods: { Gurugram: ["Novel Enclave"] },
      now: NOW,
    });
    const gurugramRecord = rec("A convenient area with nearby shops and good transit.", {
      id: "gurugram-hotel-area",
      authorId: "friend",
      city: "Gurugram",
      neighborhood: "Novel Enclave",
    });
    const ranked = rankCandidates({
      records: new Map([[gurugramRecord.id, gurugramRecord]]),
      raw: [raw(gurugramRecord.id, null, 0.434)],
      intent: gurugramIntent,
      ctx: access,
      mode: "hybrid",
      ranking: "relevance_first",
      params: DEFAULT_PARAMS,
      now: NOW,
    });

    expect(ranked[0]!.isRelevant).toBe(true);
    expect(ranked[0]!.channel).toBe("inner_circle");
    expect(ranked[0]!.relevanceReason).toContain("contextual semantic match 0.434 ≥ 0.425 with explicit city and topic: Gurugram / hotel_area");
  });
  it("does not use a city-and-topic match to admit evidence from another category", () => {
    const gurugramIntent = parseQueryRules("hotel or area to stay in Gurugram", {
      cities: ["Gurugram"],
      neighborhoods: { Gurugram: [] },
      now: NOW,
    });
    const cafeRecord = rec("A cafe with good transit.", {
      id: "gurugram-cafe",
      city: "Gurugram",
      category: "cafe",
    });
    const ranked = rankCandidates({
      records: new Map([[cafeRecord.id, cafeRecord]]),
      raw: [raw(cafeRecord.id, null, 0.434)],
      intent: gurugramIntent,
      ctx: access,
      mode: "hybrid",
      ranking: "relevance_first",
      params: DEFAULT_PARAMS,
      now: NOW,
    });

    expect(ranked[0]!.isRelevant).toBe(false);
  });
  it("lexical and semantic modes rank by their own signal only", () => {
    const a = rec("alpha", { id: "a" }), b = rec("beta", { id: "b" });
    expect(rank([a, b], [raw("a", 0.1, null), raw("b", 0.4, null)], "lexical").map((c) => c.id)).toEqual(["b", "a"]);
    expect(rank([a, b], [raw("a", null, 0.9), raw("b", null, 0.2)], "semantic").map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("component scores are exposed and reproducible", () => {
    const [c] = rank([relevant], [raw("rel", 0.2, 0.6)]);
    expect(c!.components).toMatchObject({ lexical: 0.2, semantic: 0.6 });
    expect(Object.keys(c!.components).sort()).toEqual(["aspect", "context", "freshness", "lexical", "provenance", "redundancy", "semantic", "social", "specificity"]);
    expect(rank([relevant], [raw("rel", 0.2, 0.6)])[0]!.finalScore).toBe(c!.finalScore);
  });
  it("weights are configurable", () => {
    const a = rec("alpha", { id: "a" }), b = rec("beta", { id: "b" });
    const raws = [raw("a", 0.5, 0.1), raw("b", 0.1, 0.5)];
    const lexHeavy = rank([a, b], raws, "hybrid", "relevance_first", withWeights(DEFAULT_PARAMS, { lexical: 1, semantic: 0 }));
    const semHeavy = rank([a, b], raws, "hybrid", "relevance_first", withWeights(DEFAULT_PARAMS, { lexical: 0, semantic: 1 }));
    expect(lexHeavy[0]!.id).toBe("a");
    expect(semHeavy[0]!.id).toBe("b");
  });
  it("social-aware boost helps a relevant friend opinion but cannot rescue an irrelevant one", () => {
    const stranger = rec("Streets well lit, taxis waiting at 1 am, people around.", { id: "s", authorId: "stranger" });
    const friend = rec("Streets well lit, taxis waiting at 1 am, people around.", { id: "f", authorId: "friend" });
    const generic = rec("Mumbai is great, you will love it!", { id: "g", authorId: "friend", firsthand: false });
    const raws = [raw("s", 0.2, 0.6), raw("f", 0.2, 0.6), raw("g", 0.01, 0.05)];
    const rf = rank([stranger, friend, generic], raws, "hybrid", "relevance_first");
    const sa = rank([stranger, friend, generic], raws, "hybrid", "social_aware");
    expect(rf.find((c) => c.id === "f")!.components.social).toBe(0);
    expect(sa.find((c) => c.id === "f")!.finalScore).toBeGreaterThan(rf.find((c) => c.id === "f")!.finalScore);
    expect(sa.find((c) => c.id === "f")!.finalScore).toBeGreaterThan(sa.find((c) => c.id === "s")!.finalScore);
    expect(sa.find((c) => c.id === "g")!.components.social).toBe(0); // closeness cannot override irrelevance
    expect(sa.find((c) => c.id === "g")!.isRelevant).toBe(rf.find((c) => c.id === "g")!.isRelevant);
    expect(sa.find((c) => c.id === "g")!.channel).toBe("inner_circle");
  });
});

describe("evidence selection", () => {
  const mk = (id: string, text: string, extra: Partial<OpinionRecord> = {}, lex = 0.3) => rec(text, { id, ...extra });
  const rankAll = (rs: OpinionRecord[], lex = 0.3) => rank(rs, rs.map((r, i) => raw(r.id, lex - i * 0.01, 0.6)));

  it("collapses explicit reposts and near-identical copies but keeps independent reports", () => {
    const a = mk("a", "Stayed near Causeway four nights. Walked back at 12:30 am, the main road is brightly lit and taxis wait outside.", { authorId: "u1" });
    const repost = mk("a2", "Same as before: stayed near Causeway four nights. Walked back at 12:30 am, the main road is brightly lit and taxis wait outside.", { authorId: "u1", repostOfId: "a" });
    const copy = mk("a3", "Stayed near Causeway four nights. Walked back at 12:30 am, the main road is brightly lit and taxis wait outside.", { authorId: "u2" });
    const independent = mk("b", "Juhu roads are empty after 11 pm and cabs kept cancelling on us for half an hour.", { authorId: "u3" });
    const sel = selectEvidence(rankAll([a, repost, copy, independent]), 5, intent, DEFAULT_PARAMS);
    const ids = sel.selected.map((c) => c.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("a2");
    expect(ids).not.toContain("a3");
    expect(sel.suppressed.map((s) => s.id).sort()).toEqual(["a2", "a3"]);
    expect(sel.suppressed.find((s) => s.id === "a2")!.explicitRepost).toBe(true);
    expect(sel.independentFirsthandSources).toBe(2); // duplicates do not inflate independent corroboration
  });
  it("is diversity-aware: prefers a different opinion over a slightly higher-scored redundant one", () => {
    const base = "The road was well lit and taxis were waiting right outside the hotel at 1 am with plenty of people around";
    const r1 = mk("r1", base + " near the market.", { authorId: "u1" });
    const r2 = mk("r2", base + " close to the station.", { authorId: "u2" });
    const diff = mk("d1", "Dead end lane with one working streetlight, nobody around after midnight and no auto available.", { authorId: "u3" });
    const ranked = rank([r1, r2, diff], [raw("r1", 0.3, 0.7), raw("r2", 0.29, 0.7), raw("d1", 0.2, 0.55)]);
    const sel = selectEvidence(ranked, 2, intent, { ...DEFAULT_PARAMS, selection: { ...DEFAULT_PARAMS.selection, duplicateThreshold: 0.95, maxBalanceSwaps: 0 } });
    const ids = sel.selected.map((c) => c.id);
    expect(ids).toContain("d1");
    expect(ids.filter((i) => i === "r1" || i === "r2")).toHaveLength(1); // only one of the two redundant reports
  });
  it("surfaces negative/conflicting evidence instead of a one-sided top-k", () => {
    const pos = [1, 2, 3, 4].map((i) => mk(`p${i}`, `Visit ${i}: the road was brightly lit with taxis available at ${i} am, shops open and people around.`, { authorId: `up${i}` }));
    const neg = mk("n1", "The lane behind the hotel was dark and unlit after midnight and nobody was around.", { authorId: "un" });
    const ranked = rank([...pos, neg], [...pos.map((p, i) => raw(p.id, 0.4 - i * 0.01, 0.7)), raw("n1", 0.1, 0.5)]);
    // mmrLambda=1 disables diversity so a pure relevance top-k would be all-positive; the balancing step must fix that.
    const sel = selectEvidence(ranked, 3, intent, { ...DEFAULT_PARAMS, selection: { ...DEFAULT_PARAMS.selection, duplicateThreshold: 0.95, mmrLambda: 1, sameAuthorPenalty: 0 } });
    expect(sel.selected.map((c) => c.id)).toContain("n1");
    expect(sel.reasons.get("n1")).toMatch(/surface .*conflicting evidence/);
    const lighting = sel.aspectBalance.find((b) => b.aspect === "lighting")!;
    expect(lighting.conflicting).toBe(true);
  });
  it("reports insufficient evidence honestly when nothing clears the relevance gate", () => {
    const junk = mk("j", "Lovely breakfast buffet and a great pool.");
    const sel = selectEvidence(rank([junk], [raw("j", null, 0.05)]), 5, intent, DEFAULT_PARAMS);
    expect(sel.selected).toEqual([]);
    expect(sel.adequacy).toBe("insufficient");
  });
  it("flags limited evidence and uncovered aspects", () => {
    const one = mk("o1", "Streets were brightly lit at 1 am.", { authorId: "u1" });
    const sel = selectEvidence(rank([one], [raw("o1", 0.2, 0.6)]), 5, intent, DEFAULT_PARAMS);
    expect(sel.adequacy).toBe("limited");
    expect(sel.uncoveredAspects).toEqual(expect.arrayContaining(["transport"]));
  });
  it("respects the configured evidence limit", () => {
    const rs = Array.from({ length: 10 }, (_, i) => mk(`k${i}`, `Report ${i} about lit roads number ${i * 7} and taxis at ${i} am near spot${i}.`, { authorId: `u${i}` }));
    expect(selectEvidence(rankAll(rs), 4, intent, DEFAULT_PARAMS).selected).toHaveLength(4);
  });
});
