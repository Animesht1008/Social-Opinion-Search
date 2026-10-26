import { Prisma, type Db } from "../../db/client.js";
import { authorizationSql, type AccessContext } from "../social-access/access.js";
import type { HardFilters } from "../query-understanding/intent.js";
import { toVectorLiteral } from "../../db/embeddings-store.js";
import type { OpinionRecord } from "./types.js";

export function filterSql(ctx: AccessContext, f: HardFilters, alias = "o"): Prisma.Sql {
  const a = Prisma.raw(alias);
  const parts: Prisma.Sql[] = [authorizationSql(ctx, alias)];
  if (f.city) parts.push(Prisma.sql`lower(${a}.city) = lower(${f.city})`);
  if (f.category) parts.push(Prisma.sql`${a}.category = ${f.category}`);
  if (f.since) parts.push(Prisma.sql`${a}.written_at >= ${f.since}::timestamp`);
  if (f.firsthandOnly) parts.push(Prisma.sql`${a}.firsthand = true`);
  if (f.sourceTypes?.length) parts.push(Prisma.sql`${a}.source_type::text = ANY(${f.sourceTypes}::text[])`);
  if (f.dataSources?.length) parts.push(Prisma.sql`${a}.provenance_source = ANY(${f.dataSources}::text[])`);
  if (f.channels?.length) {
    const wantInner = f.channels.includes("inner_circle");
    const wantWider = f.channels.includes("wider_social");
    if (wantInner && !wantWider) parts.push(Prisma.sql`${a}.author_id = ANY(${ctx.innerCircleIds}::text[])`);
    else if (wantWider && !wantInner) parts.push(Prisma.sql`NOT (${a}.author_id = ANY(${ctx.innerCircleIds}::text[]))`);
  }
  return Prisma.join(parts, " AND ");
}

export function buildTsQuery(keywords: string[]): string | null {
  const toks = [...new Set(keywords.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((k) => k.length >= 2))];
  return toks.length ? toks.join(" | ") : null;
}

export async function lexicalSearch(db: Db, ctx: AccessContext, f: HardFilters, tsQuery: string, limit: number): Promise<{ id: string; score: number }[]> {
  const rows = await db.$queryRaw<{ id: string; score: number }[]>(Prisma.sql`
    SELECT o.id, ts_rank_cd(o.search_vector, q.query, 32)::float8 AS score
    FROM opinions o, to_tsquery('english', ${tsQuery}) AS q(query)
    WHERE o.search_vector @@ q.query AND ${filterSql(ctx, f)}
    ORDER BY score DESC, o.id ASC
    LIMIT ${limit}`);
  return rows;
}

export async function semanticSearch(db: Db, ctx: AccessContext, f: HardFilters, modelKey: string, queryVec: number[], limit: number): Promise<{ id: string; score: number }[]> {
  const lit = toVectorLiteral(queryVec);
  return db.$queryRaw<{ id: string; score: number }[]>(Prisma.sql`
    SELECT o.id, (1 - (e.embedding <=> ${lit}::vector))::float8 AS score
    FROM opinion_embeddings e JOIN opinions o ON o.id = e.opinion_id
    WHERE e.model = ${modelKey} AND ${filterSql(ctx, f)}
    ORDER BY e.embedding <=> ${lit}::vector ASC, o.id ASC
    LIMIT ${limit}`);
}

export async function lexicalScoresFor(db: Db, ctx: AccessContext, f: HardFilters, tsQuery: string, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<{ id: string; score: number }[]>(Prisma.sql`
    SELECT o.id, ts_rank_cd(o.search_vector, q.query, 32)::float8 AS score
    FROM opinions o, to_tsquery('english', ${tsQuery}) AS q(query)
    WHERE o.id = ANY(${ids}::text[]) AND o.search_vector @@ q.query AND ${filterSql(ctx, f)}`);
  return new Map(rows.map((r) => [r.id, r.score]));
}

