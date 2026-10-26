import { ASPECT_BY_ID } from "../query-understanding/aspects.js";
import type { PolarityLabel } from "../query-understanding/aspects.js";

type PlaceEvidence = {
  id: string;
  city: string;
  neighborhood: string | null;
  aspectPolarity: { aspect: string; polarity: PolarityLabel }[];
  rating: number | null;
};

type AspectCounts = { positive: number; negative: number; mixed: number; neutral: number };

export function buildPlaceRecommendations(evidence: PlaceEvidence[]) {
  const places = new Map<string, {
    city: string;
    neighborhood: string;
    evidenceIds: string[];
    counts: AspectCounts;
    aspects: Map<string, AspectCounts>;
    ratings: number[];
  }>();

  for (const item of evidence) {
    if (!item.neighborhood) continue;
    const key = `${item.city.toLowerCase()}|${item.neighborhood.toLowerCase()}`;
    let place = places.get(key);
    if (!place) {
      place = { city: item.city, neighborhood: item.neighborhood, evidenceIds: [], counts: emptyCounts(), aspects: new Map(), ratings: [] };
      places.set(key, place);
    }
    place.evidenceIds.push(item.id);
    if (item.rating !== null) place.ratings.push(item.rating);
    for (const signal of item.aspectPolarity) {
      const aspectCounts = place.aspects.get(signal.aspect) ?? emptyCounts();
      increment(aspectCounts, signal.polarity);
      place.aspects.set(signal.aspect, aspectCounts);
      increment(place.counts, signal.polarity);
    }
  }

  return [...places.values()]
    .map((place) => ({
      city: place.city,
      neighborhood: place.neighborhood,
      evidenceCount: place.evidenceIds.length,
      evidenceIds: place.evidenceIds,
      ...place.counts,
      ratedEvidenceCount: place.ratings.length,
      averageRating: place.ratings.length
        ? Math.round((place.ratings.reduce((sum, rating) => sum + rating, 0) / place.ratings.length) * 10) / 10
        : null,
      status: statusOf(place.counts),
      aspects: [...place.aspects.entries()]
        .sort(([a], [b]) => (ASPECT_BY_ID.get(a)?.label ?? a).localeCompare(ASPECT_BY_ID.get(b)?.label ?? b))
        .map(([aspect, counts]) => ({ aspect, label: ASPECT_BY_ID.get(aspect)?.label ?? aspect, ...counts })),
      balance: place.counts.positive - place.counts.negative - place.counts.mixed * 0.5,
    }))
    .sort((a, b) =>
      b.balance - a.balance ||
      b.positive - a.positive ||
      a.negative - b.negative ||
      b.evidenceCount - a.evidenceCount ||
      a.city.localeCompare(b.city) ||
      a.neighborhood.localeCompare(b.neighborhood))
    .map(({ balance: _balance, ...place }, index) => ({ rank: index + 1, ...place }));
}

function emptyCounts(): AspectCounts {
  return { positive: 0, negative: 0, mixed: 0, neutral: 0 };
}

function increment(counts: AspectCounts, polarity: PolarityLabel) {
  switch (polarity) {
    case "POSITIVE": counts.positive++; break;
    case "NEGATIVE": counts.negative++; break;
    case "MIXED": counts.mixed++; break;
    case "NEUTRAL": counts.neutral++; break;
  }
}

function statusOf(counts: AspectCounts): "more_positive" | "more_negative" | "conflicting" | "neutral" {
  if (counts.positive > counts.negative + counts.mixed * 0.5) return "more_positive";
  if (counts.negative > counts.positive + counts.mixed * 0.5) return "more_negative";
  if (counts.positive + counts.negative + counts.mixed > 0) return "conflicting";
  return "neutral";
}
