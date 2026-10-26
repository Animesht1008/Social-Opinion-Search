/**
 * Transparent baseline ranking configuration.
 *
 * The default weights are an a-priori starting point (relevance signals > quality signals > social). They are NOT claimed
 * to be scientifically validated. Any change should come from an experiment in `npm run eval` (see docs/EVALUATION.md).
 */
export interface RankingWeights {
  lexical: number;
  semantic: number;
  aspect: number;
  context: number;
  specificity: number;
  provenance: number;
  freshness: number;
  /** Maximum boost the social signal can add (social-aware mode only). */
  social: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  lexical: 0.2,
  semantic: 0.25,
  aspect: 0.2,
  context: 0.08,
  specificity: 0.1,
  provenance: 0.05,
  freshness: 0.02, // lowered from the a-priori 0.07 after `npm run tune` (dev-selected; docs/EVALUATION.md, Experiment 3)
  social: 0.08,
};

export interface RankingParams {
  weights: RankingWeights;
  freshnessHalfLifeDays: number;
  /** When the query asks for recent evidence, freshness weight is multiplied by this and the half-life is halved. */
  recencyWeightMultiplier: number;
  /** Social boost is multiplied by smoothstep((contentRelevance - low) / (high - low)): closeness cannot rescue irrelevant text. */
  socialGate: { low: number; high: number };
  /** An opinion enters the evidence pool only if it clears the mode-specific relevance gate. */
  relevanceGate: {
    lexicalMin: number; // lexical mode: ts_rank_cd(norm 32) threshold
    semanticMin: number; // semantic / hybrid: cosine threshold. PROVIDER-DEPENDENT: 0.5 was selected on the dev split for GloVe-100 SIF vectors; re-tune (npm run tune) for any other model
    hybridLexicalMin: number; // hybrid: lexical-only admission threshold
    minContentAspects: number; // hybrid: number of matched non-context query aspects that admits an opinion
  };
  selection: { mmrLambda: number; duplicateThreshold: number; sameAuthorPenalty: number; maxBalanceSwaps: number };
}

export const DEFAULT_PARAMS: RankingParams = {
  weights: DEFAULT_WEIGHTS,
  freshnessHalfLifeDays: 365,
  recencyWeightMultiplier: 5, // keeps the effective weight at 0.10 when the user asks for recent evidence (UNTUNED: no recency-graded judgments exist)
  socialGate: { low: 0.12, high: 0.3 },
  relevanceGate: { lexicalMin: 0.05, semanticMin: 0.5, hybridLexicalMin: 0.15, minContentAspects: 1 },
  // duplicateThreshold: measured gap on the synthetic corpus — duplicates score 0.63-1.00, the most similar non-duplicates <= 0.14 (docs/EVALUATION.md)
  selection: { mmrLambda: 0.75, duplicateThreshold: 0.5, sameAuthorPenalty: 0.05, maxBalanceSwaps: 2 },
};

export function withWeights(base: RankingParams, w: Partial<RankingWeights>): RankingParams {
  return { ...base, weights: { ...base.weights, ...w } };
}
