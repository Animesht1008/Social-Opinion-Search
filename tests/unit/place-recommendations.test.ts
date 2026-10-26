import { describe, expect, it } from "vitest";
import { buildPlaceRecommendations } from "../../src/modules/search/recommendations.js";

describe("neighborhood evidence summaries", () => {
  it("groups selected evidence by city and neighborhood and orders polarity signals", () => {
    const summaries = buildPlaceRecommendations([
      { id: "positive-1", city: "Mumbai", neighborhood: "Bandra", rating: 5, aspectPolarity: [{ aspect: "lighting", polarity: "POSITIVE" }] },
      { id: "positive-2", city: "Mumbai", neighborhood: "Bandra", rating: 4, aspectPolarity: [{ aspect: "transport", polarity: "POSITIVE" }] },
      { id: "mixed", city: "Mumbai", neighborhood: "Colaba", rating: 3, aspectPolarity: [{ aspect: "lighting", polarity: "MIXED" }] },
      { id: "negative", city: "Mumbai", neighborhood: "Colaba", rating: null, aspectPolarity: [{ aspect: "transport", polarity: "NEGATIVE" }] },
      { id: "no-neighborhood", city: "Mumbai", neighborhood: null, rating: 5, aspectPolarity: [{ aspect: "lighting", polarity: "POSITIVE" }] },
    ]);

    expect(summaries.map(({ neighborhood }) => neighborhood)).toEqual(["Bandra", "Colaba"]);
    expect(summaries[0]).toMatchObject({
      rank: 1,
      evidenceCount: 2,
      positive: 2,
      negative: 0,
      mixed: 0,
      status: "more_positive",
      ratedEvidenceCount: 2,
      averageRating: 4.5,
      evidenceIds: ["positive-1", "positive-2"],
    });
    expect(summaries[1]).toMatchObject({
      rank: 2,
      positive: 0,
      negative: 1,
      mixed: 1,
      status: "more_negative",
    });
    expect(summaries[0]!.aspects.map(({ aspect }) => aspect)).toEqual(["lighting", "transport"]);
  });

  it("reports balanced signals as conflicting and neutral-only evidence as neutral", () => {
    const summaries = buildPlaceRecommendations([
      { id: "positive", city: "Mumbai", neighborhood: "Juhu", rating: null, aspectPolarity: [{ aspect: "lighting", polarity: "POSITIVE" }] },
      { id: "negative", city: "Mumbai", neighborhood: "Juhu", rating: null, aspectPolarity: [{ aspect: "lighting", polarity: "NEGATIVE" }] },
      { id: "neutral", city: "Mumbai", neighborhood: "Powai", rating: null, aspectPolarity: [{ aspect: "lighting", polarity: "NEUTRAL" }] },
    ]);

    expect(summaries.find(({ neighborhood }) => neighborhood === "Juhu")?.status).toBe("conflicting");
    expect(summaries.find(({ neighborhood }) => neighborhood === "Powai")?.status).toBe("neutral");
  });

  it("summarizes ratings separately and uses all extracted sentiments, independent of query-matched aspects", () => {
    const [summary] = buildPlaceRecommendations([
      { id: "hotel-1", city: "Gurugram", neighborhood: "Novel Enclave", rating: 4, aspectPolarity: [{ aspect: "transport", polarity: "POSITIVE" }, { aspect: "lighting", polarity: "POSITIVE" }] },
      { id: "hotel-2", city: "Gurugram", neighborhood: "Novel Enclave", rating: 4, aspectPolarity: [{ aspect: "transport", polarity: "POSITIVE" }, { aspect: "room_quality", polarity: "POSITIVE" }] },
    ]);

    expect(summary).toMatchObject({
      evidenceCount: 2,
      positive: 4,
      negative: 0,
      status: "more_positive",
      ratedEvidenceCount: 2,
      averageRating: 4,
      aspects: expect.arrayContaining([
        expect.objectContaining({ aspect: "lighting", positive: 1 }),
        expect.objectContaining({ aspect: "room_quality", positive: 1 }),
        expect.objectContaining({ aspect: "transport", positive: 2 }),
      ]),
    });
  });

  it("does not infer sentiment polarity from ratings alone", () => {
    const [summary] = buildPlaceRecommendations([
      { id: "rating-only", city: "Gurugram", neighborhood: "Central", rating: 5, aspectPolarity: [] },
    ]);

    expect(summary).toMatchObject({
      status: "neutral",
      positive: 0,
      negative: 0,
      ratedEvidenceCount: 1,
      averageRating: 5,
    });
  });
});
