import type { AppConfig } from "../../config/env.js";
import { ProviderError } from "../../shared/errors.js";
import { createGloveProvider } from "./glove.js";
import { OpenAiEmbeddingProvider } from "./openai.js";
import { TestHashEmbeddingProvider } from "./test-hash.js";

/**
 * kind:
 *  - "neural-api":          contextual embeddings from a hosted model (OpenAI-compatible endpoint)
 *  - "static-word-vectors": average of pretrained static word vectors (GloVe). Real learned embeddings, but weaker
 *                           than contextual sentence encoders — labelled as such everywhere.
 *  - "test-only":           deterministic feature hashing for unit tests. NOT semantic; never used for evaluation.
 */
export type EmbeddingKind = "neural-api" | "static-word-vectors" | "test-only";

export interface EmbeddingProvider {
  /** Stored with every vector so query and corpus embeddings are always compatible. */
  readonly modelKey: string;
  readonly kind: EmbeddingKind;
  readonly dimensions: number;
  readonly description: string;
  embed(texts: string[], opts: { inputType: "query" | "document"; timeoutMs: number }): Promise<number[][]>;
}

export interface EmbeddingStatus {
  configured: boolean;
  /** True only when a configured provider has indexed vectors for the current corpus. */
  semanticAvailable: boolean;
  provider: string;
  modelKey: string | null;
  kind: EmbeddingKind | null;
  dimensions: number | null;
  indexedOpinions: number;
  totalOpinions: number;
  reason: string;
}

export async function createEmbeddingProvider(cfg: AppConfig): Promise<EmbeddingProvider | null> {
  switch (cfg.EMBEDDING_PROVIDER) {
    case "none":
      return null;
    case "openai":
      return new OpenAiEmbeddingProvider({ apiKey: cfg.EMBEDDING_API_KEY!, baseUrl: cfg.EMBEDDING_BASE_URL, model: cfg.EMBEDDING_MODEL, dimensions: cfg.EMBEDDING_DIMENSIONS });
    case "local-glove":
      return createGloveProvider(cfg.GLOVE_MODEL_PATH);
    case "test-hash":
      return new TestHashEmbeddingProvider();
    default:
      throw new ProviderError("embeddings", `unknown provider ${String(cfg.EMBEDDING_PROVIDER)}`);
  }
}

export function embeddingStatusBase(p: EmbeddingProvider | null, cfg: AppConfig): Omit<EmbeddingStatus, "indexedOpinions" | "totalOpinions" | "semanticAvailable" | "reason"> {
  return p
    ? { configured: true, provider: cfg.EMBEDDING_PROVIDER, modelKey: p.modelKey, kind: p.kind, dimensions: p.dimensions }
    : { configured: false, provider: "none", modelKey: null, kind: null, dimensions: null };
}
