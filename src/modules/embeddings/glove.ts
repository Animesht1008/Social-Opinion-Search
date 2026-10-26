import { existsSync, readFileSync } from "node:fs";
import { ProviderError } from "../../shared/errors.js";
import { tokenize } from "../../shared/text.js";
import type { EmbeddingProvider } from "./provider.js";

export const GLOVE_MAGIC = "SOSG1";

export class GloveEmbeddingProvider implements EmbeddingProvider {
  readonly kind = "static-word-vectors" as const;
  readonly dimensions: number;
  readonly modelKey: string;
  readonly description: string;
  private vectors = new Map<string, { v: Float32Array; weight: number }>();
  private common: Float32Array;

  constructor(buf: Buffer, label = "glove-wiki-gigaword") {
    if (buf.subarray(0, 5).toString("latin1") !== GLOVE_MAGIC) throw new ProviderError("embeddings:glove", "model file has wrong magic header; regenerate it with `npm run embeddings:glove`");
    this.dimensions = buf.readUInt32LE(5);
    const count = buf.readUInt32LE(9);
    this.modelKey = `${label}-${this.dimensions}@sif-v1`;
    this.description = `Averaged GloVe static word vectors (${this.dimensions}d, SIF-weighted, ${count} words) — static, non-contextual embeddings`;
    const a = 1e-3;
    let H = 0;
    for (let i = 1; i <= count; i++) H += 1 / i;
    let off = 13;
    const common = new Float32Array(this.dimensions);
    for (let i = 0; i < count; i++) {
      const len = buf.readUInt16LE(off);
      off += 2;
      const word = buf.toString("utf8", off, off + len);
      off += len;
      const v = new Float32Array(this.dimensions);
      for (let d = 0; d < this.dimensions; d++) v[d] = buf.readFloatLE(off + d * 4);
      off += this.dimensions * 4;
      const p = 1 / (i + 1) / H;
      this.vectors.set(word, { v, weight: a / (a + p) });
      for (let d = 0; d < this.dimensions; d++) common[d]! += p * v[d]!;
    }
    const n = Math.sqrt(common.reduce((s, x) => s + x * x, 0)) || 1;
    this.common = common.map((x) => x / n);
  }

  embedOne(text: string): number[] {
    const sum = new Float64Array(this.dimensions);
    let used = 0;
    for (const tok of tokenize(text)) {
      const e = this.vectors.get(tok);
      if (!e) continue;
      for (let d = 0; d < this.dimensions; d++) sum[d]! += e.weight * e.v[d]!;
      used++;
    }
    if (used === 0) throw new ProviderError("embeddings:glove", "text contains no words in the GloVe vocabulary; cannot embed");
    let dot = 0;
    for (let d = 0; d < this.dimensions; d++) {
      sum[d]! /= used;
      dot += sum[d]! * this.common[d]!;
    }
    let norm = 0;
    for (let d = 0; d < this.dimensions; d++) {
      sum[d]! -= dot * this.common[d]!;
      norm += sum[d]! * sum[d]!;
    }
    norm = Math.sqrt(norm) || 1;
    return Array.from(sum, (x) => x / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export function createGloveProvider(path: string): GloveEmbeddingProvider {
  if (!existsSync(path)) throw new ProviderError("embeddings:glove", `GloVe model file not found at ${path}. Run \`npm run embeddings:glove\` first (downloads ~70-130 MB from the public gensim-data GitHub release).`);
  return new GloveEmbeddingProvider(readFileSync(path));
}
