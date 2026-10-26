import { describe, expect, it } from "vitest";
import { aspectsInQuery, extractAspects, overallPolarity } from "../../src/modules/query-understanding/aspects.js";
import { jaccard, shingles, stem, textSimilarity, tokenize } from "../../src/shared/text.js";

describe("text utilities", () => {
  it("tokenizes, lowercases and expands contractions", () => {
    expect(tokenize("Couldn't SLEEP, 3 am!")).toEqual(["could", "not", "sleep", "3", "am"]);
  });
  it("stems consistently between inflections", () => {
    expect(stem("lights")).toBe(stem("light"));
    expect(stem("walked")).toBe("walk");
    expect(stem("lighting")).toBe("light");
    expect(stem("dimly")).toBe("dim");
    expect(stem("stopped")).toBe("stop");
  });
  it("measures near-duplicate similarity", () => {
    expect(textSimilarity("well lit road with taxis", "well lit road with taxis")).toBe(1);
    expect(textSimilarity("well lit road with taxis", "noisy hotel breakfast spread")).toBe(0);
    expect(jaccard(new Set([1, 2]), new Set([2, 3]))).toBeCloseTo(1 / 3);
    expect(shingles("a b c").size).toBe(2);
  });
});

describe("aspect lexicon (rule-based, not semantic)", () => {
  const byAspect = (t: string) => Object.fromEntries(extractAspects(t).map((a) => [a.aspect, a.polarity]));
  it("detects indirect mentions without the word 'safety'", () => {
    const a = byAspect("The streets were well lit and there were still autos at the stand after midnight.");
    expect(a.lighting).toBe("POSITIVE");
    expect(a.transport).toBeDefined();
    expect(a.late_night).toBe("NEUTRAL");
    expect(a).not.toHaveProperty("perceived_safety");
  });
  it("assigns negative polarity to dark / empty descriptions", () => {
    const a = byAspect("The lane was dark and nobody was around.");
    expect(a.lighting).toBe("NEGATIVE");
    expect(a.activity_isolation).toBe("NEGATIVE");
  });
  it("handles simple negation", () => {
    expect(byAspect("It was not dark at all.").lighting).toBe("POSITIVE");
    expect(byAspect("I did not feel safe walking back.").perceived_safety).toBe("NEGATIVE");
  });
  it("marks mixed evidence", () => {
    const a = byAspect("Main road is brightly lit. The side lane is dark.");
    expect(a.lighting).toBe("MIXED");
  });
  it("finds aspects in queries and aggregates polarity", () => {
    expect(aspectsInQuery("returning late at night; lighting, isolation and transport")).toEqual(expect.arrayContaining(["late_night", "lighting", "activity_isolation", "transport"]));
    expect(overallPolarity([{ aspect: "lighting", polarity: "POSITIVE" }, { aspect: "transport", polarity: "NEGATIVE" }])).toBe("MIXED");
    expect(overallPolarity([{ aspect: "late_night", polarity: "NEUTRAL" }])).toBe("NEUTRAL");
  });
});

describe("regression: plural stemming", () => {
  it("stems words ending in -is (e.g. taxis) like their singular", () => {
    expect(stem("taxis")).toBe(stem("taxi"));
    expect(byAspectIds("Taxis wait outside after midnight.")).toContain("transport");
  });
});
function byAspectIds(t: string) { return extractAspects(t).map((a) => a.aspect); }
