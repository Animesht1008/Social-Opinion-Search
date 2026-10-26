import type { Channel } from "../social-access/access.js";
import type { OpinionRecord, RawCandidate } from "../retrieval/types.js";
import type { PolarityLabel } from "../query-understanding/aspects.js";

export interface ComponentScores {
  /** ts_rank_cd (norm 32), null if no lexical match. */
  lexical: number | null;
  /** cosine similarity (clamped at 0 for scoring), null if unavailable. */
  semantic: number | null;
  /** fraction of the query's aspects mentioned by the opinion (lexicon-based, NOT semantic), null if the query has no aspects. */
  aspect: number | null;
  context: number;
  specificity: number;
  provenance: number;
  freshness: number;
  /** social-aware mode only: gated boost actually added to the score. */
  social: number;
  /** max similarity to a higher-ranked, selected opinion (set during selection; display only). */
  redundancy: number;
}

export interface ScoredCandidate {
  id: string;
  record: OpinionRecord;
  raw: RawCandidate;
  channel: Channel;
  components: ComponentScores;
  /** content + quality score before any social boost. */
  relevanceScore: number;
  finalScore: number;
  isRelevant: boolean;
  relevanceReason: string;
  matchedKeywords: string[];
  matchedAspects: string[];
  /** polarity per *query* aspect (rule-based, display/diversity only — never an automatic penalty). */
  aspectPolarity: { aspect: string; polarity: PolarityLabel }[];
  explanation: string[];
}
