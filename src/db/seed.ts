import { readFileSync } from "node:fs";
import { Prisma, type Db } from "./client.js";
import { extractAspects } from "../modules/query-understanding/aspects.js";
import { hashPassword } from "../modules/auth/password.js";

const load = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

export const SEED_PROVENANCE = "synthetic-seed-v1";

export const DEMO_ACCOUNTS: { id: string; email: string }[] = [
  { id: "u_riya", email: "riya@gmail.com" },
  { id: "u_aman", email: "aman@gmail.com" },
  { id: "u_zoya", email: "zoya@gmail.com" },
];

export interface SeedOptions {
  /** If set, the three demo requesters get real sign-in accounts (scrypt-hashed password). Omit to seed without any login. */
  demoLogins?: { password: string; log2N?: number } | null;
}

export interface SeedSummary {
  users: number;
  relationships: number;
  places: number;
  opinions: number;
  aspects: number;
  evalQueries: number;
  judgments: number;
}

/**
 * Resets and reloads the synthetic demo corpus (idempotent). Every record is flagged is_synthetic and carries
 * provenance "synthetic-seed-v1". Embeddings are wiped with the corpus: re-run `npm run embeddings:index` afterwards.
 */
export async function seedDatabase(db: Db, dir = "data", opts: SeedOptions = {}): Promise<SeedSummary & { demoLogins: string[] }> {
  const users = load<{ id: string; displayName: string }[]>(`${dir}/seed/users.json`);
  const rels = load<any[]>(`${dir}/seed/relationships.json`);
  const places = load<any[]>(`${dir}/seed/places.json`);
  const opinions = load<any[]>(`${dir}/seed/opinions.json`);
  const queries = load<any[]>(`${dir}/eval/queries.json`);
  const judgments = load<Record<string, [string, number][]>>(`${dir}/eval/judgments.json`);
  const aspectLabels = load<{ labels: Record<string, string[]> }>(`${dir}/eval/aspect_labels.json`).labels;

  await db.$executeRaw(Prisma.sql`TRUNCATE TABLE users, places, search_runs RESTART IDENTITY CASCADE`);

  await db.user.createMany({ data: users.map((u) => ({ id: u.id, displayName: u.displayName, isSynthetic: true })) });
  const demoLogins: string[] = [];
  if (opts.demoLogins) {
    const passwordHash = await hashPassword(opts.demoLogins.password, opts.demoLogins.log2N ?? 15);
    for (const a of DEMO_ACCOUNTS) {
      await db.user.update({ where: { id: a.id }, data: { email: a.email, passwordHash } });
      demoLogins.push(a.email);
    }
  }
  // Imported datasets live in users/opinions that were just truncated; keep their provenance rows but reset the counters.
  await db.$executeRaw(Prisma.sql`UPDATE data_sources SET row_count = 0, imported_at = NULL WHERE NOT is_synthetic AND id <> 'user-generated'`);
  await db.relationship.createMany({
    data: rels.map((r) => ({ ...r, acceptedAt: r.status === "ACCEPTED" ? new Date("2026-01-01T00:00:00Z") : null })),
  });
  await db.place.createMany({ data: places.map((p) => ({ ...p, isSynthetic: true })) });

  // Insert originals first (reposts reference earlier rows), then link reposts.
  await db.opinion.createMany({
    data: opinions.map((o) => ({
      id: o.id, authorId: o.authorId, placeId: o.placeId, text: o.text, city: o.city, neighborhood: o.neighborhood,
      category: o.category, writtenAt: new Date(o.writtenAt), sourceType: o.sourceType, firsthand: o.firsthand,
      visibility: o.visibility, rating: o.rating, isSynthetic: true, provenanceSource: SEED_PROVENANCE,
      provenanceNote: "Synthetic illustrative opinion written for this project's demo; not a real person's review.",
    })),
  });
  for (const o of opinions.filter((x) => x.repostOfId)) await db.opinion.update({ where: { id: o.id }, data: { repostOfId: o.repostOfId } });

  // Derived aspects (rule-based extractor). Original text is never modified.
  const aspectRows = opinions.flatMap((o) =>
    extractAspects(o.text).map((a) => ({ opinionId: o.id as string, aspect: a.aspect, polarity: a.polarity, matchedTerms: a.matchedTerms, extractor: "lexicon-v1" })),
  );
  await db.opinionAspect.createMany({ data: aspectRows });

  await db.evalQuery.createMany({
    data: queries.map((q) => ({ id: q.id, query: q.query, requesterId: q.requesterId, tags: q.tags, hardConstraints: q.hardConstraints, expectedAspects: q.expectedAspects, expectInsufficient: q.expectInsufficient, notes: `split=${q.split}` })),
  });
  const jRows = Object.entries(judgments).flatMap(([qid, list]) => list.map(([opId, grade]) => ({ evalQueryId: qid, opinionId: opId, grade, aspects: aspectLabels[opId] ?? [] })));
  await db.evalJudgment.createMany({ data: jRows });

  return { demoLogins, users: users.length, relationships: rels.length, places: places.length, opinions: opinions.length, aspects: aspectRows.length, evalQueries: queries.length, judgments: jRows.length };
}
