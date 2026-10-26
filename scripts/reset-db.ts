import "dotenv/config";
import pg from "pg";
import { applyMigrations } from "./apply-migrations.js";

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset a database in production.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await client.end();
console.log("Applied:", (await applyMigrations(url)).join(", "));
