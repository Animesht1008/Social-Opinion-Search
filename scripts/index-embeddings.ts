/** Embeds every opinion that has no vector for the configured model. Idempotent; safe to re-run. */
import { loadConfig } from "../src/config/env.js";
import { createContext } from "../src/context.js";
import { countEmbeddings, countOpinions } from "../src/db/embeddings-store.js";
import { indexMissingEmbeddings } from "../src/modules/embeddings/indexer.js";

const config = loadConfig();
const ctx = await createContext(config);
try {
  if (!ctx.embedding) {
    console.error("EMBEDDING_PROVIDER=none: nothing to index. Set EMBEDDING_PROVIDER to openai or local-glove (see .env.example).");
    process.exit(1);
  }
  const p = ctx.embedding;
  console.log(`Provider: ${p.description}\nModel key: ${p.modelKey} (${p.kind})`);
  const r = await indexMissingEmbeddings(ctx, { onProgress: (d, t) => { if (t > 200 && d % 640 === 0) console.log(`  ${d}/${t}`); } });
  console.log(`Indexed ${r.done} new, ${r.failed} failed. Now ${await countEmbeddings(ctx.db, p.modelKey)}/${await countOpinions(ctx.db)} opinions have ${p.modelKey} vectors.`);
  if (r.failed) process.exitCode = 1;
} finally {
  await ctx.close();
}
