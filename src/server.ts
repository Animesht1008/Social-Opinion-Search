import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/env.js";
import { createContext, getEmbeddingStatus } from "./context.js";
import { Prisma } from "./db/client.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message + "\n\nCopy .env.example to .env and adjust it.");
      process.exit(1);
    }
    throw err;
  }
  let ctx;
  try {
    ctx = await createContext(config);
  } catch (err) {
    console.error(`Failed to initialise providers: ${(err as Error).message}`);
    process.exit(1);
  }
  try {
    const r = await ctx.db.$queryRaw<{ e: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS e`);
    if (!r[0]?.e) console.warn("WARNING: pgvector extension is not installed in this database; semantic retrieval will fail.");
    await ctx.db.user.count();
  } catch (err) {
    console.error(`Cannot reach the database or schema is missing: ${(err as Error).message}\nStart PostgreSQL (docker compose up -d), then run: npm run db:migrate && npm run db:seed`);
    process.exit(1);
  }
  const emb = await getEmbeddingStatus(ctx);
  const app = await buildApp(ctx, { logger: config.NODE_ENV !== "test" });
  await app.listen({ port: config.PORT, host: config.HOST });
  console.log(`\nSocial Opinion Search on http://${config.HOST}:${config.PORT}`);
  console.log(`  embeddings : ${emb.semanticAvailable ? "AVAILABLE" : "UNAVAILABLE"} — ${emb.reason}`);
  console.log(`  LLM        : ${ctx.llm ? ctx.llm.id : "none (deterministic summaries)"}`);
  console.log(`  web search : ${ctx.web ? ctx.web.id : "none"}`);
  const shutdown = async () => {
    await app.close();
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
