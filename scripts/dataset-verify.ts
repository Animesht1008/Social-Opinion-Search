import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { createContext } from "../src/context.js";
import { Prisma } from "../src/db/client.js";
import { scrubPii } from "../src/modules/datasets/clean.js";
import { runSearch, SearchRequestSchema } from "../src/modules/search/search-service.js";
import { excerpt, round } from "../src/shared/text.js";
import { parseArgs } from "./_args.js";

const { values } = parseArgs(process.argv.slice(2));
const only = values.get("dataset")?.[0];
const ctx = await createContext(loadConfig());
const probes = JSON.parse(readFileSync("data/datasets/probe-queries.json", "utf8")) as { query: string }[];
try {
  const sources = (await ctx.db.dataSource.findMany({ where: { isSynthetic: false, id: { not: "user-generated" }, ...(only ? { id: only } : {}) }, orderBy: { id: "asc" } })).filter((s) => s.rowCount > 0 || only);
  if (!sources.length) console.log("No imported datasets found. Import one first (npm run dataset:import).");
  const probeUser = (await ctx.db.user.findFirst({ where: { id: "u_zoya" }, select: { id: true } }))?.id ?? (await ctx.db.user.findFirstOrThrow({ select: { id: true } })).id;
  for (const s of sources) {
    console.log(`\n================ ${s.id} — ${s.name}\nlicence: ${s.license}\nattribution: ${s.attribution}\ndisplayable to users in this environment: ${s.publicDisplayAllowed || ctx.config.DATASET_ALLOW_RESTRICTED === true || ctx.config.NODE_ENV !== "production"}`);
    const [{ n, cities, dmin, dmax, p5, p50, p95, dups }] = await ctx.db.$queryRaw<any[]>(Prisma.sql`
      SELECT count(*)::int n, count(DISTINCT city)::int cities, min(written_at) dmin, max(written_at) dmax,
             percentile_cont(0.05) WITHIN GROUP (ORDER BY length(text)) p5, percentile_cont(0.5) WITHIN GROUP (ORDER BY length(text)) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY length(text)) p95,
             (count(*) - count(DISTINCT lower(text)))::int dups
      FROM opinions WHERE provenance_source = ${s.id}`);
    console.log(`rows: ${n} | cities: ${cities} | dates: ${dmin?.toISOString().slice(0, 10)} … ${dmax?.toISOString().slice(0, 10)} | text length p5/p50/p95: ${Math.round(p5)}/${Math.round(p50)}/${Math.round(p95)} | exact-duplicate texts: ${dups}`);
    const byCity = await ctx.db.$queryRaw<{ city: string; n: number }[]>(Prisma.sql`SELECT city, count(*)::int n FROM opinions WHERE provenance_source = ${s.id} GROUP BY city ORDER BY n DESC LIMIT 8`);
    console.log("by city: " + byCity.map((c) => `${c.city} ${c.n}`).join(", "));
    const texts = await ctx.db.$queryRaw<{ text: string }[]>(Prisma.sql`SELECT text FROM opinions WHERE provenance_source = ${s.id}`);
    let pii = 0;
    for (const t of texts) { const m = scrubPii(t.text).masked; if (m.emails + m.urls + m.phones + m.handles > 0) pii++; }
    console.log(`rows still matching a PII pattern after import: ${pii} (expect 0; names in free text are NOT detected)`);
    const withAspect = ((await ctx.db.$queryRaw<{ withAspect: number }[]>(Prisma.sql`SELECT count(DISTINCT a.opinion_id)::int AS "withAspect" FROM opinion_aspects a JOIN opinions o ON o.id = a.opinion_id WHERE o.provenance_source = ${s.id} AND a.aspect <> 'late_night'`))[0]?.withAspect ?? 0);
    console.log(`rows with at least one recognised aspect: ${withAspect}/${n} (${round((100 * withAspect) / Math.max(1, n), 1)}%)`);
    if (ctx.embedding) {
      const e = ((await ctx.db.$queryRaw<{ e: number }[]>(Prisma.sql`SELECT count(*)::int e FROM opinion_embeddings x JOIN opinions o ON o.id = x.opinion_id WHERE o.provenance_source = ${s.id} AND x.model = ${ctx.embedding.modelKey}`))[0]?.e ?? 0);
      console.log(`embedded with ${ctx.embedding.modelKey}: ${e}/${n}`);
    } else console.log("embeddings: provider not configured (lexical retrieval only)");
    console.log("\nSpot-check (READ these; no relevance judgments exist for this data):");
    for (const p of probes) {
      const req = SearchRequestSchema.parse({ query: p.query, mode: ctx.embedding ? "hybrid" : "lexical", limit: 3, generateAnswer: false, includeWeb: false, filters: { dataSources: [s.id] } });
      try {
        const { response } = await runSearch(ctx, probeUser, req, { persist: false });
        console.log(`\n  Q: ${p.query}   [${response.retrieval.effectiveMode}, evidence: ${response.adequacy.status}]`);
        for (const c of response.selected.slice(0, 3)) console.log(`   - (${c.city}${c.neighborhood ? "/" + c.neighborhood : ""}, ${c.writtenAt.slice(0, 10)}) ${excerpt(c.text, 170)}`);
        if (!response.selected.length) console.log("   (no evidence)");
      } catch (err) { console.log(`  Q: ${p.query}\n   error: ${(err as Error).message}`); }
    }
  }
} finally {
  await ctx.close();
}
