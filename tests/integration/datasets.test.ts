import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import { AdapterError } from "../../src/modules/datasets/adapters.js";
import { importDataset, LicenseNotAccepted, removeDataset } from "../../src/modules/datasets/importer.js";
import { findSource, SourceMetaSchema } from "../../src/modules/datasets/registry.js";
import { runEvaluation } from "../../src/modules/evaluation/runner.js";
import { dbAvailable, testContext, tokensFor } from "../helpers.js";

const ok = dbAvailable();
const DYADIC = "tests/fixtures/dyadic-sample.csv";
const meta = findSource("tripadvisor-dyadic-2022")!;
const airbnb = findSource("inside-airbnb")!;
const GENERIC = SourceMetaSchema.parse({
  id: "test-generic", shortCode: "tgen", name: "Test generic source", url: "https://example.test/data", license: "Test licence", licenseId: "TEST-LICENCE",
  attribution: "Test attribution", commercialUseAllowed: true, publicDisplayAllowed: true, adapter: "generic-csv", limitations: "fixture only",
});

describe.skipIf(!ok)("dataset import (fixtures that imitate the documented formats)", () => {
  let ctx: AppContext;
  beforeAll(async () => { ctx = await testContext({ embedding: false }); });
  afterAll(async () => {
    for (const m of [meta, airbnb]) await removeDataset(ctx.db, m);
    await ctx.db.opinion.deleteMany({ where: { provenanceSource: GENERIC.id } });
    await ctx.db.user.deleteMany({ where: { id: { startsWith: "pub_tgen_" } } });
    await ctx.db.dataSource.deleteMany({ where: { id: GENERIC.id } });
    await ctx.close();
  });

  it("refuses to import without explicitly accepting the licence terms", async () => {
    const err = await importDataset(ctx.db, { meta, files: [DYADIC] }).catch((e) => e);
    expect(err).toBeInstanceOf(LicenseNotAccepted);
    expect(err.message).toMatch(/--accept-license CC-BY-NC-4\.0/);
    expect(await ctx.db.opinion.count({ where: { provenanceSource: meta.id } })).toBe(0);
    expect((await importDataset(ctx.db, { meta, files: [DYADIC], acceptLicense: "CC-BY-4.0" }).catch((e) => e))).toBeInstanceOf(LicenseNotAccepted);
  });

  it("dry run reads and filters but writes nothing", async () => {
    const r = await importDataset(ctx.db, { meta, files: [DYADIC], acceptLicense: meta.licenseId, dryRun: true });
    expect(r.kept).toBe(5);
    expect(await ctx.db.opinion.count({ where: { provenanceSource: meta.id } })).toBe(0);
  });

  it("imports the TripAdvisor-format fixture: cleans, filters, dedupes, pseudonymises, records provenance", async () => {
    const r = await importDataset(ctx.db, { meta, files: [DYADIC], acceptLicense: meta.licenseId });
    expect(r).toMatchObject({ rowsRead: 9, kept: 5, skipped: { not_english: 1, too_short: 1, bad_date: 1, duplicate_text: 1 } });
    expect(r.cities).toEqual({ Delhi: 1, London: 3, Paris: 1 }); // "New_Delhi" and "New Delhi" both canonicalised
    expect(r.dateFrom!.slice(0, 10)).toBe("2018-02-27");
    expect(r.dateTo!.slice(0, 10)).toBe("2020-05-01");
    expect(r.masked).toMatchObject({ emails: 1, urls: 1, phones: 1, handles: 1, rowsWithMasking: 1 });

    const rows = await ctx.db.opinion.findMany({ where: { provenanceSource: meta.id }, include: { author: true } });
    expect(rows).toHaveLength(5);
    for (const o of rows) {
      expect(o).toMatchObject({ sourceType: "PUBLIC_REVIEW", visibility: "PUBLIC", firsthand: true, isSynthetic: false, category: "restaurant" });
      expect(o.author.id).toMatch(/^pub_tadyad_[0-9a-f]{12}$/);
      expect(o.author.displayName).toMatch(/^Public reviewer [0-9a-f]{6} \(tadyad\)$/);
      expect(o.author.email).toBeNull();
      expect(o.provenanceNote).toMatch(/Imported from .*\(CC BY-NC 4\.0/);
      expect(o.externalId).toBeTruthy();
    }
    const joined = rows.map((o) => o.text).join("\n");
    expect(joined).not.toMatch(/owner@example\.com|7946|www\.example\.com|@foodie_blog|<br|&amp;/);
    expect(joined).toContain("[email]");
    expect(joined).toContain("Great place & very clean!"); // entity decoded, tag removed
    expect(joined).toContain('He said "never again"'); // quoted CSV field with an embedded newline parsed correctly
    expect(await ctx.db.opinionAspect.count({ where: { opinion: { provenanceSource: meta.id } } })).toBe(r.aspectRows);
    expect(r.aspectRows).toBeGreaterThan(5);

    const src = await ctx.db.dataSource.findUniqueOrThrow({ where: { id: meta.id } });
    expect(src).toMatchObject({ rowCount: 5, commercialUseAllowed: false, publicDisplayAllowed: true, isSynthetic: false });
    expect(src.geography).toContain("London");
    expect(src.importedAt).not.toBeNull();
  });

  it("is idempotent: re-importing replaces the previous import (no duplicate opinions or orphan authors)", async () => {
    await importDataset(ctx.db, { meta, files: [DYADIC], acceptLicense: meta.licenseId });
    expect(await ctx.db.opinion.count({ where: { provenanceSource: meta.id } })).toBe(5);
    expect(await ctx.db.user.count({ where: { id: { startsWith: "pub_tadyad_" } } })).toBe(5);
  });

  it("supports limit, deterministic sampling and city filtering", async () => {
    const opts = { meta, files: [DYADIC], acceptLicense: meta.licenseId, dryRun: true };
    expect((await importDataset(ctx.db, { ...opts, limit: 2 })).kept).toBe(2);
    const a = await importDataset(ctx.db, { ...opts, sample: 0.5 });
    const b = await importDataset(ctx.db, { ...opts, sample: 0.5 });
    expect(a.kept).toBe(b.kept);
    expect(a.skipped.sampled_out).toBe(b.skipped.sampled_out);
    const l = await importDataset(ctx.db, { ...opts, onlyCities: ["london"] });
    expect(l.kept).toBe(3);
    expect(l.skipped.city_filtered).toBeGreaterThan(0);
    await expect(importDataset(ctx.db, { ...opts, sample: 2 })).rejects.toThrow(/--sample/);
  });

  it("fails loudly, listing the detected headers, when the file layout is not what the adapter expects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sos-"));
    const bad = join(dir, "weird.csv");
    writeFileSync(bad, "foo,bar,baz\n1,2,3\n");
    const before = await ctx.db.opinion.count({ where: { provenanceSource: meta.id } });
    expect(before).toBe(5);
    const err = await importDataset(ctx.db, { meta, files: [bad], acceptLicense: meta.licenseId }).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(await ctx.db.opinion.count({ where: { provenanceSource: meta.id } })).toBe(before); // a failed import must not wipe earlier data
    expect(err.message).toMatch(/Detected headers: foo, bar, baz/);
    expect(err.message).toMatch(/--map/);
  });

  it("generic CSV adapter works with an explicit column mapping and constants", async () => {
    const r = await importDataset(ctx.db, { meta: GENERIC, files: [DYADIC], acceptLicense: GENERIC.licenseId, map: { text: "review_full", date: "date", city: "city", category: "const:restaurant", rating: "rating_review" } });
    expect(r.kept).toBe(5);
    const o = await ctx.db.opinion.findFirstOrThrow({ where: { provenanceSource: GENERIC.id, city: "London", rating: 5 } });
    expect(o.category).toBe("restaurant");
    await expect(importDataset(ctx.db, { meta: GENERIC, files: [DYADIC], acceptLicense: GENERIC.licenseId, map: { text: "review_full" } })).rejects.toThrow(/needs --map date/);
  });

  it("Inside Airbnb layout: joins listings for neighbourhoods, skips automated/unknown rows, never reads reviewer names", async () => {
    const r = await importDataset(ctx.db, { meta: airbnb, files: ["tests/fixtures/airbnb-reviews.csv"], listingsFile: "tests/fixtures/airbnb-listings.csv", city: "lisbon", acceptLicense: airbnb.licenseId });
    expect(r).toMatchObject({ rowsRead: 6, kept: 3, skipped: { automated: 1, unknown_listing: 1, bad_date: 1 } });
    const rows = await ctx.db.opinion.findMany({ where: { provenanceSource: airbnb.id }, include: { author: true } });
    expect(rows.map((o) => o.neighborhood).sort()).toEqual(["Alfama", "Alfama", "Baixa"]);
    expect(rows.every((o) => o.city === "Lisbon" && o.category === "hotel_area")).toBe(true);
    expect(new Set(rows.map((o) => o.authorId)).size).toBe(2); // reviewer 555 wrote two reviews -> one pseudonym
    const users = await ctx.db.user.findMany({ where: { id: { startsWith: "pub_airbnb_" } } });
    for (const name of ["Marcos", "Joana", "Alicia", "Zed", "Pia"]) expect(users.some((u) => u.displayName.includes(name))).toBe(false);
    await expect(importDataset(ctx.db, { meta: airbnb, files: ["tests/fixtures/airbnb-reviews.csv"], acceptLicense: airbnb.licenseId })).rejects.toThrow(/--city/);
  });

  it("imports never change the benchmark: evaluation is pinned to the synthetic corpus", async () => {
    // Both corpora are present now (TripAdvisor-format + Airbnb-format rows). The benchmark must be unaffected.
    const withImports = await runEvaluation(ctx, { includeAblations: false });
    const rows = await ctx.db.opinion.count({ where: { isSynthetic: false, provenanceSource: { in: [meta.id, airbnb.id] } } });
    expect(rows).toBeGreaterThan(0);
    const lex = withImports.summary.configs.lexical.all;
    expect(lex["P@5"]).toBeCloseTo(0.723, 2);
    expect(lex["NDCG@5"]).toBeCloseTo(0.749, 2);
    expect(withImports.summary.leakSweep.unauthorizedCandidates).toBe(0);
  });
});

