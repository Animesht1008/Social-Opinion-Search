import "dotenv/config";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export async function applyMigrations(url: string, dir = "prisma/migrations"): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _sos_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM _sos_migrations")).rows.map((r) => r.name));
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "migration.sql")))
      .map((d) => d.name)
      .sort();
    for (const name of names) {
      if (done.has(name)) continue;
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _sos_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (copy .env.example to .env).");
    process.exit(1);
  }
  applyMigrations(url)
    .then((a) => console.log(a.length ? `Applied: ${a.join(", ")}` : "No pending migrations."))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
