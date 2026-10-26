import type { Channel, Visibility } from "../social-access/access.js";
import type { PolarityLabel } from "../query-understanding/aspects.js";

export type RetrievalMode = "lexical" | "semantic" | "hybrid";
export type RankingMode = "relevance_first" | "social_aware";

export interface OpinionRecord {
  id: string;
  authorId: string;
  authorName: string;
  placeName: string | null;
  text: string;
  city: string;
  neighborhood: string | null;
  category: string;
  writtenAt: Date;
  sourceType: "SOCIAL_USER" | "PUBLIC_REVIEW";
  firsthand: boolean;
  visibility: Visibility;
  rating: number | null;
  provenanceSource: string;
  provenanceNote: string | null;
  repostOfId: string | null;
  isSynthetic: boolean;
  dataSource: { id: string; name: string; license: string; url: string | null; attribution: string | null; commercialUseAllowed: boolean; isSynthetic: boolean };
  aspects: { aspect: string; polarity: PolarityLabel; matchedTerms: string[] }[];
}

export interface RawCandidate {
  id: string;
  /** ts_rank_cd with normalization 32 (rank/(rank+1)) in [0,1); null if the opinion did not match lexically. */
  lexical: number | null;
  /** cosine similarity in [-1,1]; null if no embedding for the active model. */
  semantic: number | null;
  lexicalRank: number | null;
  semanticRank: number | null;
  foundBy: ("lexical" | "semantic")[];
}

export interface RetrievalResult {
  requestedMode: RetrievalMode;
  effectiveMode: RetrievalMode;
  candidates: RawCandidate[];
  fallback: { from: RetrievalMode; to: RetrievalMode; reason: string } | null;
  lexicalQuery: string | null;
  timingsMs: { lexical: number; semantic: number; embed: number; hydrate: number };
  warnings: string[];
}

export type { Channel };
