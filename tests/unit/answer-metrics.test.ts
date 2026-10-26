import { describe, expect, it } from "vitest";
import { buildDeterministicAnswer, buildWebSearchQuery, generateAnswer, insufficientAnswer, isDestinationRecommendationQuery, type EvidenceItem } from "../../src/modules/answer/answer.js";
import { aspectCoverage, candidateRecall, dcgAtK, duplicateRate, mean, ndcgAtK, percentile, precisionAtK } from "../../src/modules/evaluation/metrics.js";
import { parseQueryRules } from "../../src/modules/query-understanding/parser.js";
import type { LlmProvider } from "../../src/modules/llm/provider.js";
import type { Selection } from "../../src/modules/ranking/select.js";
import type { WebEvidence } from "../../src/modules/web-search/provider.js";

const intent = parseQueryRules("hotel area in Mumbai for returning late at night; lighting and transport", { cities: ["Mumbai"], neighborhoods: {}, now: new Date("2026-10-20") });
const ev = (id: string, channel: EvidenceItem["channel"], text: string, polarity: "POSITIVE" | "NEGATIVE", firsthand = true): EvidenceItem => ({
  id, channel, sourceType: "SOCIAL_USER", firsthand, writtenAt: "2026-08-14T00:00:00Z", text, isSynthetic: true, aspects: [{ aspect: "lighting", polarity }],
});
const evidence = [ev("op_1", "inner_circle", "Well lit road", "POSITIVE"), ev("op_2", "wider_social", "Dark lane, nobody around", "NEGATIVE", false)];
const selection = { selected: [], adequacy: "sufficient", adequacyNote: "2 relevant", uncoveredAspects: ["transport"], independentFirsthandSources: 1, aspectBalance: [], suppressed: [], reasons: new Map(), clusters: [] } as unknown as Selection;
const noWeb: WebEvidence = { status: "unavailable", provider: "none", reason: "No web-search provider configured.", results: [] };