describe.skipIf(!ok)("imported data in search and under the deployment policy", () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  let A: Record<string, Record<string, string>>;
  let strictCtx: AppContext;
  let strictApp: FastifyInstance;
  const J = { "content-type": "application/json" };
  const search = (a: FastifyInstance, q: string, filters: object) => a.inject({ method: "POST", url: "/api/v1/search", headers: { ...J, ...A.u_zoya }, payload: JSON.stringify({ query: q, mode: "lexical", generateAnswer: false, includeWeb: false, limit: 10, filters }) });

  beforeAll(async () => {
    ctx = await testContext({ embedding: false });
    app = await buildApp(ctx, { serveUi: false });
    A = await tokensFor(ctx, ["u_zoya"]);
    await importDataset(ctx.db, { meta, files: [DYADIC], acceptLicense: meta.licenseId });
    await importDataset(ctx.db, { meta: airbnb, files: ["tests/fixtures/airbnb-reviews.csv"], listingsFile: "tests/fixtures/airbnb-listings.csv", city: "Lisbon", acceptLicense: airbnb.licenseId });
    strictCtx = await testContext({ embedding: false, config: { DATASET_ALLOW_RESTRICTED: "false" } });
    strictApp = await buildApp(strictCtx, { serveUi: false });
  });
  afterAll(async () => {
    for (const m of [meta, airbnb]) await removeDataset(ctx.db, m);
    await app.close(); await strictApp.close(); await ctx.close(); await strictCtx.close();
  });

  it("search can be restricted to one corpus and returns licence + attribution with each result", async () => {
    const r = (await search(app, "vegetarian thali fresh friendly staff", { dataSources: [meta.id] })).json();
    expect(r.selected.length).toBeGreaterThan(0);
    for (const s of r.selected) {
      expect(s.dataSource).toMatchObject({ id: meta.id, commercialUseAllowed: false });
      expect(s.dataSource.license).toMatch(/CC BY-NC 4\.0/);
      expect(s.dataSource.attribution).toMatch(/Zenodo record 6583422/);
      expect(s.sourceType).toBe("PUBLIC_REVIEW");
      expect(s.isSynthetic).toBe(false);
      expect(s.authorName).toMatch(/^Public reviewer/);
    }
    expect(r.appliedFilters.dataSources).toEqual([meta.id]);
  });

  it("a restricted source (publicDisplayAllowed=false) is shown only when the policy allows it", async () => {
    const q = "lit street at night taxis lane dark empty midnight";
    const allowed = (await search(app, q, { city: "Lisbon" })).json();
    expect(allowed.candidates.length).toBeGreaterThan(0);
    expect(allowed.candidates.every((c: { dataSource: { id: string } }) => c.dataSource.id === airbnb.id)).toBe(true);
    const hidden = (await search(strictApp, q, { city: "Lisbon" })).json();
    expect(hidden.candidates).toEqual([]); // hidden everywhere, not just filtered in the UI
    const list = (await strictApp.inject({ method: "GET", url: "/api/v1/opinions?source=inside-airbnb&limit=50", headers: A.u_zoya })).json();
    expect(list.opinions).toEqual([]);
    const ds = (await strictApp.inject({ method: "GET", url: "/api/v1/data-sources" })).json();
    const a = ds.sources.find((s: { id: string }) => s.id === airbnb.id);
    expect(a).toMatchObject({ displayable: false, publicDisplayAllowed: false, opinionCount: 3 });
    expect(ds.policy.restrictedSourcesVisible).toBe(false);
    const t = ds.sources.find((s: { id: string }) => s.id === meta.id);
    expect(t).toMatchObject({ displayable: true, commercialUseAllowed: false, opinionCount: 5 });
  });

  it("data-sources endpoint documents provenance for every corpus including the synthetic and user-generated ones", async () => {
    const ds = (await app.inject({ method: "GET", url: "/api/v1/data-sources" })).json();
    const ids = ds.sources.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["synthetic-seed-v1", "user-generated", meta.id, airbnb.id]));
    const syn = ds.sources.find((s: { id: string }) => s.id === "synthetic-seed-v1");
    expect(syn).toMatchObject({ isSynthetic: true, opinionCount: 108 });
    for (const s of ds.sources) { expect(s.license).toBeTruthy(); expect(s.name).toBeTruthy(); }
  });
});
