import { allowRestrictedData, loadConfig, referenceNow, type AppConfig } from "./config/env.js";
import { NoLimiter, RateLimiter } from "./modules/auth/rate-limit.js";
import { createPrisma, type Db } from "./db/client.js";
import { countEmbeddings, countOpinions } from "./db/embeddings-store.js";
import { createEmbeddingProvider, embeddingStatusBase, type EmbeddingProvider, type EmbeddingStatus } from "./modules/embeddings/provider.js";
import { createLlmProvider, llmStatus, type LlmProvider } from "./modules/llm/provider.js";
import { createWebSearchProvider, type WebSearchProvider } from "./modules/web-search/provider.js";
import { DEFAULT_PARAMS, type RankingParams } from "./modules/ranking/config.js";
import { innerCircleRule, type InnerCircleRule } from "./modules/social-access/access.js";

export interface AppContext {
  config: AppConfig;
  db: Db;
  embedding: EmbeddingProvider | null;
  llm: LlmProvider | null;
  web: WebSearchProvider | null;
  params: RankingParams;
  circleRule: InnerCircleRule;
  limiters: Limiters;
  now(): Date;
  close(): Promise<void>;
}

export interface Limiters {
  loginIp: RateLimiter; // all login attempts per IP
  loginFail: RateLimiter; // failed attempts per (email, IP)
  registerIp: RateLimiter;
  search: RateLimiter; // per user
  write: RateLimiter; // per user (posting opinions, relationship changes)
}

export function createLimiters(c: AppConfig): Limiters {
  if (!c.RATE_LIMIT_ENABLED) return { loginIp: new NoLimiter(), loginFail: new NoLimiter(), registerIp: new NoLimiter(), search: new NoLimiter(), write: new NoLimiter() };
  const min = 60_000;
  return {
    loginIp: new RateLimiter(30, 15 * min),
    loginFail: new RateLimiter(5, 15 * min),
    registerIp: new RateLimiter(10, 60 * min),
    search: new RateLimiter(c.RATE_LIMIT_SEARCH_PER_MIN, min),
    write: new RateLimiter(c.RATE_LIMIT_WRITE_PER_MIN, min),
  };
}

/** Ids of data sources that must not be shown to other users under the current deployment policy. */
export async function hiddenDataSources(ctx: Pick<AppContext, "db" | "config">): Promise<string[]> {
  if (allowRestrictedData(ctx.config)) return [];
  const rows = await ctx.db.dataSource.findMany({ where: { publicDisplayAllowed: false }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function createContext(config: AppConfig = loadConfig(), overrides: Partial<Pick<AppContext, "embedding" | "llm" | "web" | "params">> = {}): Promise<AppContext> {
  const db = createPrisma(config.DATABASE_URL);
  const embedding = "embedding" in overrides ? (overrides.embedding ?? null) : await createEmbeddingProvider(config);
  // The semantic admission threshold depends on the embedding model; a-priori defaults per provider kind (tuned in docs/EVALUATION.md).
  const params = overrides.params ?? DEFAULT_PARAMS;
  return {
    config,
    db,
    embedding,
    llm: "llm" in overrides ? (overrides.llm ?? null) : createLlmProvider(config),
    web: "web" in overrides ? (overrides.web ?? null) : createWebSearchProvider(config),
    params,
    circleRule: innerCircleRule(config),
    limiters: createLimiters(config),
    now: () => referenceNow(config),
    close: () => db.$disconnect(),
  };
}

export async function getEmbeddingStatus(ctx: AppContext): Promise<EmbeddingStatus> {
  const base = embeddingStatusBase(ctx.embedding, ctx.config);
  const total = await countOpinions(ctx.db);
  if (!ctx.embedding) {
    return { ...base, semanticAvailable: false, indexedOpinions: 0, totalOpinions: total, reason: "EMBEDDING_PROVIDER=none: true embedding-based semantic retrieval is unavailable. Lexical retrieval still works." };
  }
  const indexed = await countEmbeddings(ctx.db, ctx.embedding.modelKey);
  if (indexed === 0)
    return { ...base, semanticAvailable: false, indexedOpinions: 0, totalOpinions: total, reason: `Provider configured but no vectors stored for ${ctx.embedding.modelKey}. Run \`npm run embeddings:index\`.` };
  const partial = indexed < total ? ` WARNING: only ${indexed}/${total} opinions are indexed; unindexed opinions are invisible to semantic retrieval.` : "";
  const kindNote = ctx.embedding.kind === "test-only" ? " TEST-ONLY provider: vectors are feature hashes, not semantic." : ctx.embedding.kind === "static-word-vectors" ? " Static (non-contextual) word-vector embeddings." : "";
  return { ...base, semanticAvailable: true, indexedOpinions: indexed, totalOpinions: total, reason: `Embeddings available (${ctx.embedding.modelKey}).${kindNote}${partial}` };
}

export function providerSummary(ctx: AppContext) {
  return { llm: llmStatus(ctx.config, ctx.llm), webSearch: { configured: !!ctx.web, provider: ctx.web?.id ?? "none" } };
}
