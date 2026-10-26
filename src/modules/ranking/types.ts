import type { Channel } from "../social-access/access.js";
import type { OpinionRecord, RawCandidate } from "../retrieval/types.js";
import type { PolarityLabel } from "../query-understanding/aspects.js";

export interface ComponentScores {
  lexical: number | null;
  semantic: number | null;
  aspect: number | null;
  context: number;
  specificity: number;
  provenance: number;
  freshness: number;
  social: number;
  redundancy: number;
}

export interface ScoredCandidate {
  id: string;
  record: OpinionRecord;
  raw: RawCandidate;
  channel: Channel;
  components: ComponentScores;
  relevanceScore: number;
  finalScore: number;
  isRelevant: boolean;
  relevanceReason: string;
  matchedKeywords: string[];
  matchedAspects: string[];
  aspectPolarity: { aspect: string; polarity: PolarityLabel }[];
  explanation: string[];
}
