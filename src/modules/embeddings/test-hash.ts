import { contentStems } from "../../shared/text.js";
import type { EmbeddingProvider } from "./provider.js";

export class TestHashEmbeddingProvider implements EmbeddingProvider {
  readonly kind = "test-only" as const;
  readonly modelKey: string = "test-hash-v1";
  readonly dimensions = 64;
  readonly description = "TEST-ONLY feature-hashing vectors (not semantic)";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const s of contentStems(t)) {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
        v[Math.abs(h) % this.dimensions]! += 1;
      }
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      if (n === 0) v[0] = 1;
      else for (let i = 0; i < v.length; i++) v[i]! /= n;
      return v;
    });
  }
}