export async function semanticScoresFor(db: Db, ctx: AccessContext, f: HardFilters, modelKey: string, queryVec: number[], ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const lit = toVectorLiteral(queryVec);
  const rows = await db.$queryRaw<{ id: string; score: number }[]>(Prisma.sql`
    SELECT o.id, (1 - (e.embedding <=> ${lit}::vector))::float8 AS score
    FROM opinion_embeddings e JOIN opinions o ON o.id = e.opinion_id
    WHERE e.model = ${modelKey} AND o.id = ANY(${ids}::text[]) AND ${filterSql(ctx, f)}`);
  return new Map(rows.map((r) => [r.id, r.score]));
}

export async function fetchOpinions(db: Db, ctx: AccessContext, ids: string[]): Promise<OpinionRecord[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<any[]>(Prisma.sql`
    SELECT o.id, o.author_id, u.display_name AS author_name, p.name AS place_name, o.text, o.city, o.neighborhood, o.category,
           o.written_at, o.source_type::text AS source_type, o.firsthand, o.visibility::text AS visibility, o.rating,
           o.provenance_source, o.provenance_note, o.repost_of_id, o.is_synthetic,
           ds.name AS ds_name, ds.license AS ds_license, ds.url AS ds_url, ds.attribution AS ds_attribution,
           ds.commercial_use_allowed AS ds_commercial, ds.is_synthetic AS ds_synthetic
    FROM opinions o JOIN users u ON u.id = o.author_id JOIN data_sources ds ON ds.id = o.provenance_source LEFT JOIN places p ON p.id = o.place_id
    WHERE o.id = ANY(${ids}::text[]) AND ${authorizationSql(ctx)}`);
  const asp = await db.$queryRaw<{ opinion_id: string; aspect: string; polarity: string; matched_terms: string[] }[]>(Prisma.sql`
    SELECT a.opinion_id, a.aspect, a.polarity::text AS polarity, a.matched_terms
    FROM opinion_aspects a WHERE a.opinion_id = ANY(${ids}::text[]) AND a.extractor = 'lexicon-v1'`);
  const byOp = new Map<string, OpinionRecord["aspects"]>();
  for (const a of asp) {
    const list = byOp.get(a.opinion_id) ?? [];
    list.push({ aspect: a.aspect, polarity: a.polarity as any, matchedTerms: a.matched_terms ?? [] });
    byOp.set(a.opinion_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_name,
    placeName: r.place_name,
    text: r.text,
    city: r.city,
    neighborhood: r.neighborhood,
    category: r.category,
    writtenAt: r.written_at instanceof Date ? r.written_at : new Date(r.written_at + "Z"),
    sourceType: r.source_type,
    firsthand: r.firsthand,
    visibility: r.visibility,
    rating: r.rating,
    provenanceSource: r.provenance_source,
    provenanceNote: r.provenance_note,
    repostOfId: r.repost_of_id,
    isSynthetic: r.is_synthetic,
    dataSource: { id: r.provenance_source, name: r.ds_name, license: r.ds_license, url: r.ds_url, attribution: r.ds_attribution, commercialUseAllowed: r.ds_commercial, isSynthetic: r.ds_synthetic },
    aspects: (byOp.get(r.id) ?? []).sort((x, y) => x.aspect.localeCompare(y.aspect)),
  }));
}

export async function knownLocations(db: Db): Promise<{ cities: string[]; neighborhoods: Record<string, string[]> }> {
  const rows = await db.$queryRaw<{ city: string; neighborhood: string | null }[]>(Prisma.sql`SELECT DISTINCT city, neighborhood FROM opinions`);
  const cities = [...new Set(rows.map((r) => r.city))].sort();
  const neighborhoods: Record<string, string[]> = {};
  for (const r of rows) if (r.neighborhood) (neighborhoods[r.city] ??= []).includes(r.neighborhood) || neighborhoods[r.city]!.push(r.neighborhood);
  return { cities, neighborhoods };
}
