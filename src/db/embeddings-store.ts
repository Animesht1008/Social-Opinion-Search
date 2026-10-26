import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "./client.js";

/** pgvector text literal: '[0.1,0.2,...]' */
export function toVectorLiteral(v: ArrayLike<number>): string {
  const parts: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    if (!Number.isFinite(x)) throw new Error("Embedding contains a non-finite value");
    parts.push(String(Math.round(x * 1e7) / 1e7));
  }
  return `[${parts.join(",")}]`;
}

export async function upsertEmbedding(db: Db, opinionId: string, model: string, vector: ArrayLike<number>): Promise<void> {
  const literal = toVectorLiteral(vector);
  await db.$executeRaw`
    INSERT INTO opinion_embeddings (opinion_id, model, dim, embedding)
    VALUES (${opinionId}, ${model}, ${vector.length}, ${literal}::vector)
    ON CONFLICT (opinion_id, model) DO UPDATE SET dim = EXCLUDED.dim, embedding = EXCLUDED.embedding, created_at = now()`;
}

export async function countEmbeddings(db: Db, model: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM opinion_embeddings WHERE model = ${model}`);
  return rows[0]?.n ?? 0;
}

export async function countOpinions(db: Db): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM opinions`);
  return rows[0]?.n ?? 0;
}

export async function opinionsMissingEmbedding(db: Db, model: string): Promise<{ id: string; text: string }[]> {
  return db.$queryRaw<{ id: string; text: string }[]>(Prisma.sql`
    SELECT o.id, o.text FROM opinions o
    WHERE NOT EXISTS (SELECT 1 FROM opinion_embeddings e WHERE e.opinion_id = o.id AND e.model = ${model})
    ORDER BY o.id`);
}
