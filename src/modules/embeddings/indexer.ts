import type { AppContext } from "../../context.js";
import { opinionsMissingEmbedding, upsertEmbedding } from "../../db/embeddings-store.js";

/** Embeds every opinion that has no vector for the configured model. Idempotent. Used by the CLI and by dataset import --embed. */
export async function indexMissingEmbeddings(ctx: AppContext, opts: { batch?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<{ done: number; failed: number; total: number }> {
  const p = ctx.embedding;
  if (!p) throw new Error("No embedding provider configured (EMBEDDING_PROVIDER=none).");
  const todo = await opinionsMissingEmbedding(ctx.db, p.modelKey);
  const batch = opts.batch ?? 32;
  let done = 0, failed = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    try {
      const vecs = await p.embed(chunk.map((c) => c.text), { inputType: "document", timeoutMs: ctx.config.PROVIDER_TIMEOUT_MS });
      for (let k = 0; k < chunk.length; k++) await upsertEmbedding(ctx.db, chunk[k]!.id, p.modelKey, vecs[k]!);
      done += chunk.length;
    } catch (err) {
      failed += chunk.length;
      console.error(`Batch starting at ${chunk[0]!.id} failed: ${(err as Error).message}`);
    }
    opts.onProgress?.(done + failed, todo.length);
  }
  return { done, failed, total: todo.length };
}
