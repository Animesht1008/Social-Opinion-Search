export interface RankingWeights {
  lexical: number;
  semantic: number;
  aspect: number;
  context: number;
  specificity: number;
  provenance: number;
  freshness: number;
  social: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  lexical: 0.2,
  semantic: 0.25,
  aspect: 0.2,
  context: 0.08,
  specificity: 0.1,
  provenance: 0.05,
  freshness: 0.02, 
  social: 0.08,
};

export interface RankingParams {
  weights: RankingWeights;
  freshnessHalfLifeDays: number;
  recencyWeightMultiplier: number;
  socialGate: { low: number; high: number };
  relevanceGate: {
    lexicalMin: number; 
    semanticMin: number;
    hybridLexicalMin: number;
    minContentAspects: number;
  };
  selection: { mmrLambda: number; duplicateThreshold: number; sameAuthorPenalty: number; maxBalanceSwaps: number };
}

export const DEFAULT_PARAMS: RankingParams = {
  weights: DEFAULT_WEIGHTS,
  freshnessHalfLifeDays: 365,
  recencyWeightMultiplier: 5, 
  socialGate: { low: 0.12, high: 0.3 },
  relevanceGate: { lexicalMin: 0.05, semanticMin: 0.5, hybridLexicalMin: 0.15, minContentAspects: 1 },
  selection: { mmrLambda: 0.75, duplicateThreshold: 0.5, sameAuthorPenalty: 0.05, maxBalanceSwaps: 2 },
};

export function withWeights(base: RankingParams, w: Partial<RankingWeights>): RankingParams {
  return { ...base, weights: { ...base.weights, ...w } };
}
