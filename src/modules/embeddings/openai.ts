import { ProviderError } from "../../shared/errors.js";
import type { EmbeddingProvider } from "./provider.js";

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly kind = "neural-api" as const;
  readonly modelKey: string;
  readonly description: string;
  dimensions: number;
  private static readonly BATCH = 64;

  constructor(private opts: { apiKey: string; baseUrl: string; model: string; dimensions?: number }) {
    this.modelKey = `openai-compat:${opts.model}${opts.dimensions ? `@${opts.dimensions}` : ""}`;
    this.dimensions = opts.dimensions ?? 0;
    this.description = `OpenAI-compatible embeddings (${opts.model}) at ${opts.baseUrl}`;
  }

  async embed(texts: string[], { timeoutMs }: { inputType: "query" | "document"; timeoutMs: number }): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += OpenAiEmbeddingProvider.BATCH) {
      const batch = texts.slice(i, i + OpenAiEmbeddingProvider.BATCH);
      let res: Response;
      try {
        res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({ model: this.opts.model, input: batch, ...(this.opts.dimensions ? { dimensions: this.opts.dimensions } : {}) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new ProviderError("embeddings:openai", (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (err as Error).message, err);
      }
      if (!res.ok) throw new ProviderError("embeddings:openai", `HTTP ${res.status}`);
      const json: any = await res.json();
      const data: { index: number; embedding: number[] }[] = json?.data;
      if (!Array.isArray(data) || data.length !== batch.length) throw new ProviderError("embeddings:openai", "unexpected response shape (data length mismatch)");
      data.sort((a, b) => a.index - b.index);
      for (const d of data) {
        if (!Array.isArray(d.embedding) || d.embedding.length === 0) throw new ProviderError("embeddings:openai", "empty embedding in response");
        if (this.dimensions && d.embedding.length !== this.dimensions) throw new ProviderError("embeddings:openai", `dimension changed: expected ${this.dimensions}, got ${d.embedding.length}`);
        this.dimensions = d.embedding.length;
        out.push(d.embedding);
      }
    }
    return out;
  }
}
