import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getEmbeddingStatus, hiddenDataSources, providerSummary, type AppContext } from "../context.js";
import { Prisma } from "../db/client.js";
import { runEvaluation } from "../modules/evaluation/runner.js";
import { runSearch, SearchRequestSchema } from "../modules/search/search-service.js";
import { authorizationSql, loadAccessContext } from "../modules/social-access/access.js";
import { AppError } from "../shared/errors.js";
import { requireUser } from "./auth.js";
import { registerSocialRoutes } from "./social.js";

const OpinionsQuery = z.object({
  city: z.string().max(80).optional(),
  category: z.string().max(40).optional(),
  source: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(64).optional(),
});

export async function registerRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/health", async () => {
    let db = "ok";
    let pgvector = false;
    try {
      const r = await ctx.db.$queryRaw<{ e: boolean }[]>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS e`);
      pgvector = r[0]?.e ?? false;
    } catch {
      db = "unreachable";
    }
    const embedding = db === "ok" ? await getEmbeddingStatus(ctx) : null;
    return { status: db === "ok" ? "ok" : "degraded", database: db, pgvector, time: ctx.now().toISOString(), providers: { embedding, ...providerSummary(ctx) } };
  });

  app.get("/api/v1/me/access", async (req) => {
    const id = await requireUser(ctx, req);
    const a = await loadAccessContext(ctx.db, id, ctx.circleRule, await hiddenDataSources(ctx));
    return { requesterId: id, innerCircleDefinition: { types: ctx.circleRule.types, minCloseness: ctx.circleRule.minCloseness, requires: "ACCEPTED relationship" }, connectionIds: a.connectionIds, innerCircleIds: a.innerCircleIds };
  });

  app.post("/api/v1/search", async (req) => {
    const id = await requireUser(ctx, req);
    const rl = ctx.limiters.search.hit(id);
    if (!rl.allowed) throw new AppError("RATE_LIMITED", "Too many searches. Try again shortly.", 429, { retryAfterSeconds: rl.retryAfterSeconds });
    const body = SearchRequestSchema.parse(req.body ?? {});
    const { response } = await runSearch(ctx, id, body);
    return response;
  });

  app.get("/api/v1/opinions", async (req) => {
    const id = await requireUser(ctx, req);
    const q = OpinionsQuery.parse(req.query);
    const access = await loadAccessContext(ctx.db, id, ctx.circleRule, await hiddenDataSources(ctx));
    const conds: Prisma.Sql[] = [authorizationSql(access)];
    if (q.city) conds.push(Prisma.sql`lower(o.city) = lower(${q.city})`);
    if (q.category) conds.push(Prisma.sql`o.category = ${q.category}`);
    if (q.source) conds.push(Prisma.sql`o.provenance_source = ${q.source}`);
    if (q.cursor) conds.push(Prisma.sql`o.id > ${q.cursor}`);
    const rows = await ctx.db.$queryRaw<any[]>(Prisma.sql`
      SELECT o.id, o.author_id, u.display_name AS author_name, o.text, o.city, o.neighborhood, o.category, o.written_at,
             o.source_type::text AS source_type, o.firsthand, o.visibility::text AS visibility, o.rating, o.is_synthetic, o.provenance_source
      FROM opinions o JOIN users u ON u.id = o.author_id
      WHERE ${Prisma.join(conds, " AND ")} ORDER BY o.id ASC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    return {
      opinions: page.map((r) => ({ id: r.id, authorId: r.author_id, authorName: r.author_name, text: r.text, city: r.city, neighborhood: r.neighborhood, category: r.category, writtenAt: r.written_at, sourceType: r.source_type, firsthand: r.firsthand, visibility: r.visibility, rating: r.rating, isSynthetic: r.is_synthetic, dataSourceId: r.provenance_source, channel: access.innerCircleIds.includes(r.author_id) ? "inner_circle" : "wider_social" })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/search-runs/:id", async (req) => {
    const uid = await requireUser(ctx, req);
    const idParsed = z.string().uuid().safeParse(req.params.id);
    if (!idParsed.success) throw new AppError("VALIDATION_ERROR", "run id must be a UUID", 400);
    const run = await ctx.db.searchRun.findUnique({ where: { id: idParsed.data } });
    if (!run || run.userId !== uid) throw new AppError("NOT_FOUND", "Search run not found", 404);
    return {
      id: run.id,
      query: run.query,
      intent: run.intent,
      retrievalMode: run.retrievalMode,
      rankingMode: run.rankingMode,
      effectiveMode: run.effectiveMode,
      selectedIds: run.selectedIds,
      candidates: run.candidates,
      providerStatus: run.providerStatus,
      warnings: run.warnings,
      latencyMs: run.latencyMs,
      createdAt: run.createdAt,
      note: "Run logs store opinion ids and scores only. Use GET /api/v1/opinions or re-run the search to read authorized text.",
    };
  });

  app.get("/api/v1/evaluation/summary", async (req) => {
    await requireUser(ctx, req); // benchmark internals are for signed-in users only
    const run = await ctx.db.evaluationRun.findFirst({ orderBy: { createdAt: "desc" } });
    if (!run) throw new AppError("NO_EVALUATION", "No evaluation has been run yet. Run `npm run eval` first.", 404);
    return { id: run.id, createdAt: run.createdAt, config: run.config, summary: run.summary, perQuery: run.perQuery };
  });

  app.get("/api/v1/data-sources", async () => {
    const hidden = new Set(await hiddenDataSources(ctx));
    const sources = await ctx.db.dataSource.findMany({ orderBy: { id: "asc" } });
    const counts = await ctx.db.opinion.groupBy({ by: ["provenanceSource"], _count: { _all: true }, _min: { writtenAt: true }, _max: { writtenAt: true } });
    const byId = new Map(counts.map((c) => [c.provenanceSource, c]));
    return {
      policy: { restrictedSourcesVisible: hidden.size === 0 },
      sources: sources.map((s) => ({
        id: s.id, name: s.name, description: s.description, url: s.url, license: s.license, licenseUrl: s.licenseUrl, attribution: s.attribution, geography: s.geography,
        isSynthetic: s.isSynthetic, commercialUseAllowed: s.commercialUseAllowed, publicDisplayAllowed: s.publicDisplayAllowed, displayable: !hidden.has(s.id), limitations: s.limitations,
        opinionCount: byId.get(s.id)?._count._all ?? 0, firstOpinionAt: byId.get(s.id)?._min.writtenAt ?? s.dateFrom, lastOpinionAt: byId.get(s.id)?._max.writtenAt ?? s.dateTo, importedAt: s.importedAt,
      })),
    };
  });

  await registerSocialRoutes(app, ctx);

  const devEnabled = ctx.config.ENABLE_DEV_ENDPOINTS && ctx.config.NODE_ENV !== "production";
  app.post("/api/v1/evaluation/run", async () => {
    if (!devEnabled) throw new AppError("NOT_FOUND", "Not found", 404);
    const result = await runEvaluation(ctx, { persist: true });
    return { id: result.id, summary: result.summary };
  });
}
