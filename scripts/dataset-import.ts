/**
 * Import a public dataset you have downloaded yourself. Nothing is downloaded or bundled by this project.
 *
 *   npm run dataset:list
 *   npm run dataset:import -- --dataset tripadvisor-dyadic-2022 --file path/to/city.csv [--file ...] --accept-license CC-BY-NC-4.0 [--limit 5000] [--sample 0.2] [--only-cities "London,Delhi"] [--embed] [--dry-run] [--append]
 *   npm run dataset:import -- --dataset inside-airbnb --file reviews.csv --listings listings.csv --city "Lisbon" --accept-license INSIDE-AIRBNB-POLICY
 *   npm run dataset:import -- --dataset generic --meta my-source.json --file data.csv --map text=Review,date=Date,city=City,category=const:restaurant --accept-license <licenseId from your meta file>
 *   npm run dataset:remove -- --dataset <id>
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { createContext } from "../src/context.js";
import { AdapterError, parseMap } from "../src/modules/datasets/adapters.js";
import { importDataset, LicenseNotAccepted, removeDataset, upsertSource } from "../src/modules/datasets/importer.js";
import { findSource, REGISTRY, SourceMetaSchema, type SourceMeta } from "../src/modules/datasets/registry.js";
import { indexMissingEmbeddings } from "../src/modules/embeddings/indexer.js";
import { parseArgs } from "./_args.js";

const rest: string[] = [];
const { flags, values } = parseArgs(process.argv.slice(2));
const one = (k: string) => values.get(k)?.[0];
const cfg = loadConfig();
const ctx = await createContext(cfg);

function resolveMeta(): SourceMeta {
  const id = one("dataset");
  if (!id) throw new AdapterError("Pass --dataset <id> (see `npm run dataset:list`).");
  if (id === "generic") {
    const p = one("meta");
    if (!p) throw new AdapterError("--dataset generic needs --meta <json file> with id, shortCode, name, url, license, licenseId, attribution, commercialUseAllowed, publicDisplayAllowed, limitations.");
    return SourceMetaSchema.parse({ ...JSON.parse(readFileSync(p, "utf8")), adapter: "generic-csv" });
  }
  const m = findSource(id);
  if (!m) throw new AdapterError(`Unknown dataset "${id}". Known: ${REGISTRY.map((s) => s.id).join(", ")}, generic`);
  return m;
}

try {
  if (process.argv[2] === "list") {
    const rows = await ctx.db.dataSource.findMany({ orderBy: { id: "asc" } });
    console.log("Registered sources (no data is bundled — you download it yourself):\n");
    for (const s of REGISTRY) {
      const db = rows.find((r) => r.id === s.id);
      console.log(`• ${s.id}\n  ${s.name}\n  ${s.url}\n  licence: ${s.license}  | commercial use: ${s.commercialUseAllowed ? "yes" : "NO"} | public display: ${s.publicDisplayAllowed ? "yes" : "NO (hidden in production)"}\n  imported rows: ${db?.rowCount ?? 0}${db?.importedAt ? ` (at ${db.importedAt.toISOString()})` : ""}\n`);
    }
    console.log("Also: --dataset generic --meta <file.json> for any CSV you are licensed to use.");
  } else if (process.argv[2] === "remove") {
    const meta = resolveMeta();
    const n = await removeDataset(ctx.db, meta);
    console.log(`Removed ${n} pseudonymous author(s) and their opinions for ${meta.id}.`);
  } else {
    const meta = resolveMeta();
    const files = values.get("file") ?? [];
    if (!files.length) throw new AdapterError("Pass at least one --file <csv>.");
    const sample = one("sample") ? Number(one("sample")) : undefined;
    const limit = one("limit") ? Number(one("limit")) : undefined;
    console.log(`Importing "${meta.name}"\n  licence: ${meta.license}\n  attribution: ${meta.attribution}`);
    if (!meta.commercialUseAllowed) console.log("  NOTE: non-commercial licence — do not use in a commercial product.");
    if (!meta.publicDisplayAllowed) console.log("  NOTE: publicDisplayAllowed=false — rows are hidden from users in production (set DATASET_ALLOW_RESTRICTED=true only if you have the right).");
    const report = await importDataset(ctx.db, {
      meta, files, listingsFile: one("listings"), city: one("city"), map: parseMap(one("map")), category: one("category"), acceptLicense: one("accept-license"),
      limit, sample, onlyCities: one("only-cities")?.split(",").map((s) => s.trim()).filter(Boolean), append: flags.has("append"), dryRun: flags.has("dry-run"),
      onProgress: (r, k) => console.log(`  …${r} rows read, ${k} kept`),
    });
    console.log("\nImport report:\n" + JSON.stringify(report, null, 2));
    if (!report.dryRun && report.kept > 0) {
      if (flags.has("embed")) {
        if (!ctx.embedding) console.log("\n--embed ignored: EMBEDDING_PROVIDER=none.");
        else { const r = await indexMissingEmbeddings(ctx, { onProgress: (d, t) => { if (d % 500 === 0) console.log(`  embedded ${d}/${t}`); } }); console.log(`\nEmbeddings: ${r.done} stored, ${r.failed} failed.`); }
      } else console.log("\nNext: `npm run embeddings:index` (semantic retrieval needs vectors), then `npm run dataset:verify`.");
    }
    if (report.dryRun) console.log("\n(dry run — nothing was written)");
    void upsertSource; void rest;
  }
} catch (err) {
  if (err instanceof LicenseNotAccepted || err instanceof AdapterError) { console.error("\n" + err.message); process.exitCode = 2; }
  else throw err;
} finally {
  await ctx.close();
}