describe("deterministic evidence summary", () => {
  it("is clearly labelled, cites only selected evidence, surfaces conflict, gaps and the caveat", () => {
    const a = buildDeterministicAnswer({ query: "q", intent, evidence, selection, web: noWeb });
    expect(a.mode).toBe("deterministic-fallback");
    expect(a.text).toMatch(/deterministic fallback/);
    expect(a.text).toMatch(/CONFLICTING/);
    expect(a.text).toMatch(/No evidence found for: Transport/);
    expect(a.text).toMatch(/cannot establish that an area is objectively safe/);
    expect(a.text).toMatch(/SYNTHETIC/);
    expect(a.citations.map((c) => c.id).sort()).toEqual(["op_1", "op_2"]);
    expect(a.text).toMatch(/inner-circle opinion/);
    expect(a.text).toMatch(/wider social\/public opinion, social user, not firsthand/);
  });
  it("keeps web evidence in a separate, labelled section", () => {
    const web: WebEvidence = { status: "ok", provider: "brave", results: [{ id: "W1", title: "Guide", url: "https://x.y", snippet: "s", retrievedAt: "2026-10-20T00:00:00Z", provider: "brave" }] };
    const a = buildDeterministicAnswer({ query: "q", intent, evidence, selection, web });
    expect(a.text).toMatch(/Web results \(separate evidence channel/);
    expect(a.citations.find((c) => c.id === "W1")?.kind).toBe("web");
  });
  it("insufficient evidence makes no recommendation", () => {
    const a = insufficientAnswer(intent, selection, noWeb, "nothing relevant");
    expect(a.mode).toBe("insufficient-evidence");
    expect(a.text).toMatch(/No recommendation is made/);
    expect(a.citations).toEqual([]);
  });
});

describe("LLM answer generation is grounded", () => {
  const llm = (fn: (user: string) => unknown): LlmProvider & { prompts: string[] } => {
    const prompts: string[] = [];
    return { id: "mock:m", kind: "openai", model: "m", prompts, generateJson: async ({ user, schema }: any) => { prompts.push(user); return schema.parse(fn(user)); } };
  };
  it("sends only the selected evidence (no author identities) and accepts valid citations", async () => {
    const p = llm(() => ({ answer: "Mixed picture: a friend found the road lit [op_1] but another report describes a dark lane [op_2].", limitations: ["No transport evidence"], citations: [{ id: "op_1" }, { id: "op_2" }] }));
    const a = await generateAnswer({ query: "q", intent, evidence, selection, web: noWeb, llm: p, timeoutMs: 100 });
    expect(a.mode).toBe("llm");
    expect(a.provider).toBe("mock:m");
    expect(a.citations.map((c) => c.id)).toEqual(["op_1", "op_2"]);
    expect(a.text).toMatch(/Reviews cannot establish/); // caveat appended when the model omitted it
    expect(p.prompts[0]).toContain("[op_1] channel=inner_circle");
    expect(p.prompts[0]).not.toMatch(/Kabir|u_kabir|authorId/);
  });
  it("discards an answer that cites an id outside the selected evidence", async () => {
    const p = llm(() => ({ answer: "Great [op_999]", citations: [{ id: "op_999" }] }));
    const a = await generateAnswer({ query: "q", intent, evidence, selection, web: noWeb, llm: p, timeoutMs: 100 });
    expect(a.mode).toBe("deterministic-fallback");
    expect(a.warnings.join(" ")).toMatch(/op_999/);
  });
  it("falls back (and discloses it) when the provider fails", async () => {
    const failing: LlmProvider = { id: "mock:m", kind: "openai", model: "m", generateJson: async () => { throw new Error("503"); } };
    const a = await generateAnswer({ query: "q", intent, evidence, selection, web: noWeb, llm: failing, timeoutMs: 100 });
    expect(a.mode).toBe("deterministic-fallback");
    expect(a.warnings.join(" ")).toMatch(/LLM answer generation failed \(503\)/);
  });
  it("never calls the LLM when there is no evidence", async () => {
    const p = llm(() => ({ answer: "x" }));
    const a = await generateAnswer({ query: "q", intent, evidence: [], selection: { ...selection, adequacy: "insufficient", adequacyNote: "none" } as Selection, web: noWeb, llm: p, timeoutMs: 100 });
    expect(a.mode).toBe("insufficient-evidence");
    expect(p.prompts).toHaveLength(0);
  });
  it("uses web evidence for destination suggestions when no inner-circle opinion was selected", async () => {
    const web: WebEvidence = {
      status: "ok",
      provider: "tavily",
      results: [{
        id: "W1",
        title: "Top Delhi attractions and visitor guide",
        url: "https://example.com/delhi",
        snippet: "India Gate is a popular Delhi landmark. Visitors review it as a must-see memorial.",
        retrievedAt: "2026-10-25T00:00:00Z",
        provider: "tavily",
      }],
    };
    const p = llm(() => ({
      answer: "No inner-circle opinions were selected, so these suggestions use web sources.",
      limitations: ["Web snippets are not a substitute for full reviews."],
      citations: [{ id: "W1" }],
      webRecommendations: [{
        name: "India Gate",
        overview: "A Delhi landmark mentioned as a popular attraction.",
        reviewSummary: "The source describes it as a visitor must-see.",
        sourceIds: ["W1"],
      }],
    }));
    const a = await generateAnswer({
      query: "Suggest best places to visit in Delhi",
      intent,
      evidence: [],
      selection,
      web,
      llm: p,
      timeoutMs: 100,
      enableWebRecommendations: true,
    });
    expect(a.mode).toBe("llm");
    expect(a.webRecommendations).toHaveLength(1);
    expect(a.webRecommendations[0]?.name).toBe("India Gate");
    expect(a.citations).toContainEqual({ id: "W1", kind: "web" });
    expect(p.prompts[0]).toContain("WEB RECOMMENDATIONS REQUIRED");
    expect(p.prompts[0]).toContain("No relevant social opinions were selected");
  });
  it("rejects web suggestions whose names are absent from their cited snippets", async () => {
    const web: WebEvidence = {
      status: "ok",
      provider: "tavily",
      results: [{ id: "W1", title: "Delhi travel", url: "https://example.com", snippet: "Plan your next holiday.", retrievedAt: "2026-10-25T00:00:00Z", provider: "tavily" }],
    };
    const p = llm(() => ({
      answer: "Suggestions based on web search.",
      limitations: [],
      citations: [],
      webRecommendations: [{ name: "Red Fort", overview: "A landmark.", reviewSummary: "Visitors enjoyed it.", sourceIds: ["W1"] }],
    }));
    const a = await generateAnswer({ query: "best places to visit in Delhi", intent, evidence, selection, web, llm: p, timeoutMs: 100, enableWebRecommendations: true });
    expect(a.webRecommendations).toEqual([]);
    expect(a.warnings.join(" ")).toMatch(/Red Fort/);
  });
});

describe("web fallback query selection", () => {
  it("identifies requested destination lists and adds visitor review terms to web queries", () => {
    expect(isDestinationRecommendationQuery("Suggest best places to visit in Delhi")).toBe(true);
    expect(isDestinationRecommendationQuery("How is the transport in Delhi?")).toBe(false);
    expect(buildWebSearchQuery("Suggest best places to visit in Delhi")).toContain("visitor reviews and traveler experiences");
    expect(buildWebSearchQuery("best places to visit in Delhi reviews")).toBe("best places to visit in Delhi reviews");
  });
});

describe("evaluation metrics (hand-computed)", () => {
  const grades: Record<string, number> = { a: 3, b: 0, c: 2, d: 1, e: 3, f: 2 };
  const g = (id: string) => grades[id] ?? 0;
  it("precision@k", () => {
    expect(precisionAtK(["a", "b", "c", "d", "e"], g, 5)).toBeCloseTo(3 / 5); // a, c, e
    expect(precisionAtK(["a", "b", "c", "d", "e"], g, 5, 3)).toBeCloseTo(2 / 5);
    expect(precisionAtK(["a"], g, 5)).toBeCloseTo(1 / 5); // fixed denominator k
  });
  it("NDCG@k with exponential gain", () => {
    // ranking a(3) b(0) c(2): DCG = 7/1 + 0 + 3/2 = 8.5 ; ideal a(3) e(3) c/f(2): 7 + 7/1.585 + 3/2 = 12.9164
    const all = Object.values(grades);
    const dcg = 7 / Math.log2(2) + 0 + 3 / Math.log2(4);
    const ideal = dcgAtK([3, 3, 2, 2, 1], 3);
    expect(ndcgAtK(["a", "b", "c"], g, all, 3)).toBeCloseTo(dcg / ideal, 6);
    expect(ndcgAtK(["a", "e", "c"], g, all, 3)).toBeCloseTo(dcgAtK([3, 3, 2], 3) / ideal, 6);
    expect(ndcgAtK(["x"], g, [0, 0], 5)).toBeNull(); // no relevant docs: undefined, not 0
  });
  it("candidate recall, aspect coverage, duplicate rate, mean, percentile", () => {
    expect(candidateRecall(["a", "c", "z"], ["a", "c", "e", "f"])).toBe(0.5);
    expect(candidateRecall(["a"], [])).toBeNull();
    expect(aspectCoverage(["lighting", "transport", "noise"], [["lighting"], ["transport", "price"]])).toBeCloseTo(2 / 3);
    expect(aspectCoverage([], [["x"]])).toBeNull();
    expect(duplicateRate(["a", "a2", "b"], [["a", "a2"]])).toBeCloseTo(2 / 3);
    expect(duplicateRate(["a", "b"], [["a", "a2"]])).toBe(0);
    expect(mean([1, null, 3])).toBe(2);
    expect(mean([null])).toBeNull();
    expect(percentile([1, 2, 3, 4, 100], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
  });
});
