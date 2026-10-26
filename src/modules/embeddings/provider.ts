import type { AppConfig } from "../../config/env.js";
import { ProviderError } from "../../shared/errors.js";
import { createGloveProvider } from "./glove.js";
import { OpenAiEmbeddingProvider } from "./openai.js";
import { TestHashEmbeddingProvider } from "./test-hash.js";

export type EmbeddingKind = "neural-api" | "static-word-vectors" | "test-only";

export interface EmbeddingProvider {
  readonly modelKey: string;
  readonly kind: EmbeddingKind;
  readonly dimensions: number;
  readonly description: string;
  embed(texts: string[], opts: { inputType: "query" | "document"; timeoutMs: number }): Promise<number[][]>;
}

export interface EmbeddingStatus {
  configured: boolean;
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
