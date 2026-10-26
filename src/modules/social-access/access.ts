import { Prisma, type Db } from "../../db/client.js";
import type { AppConfig } from "../../config/env.js";

export interface InnerCircleRule {
  types: string[];
  minCloseness: number;
}

export interface AccessContext {
  requesterId: string;
  connectionIds: string[];
  innerCircleIds: string[];
  blockedIds: string[];
  closeness: Record<string, number>;
  hiddenSources: string[];
}

export type Visibility = "PUBLIC" | "CONNECTIONS" | "INNER_CIRCLE" | "PRIVATE";
export type Channel = "inner_circle" | "wider_social";

export const innerCircleRule = (cfg: Pick<AppConfig, "INNER_CIRCLE_TYPES" | "INNER_CIRCLE_MIN_CLOSENESS">): InnerCircleRule => ({
  types: cfg.INNER_CIRCLE_TYPES,
  minCloseness: cfg.INNER_CIRCLE_MIN_CLOSENESS,
});

export function isInnerCircle(rel: { status: string; type: string; closeness: number }, rule: InnerCircleRule): boolean {
  return rel.status === "ACCEPTED" && rule.types.includes(rel.type) && rel.closeness >= rule.minCloseness;
}

export function buildAccessContext(
  requesterId: string,
  rels: { requesterId: string; addresseeId: string; status: string; type: string; closeness: number }[],
  rule: InnerCircleRule,
  hiddenSources: string[] = [],
): AccessContext {
  const connections = new Set<string>();
  const inner = new Set<string>();
  const blocked = new Set<string>();
  const closeness: Record<string, number> = {};
  for (const r of rels) {
    const other = r.requesterId === requesterId ? r.addresseeId : r.requesterId;
    if (other === requesterId) continue;
    if (r.status === "BLOCKED") blocked.add(other);
    else if (r.status === "ACCEPTED") {
      connections.add(other);
      closeness[other] = r.closeness;
      if (isInnerCircle(r, rule)) inner.add(other);
    } // PENDING grants nothing
  }
  for (const b of blocked) {
    connections.delete(b);
    inner.delete(b);
  }
  for (const id of Object.keys(closeness)) if (!connections.has(id)) delete closeness[id];
  return { requesterId, connectionIds: [...connections].sort(), innerCircleIds: [...inner].sort(), blockedIds: [...blocked].sort(), closeness, hiddenSources: [...hiddenSources].sort() };
}

export async function loadAccessContext(db: Db, requesterId: string, rule: InnerCircleRule, hiddenSources: string[] = []): Promise<AccessContext> {
  const rels = await db.relationship.findMany({
    where: { OR: [{ requesterId }, { addresseeId: requesterId }] },
    select: { requesterId: true, addresseeId: true, status: true, type: true, closeness: true },
  });
  return buildAccessContext(requesterId, rels, rule, hiddenSources);
}

export function canViewOpinion(ctx: AccessContext, o: { authorId: string; visibility: Visibility; provenanceSource?: string }): boolean {
  if (o.authorId === ctx.requesterId) return false; // own opinions are not "social" evidence for yourself
  if (o.provenanceSource && ctx.hiddenSources.includes(o.provenanceSource)) return false; // restricted dataset: not displayable under this policy
  if (ctx.blockedIds.includes(o.authorId)) return false;
  switch (o.visibility) {
    case "PUBLIC":
      return true;
    case "CONNECTIONS":
      return ctx.connectionIds.includes(o.authorId);
    case "INNER_CIRCLE":
      return ctx.innerCircleIds.includes(o.authorId);
    case "PRIVATE":
      return false;
  }
}

export function channelOf(ctx: AccessContext, authorId: string): Channel {
  return ctx.innerCircleIds.includes(authorId) ? "inner_circle" : "wider_social";
}

export function authorizationSql(ctx: AccessContext, alias = "o"): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(
    ${a}.author_id <> ${ctx.requesterId}
    AND NOT (${a}.author_id = ANY(${ctx.blockedIds}::text[]))
    AND NOT (${a}.provenance_source = ANY(${ctx.hiddenSources}::text[]))
    AND (
      ${a}.visibility = 'PUBLIC'
      OR (${a}.visibility = 'CONNECTIONS' AND ${a}.author_id = ANY(${ctx.connectionIds}::text[]))
      OR (${a}.visibility = 'INNER_CIRCLE' AND ${a}.author_id = ANY(${ctx.innerCircleIds}::text[]))
    )
  )`;
}

export function assertAuthorized<T extends { id: string; authorId: string; visibility: Visibility; provenanceSource?: string }>(ctx: AccessContext, records: T[]): T[] {
  for (const r of records) {
    if (!canViewOpinion(ctx, r)) throw new Error(`Authorization invariant violated for opinion ${r.id}`);
  }
  return records;
}
