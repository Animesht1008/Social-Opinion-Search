import "dotenv/config";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { applyMigrations } from "../scripts/apply-migrations.js";
import { createPrisma } from "../src/db/client.js";
import { seedDatabase } from "../src/db/seed.js";
import { upsertEmbedding } from "../src/db/embeddings-store.js";
import { TestHashEmbeddingProvider } from "../src/modules/embeddings/test-hash.js";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
    dbAvailable: boolean;
  }
}

/**
 * Prepares an isolated test database: fresh schema -> migrations -> deterministic seed -> TEST-ONLY hash embeddings
 * (so vector storage / pgvector queries / hybrid merging can be tested offline). If PostgreSQL is unreachable,
 * integration tests are skipped LOUDLY (see the console message) rather than silently passing.
 */
export default async function setup(project: TestProject) {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://sos:sos_dev_password@localhost:5432/social_opinion_test";
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName) || url === process.env.DATABASE_URL) {
    throw new Error(`Refusing to run tests: TEST_DATABASE_URL must point at a dedicated database whose name contains "test" and differs from DATABASE_URL (the test run DROPS the public schema). Got "${dbName}".`);
  }
  project.provide("dbUrl", url);
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } catch (err) {
    console.warn(`\n⚠ INTEGRATION TESTS SKIPPED: cannot reach the test database (${(err as Error).message}).\n  Start PostgreSQL with pgvector (docker compose up -d) and create ${url}.\n`);
    project.provide("dbAvailable", false);
    return;
  } finally {
    await client.end().catch(() => {});
  }
  await applyMigrations(url);
  const db = createPrisma(url);
  try {
    await seedDatabase(db, "data", { demoLogins: { password: "test-demo-password-1", log2N: 10 } });
    const p = new TestHashEmbeddingProvider();
    const rows = await db.opinion.findMany({ select: { id: true, text: true } });
    const vecs = await p.embed(rows.map((r) => r.text));
    for (let i = 0; i < rows.length; i++) await upsertEmbedding(db, rows[i]!.id, p.modelKey, vecs[i]!);
  } finally {
    await db.$disconnect();
  }
  project.provide("dbAvailable", true);
}
