import { createHmac, randomBytes } from "node:crypto";
import { Prisma, type Db } from "../../db/client.js";
import { extractAspects } from "../query-understanding/aspects.js";
import { ADAPTERS, AdapterError, loadListings, readCsv, type AdapterOptions, type RawReview } from "./adapters.js";
import { dedupeKey, looksEnglish, normalizeText, scrubPii, shortHash } from "./clean.js";
import type { SourceMeta } from "./registry.js";

export class LicenseNotAccepted extends Error {
  constructor(public meta: SourceMeta) {
    super(`Licence not accepted for "${meta.id}". Re-run with --accept-license ${meta.licenseId} after reading the terms:\n  - ${meta.terms.join("\n  - ")}\n  Source: ${meta.url}`);
  }
}

export interface ImportOptions {
  meta: SourceMeta;
  /** Review files (e.g. one CSV per city, or reviews.csv). */
  files: string[];
  /** Inside Airbnb listings.csv (for neighbourhoods). */
  listingsFile?: string;
  city?: string;
  map?: Record<string, string>;
  category?: string;
  acceptLicense?: string;
  limit?: number;
  /** Deterministic sampling rate in (0,1]; decided per record id so re-runs pick the same rows. */
  sample?: number;
  onlyCities?: string[];
  append?: boolean;
  dryRun?: boolean;
  minChars?: number;
  maxChars?: number;
  onProgress?: (rowsRead: number, kept: number) => void;
}

export interface ImportReport {
  source: string;
  dryRun: boolean;
  filesRead: number;
  rowsRead: number;
  kept: number;
  skipped: Record<string, number>;
  cities: Record<string, number>;
  dateFrom: string | null;
  dateTo: string | null;
  masked: { emails: number; urls: number; phones: number; handles: number; rowsWithMasking: number };
  aspectRows: number;
  durationMs: number;
}

const BATCH = 500;

/** Removes everything previously imported from a source (pseudonymous authors cascade to their opinions). */
export async function removeDataset(db: Db, meta: SourceMeta): Promise<number> {
  const r = await db.user.deleteMany({ where: { id: { startsWith: `pub_${meta.shortCode}_` } } });
  await db.opinion.deleteMany({ where: { provenanceSource: meta.id } });
  await db.dataSource.update({ where: { id: meta.id }, data: { rowCount: 0, importedAt: null } }).catch(() => {});
  return r.count;
}

export async function upsertSource(db: Db, meta: SourceMeta): Promise<void> {
  const data = {
    name: meta.name, description: meta.description ?? null, url: meta.url, license: meta.license, licenseUrl: meta.licenseUrl ?? null, attribution: meta.attribution,
    geography: meta.geography ?? null, isSynthetic: false, commercialUseAllowed: meta.commercialUseAllowed, publicDisplayAllowed: meta.publicDisplayAllowed,
    adapter: meta.adapter, limitations: meta.limitations,
  };
  await db.dataSource.upsert({ where: { id: meta.id }, create: { id: meta.id, ...data }, update: data });
}

export async function importDataset(db: Db, o: ImportOptions): Promise<ImportReport> {
  const t0 = performance.now();
  const { meta } = o;
  if (o.acceptLicense !== meta.licenseId) throw new LicenseNotAccepted(meta);
  const adapter = ADAPTERS[meta.adapter];
  if (!adapter) throw new AdapterError(`Unknown adapter ${meta.adapter}`);
  if (o.sample !== undefined && !(o.sample > 0 && o.sample <= 1)) throw new AdapterError("--sample must be in (0, 1]");

  const minChars = o.minChars ?? 30, maxChars = o.maxChars ?? 2500;
  const listings = o.listingsFile ? await loadListings(o.listingsFile) : undefined;
  const adapterOpts: AdapterOptions = { map: o.map, city: o.city, listings, category: o.category };
  const onlyCities = o.onlyCities?.map((c) => c.toLowerCase());

  // Pre-flight: validate the layout of the first file (and its first row) BEFORE anything destructive happens,
  // so a wrong file or wrong --map never wipes data that was imported earlier.
  if (o.files.length === 0) throw new AdapterError("No input files given.");
  for await (const row of readCsv(o.files[0]!)) { adapter.prepare(Object.keys(row), adapterOpts); break; }

  if (!o.dryRun) {
    await upsertSource(db, meta);
    if (!o.append) await removeDataset(db, meta);
  }

  // Pseudonymisation key: random per import run and never stored => pseudonyms cannot be reversed or linked across imports.
  const key = randomBytes(32);
  const pseudonym = (k: string) => createHmac("sha256", key).update(`${meta.id}|${k}`).digest("hex").slice(0, 12);

  const report: ImportReport = { source: meta.id, dryRun: !!o.dryRun, filesRead: 0, rowsRead: 0, kept: 0, skipped: {}, cities: {}, dateFrom: null, dateTo: null, masked: { emails: 0, urls: 0, phones: 0, handles: 0, rowsWithMasking: 0 }, aspectRows: 0, durationMs: 0 };
  const skip = (why: string) => { report.skipped[why] = (report.skipped[why] ?? 0) + 1; };
  const seenText = new Set<string>();
  const seenIds = new Set<string>();
  let users: Prisma.UserCreateManyInput[] = [];
  let opinions: Prisma.OpinionCreateManyInput[] = [];
  let aspects: Prisma.OpinionAspectCreateManyInput[] = [];
  const flush = async () => {
    if (o.dryRun || opinions.length === 0) { users = []; opinions = []; aspects = []; return; }
    await db.user.createMany({ data: users, skipDuplicates: true });
    await db.opinion.createMany({ data: opinions, skipDuplicates: true });
    if (aspects.length) await db.opinionAspect.createMany({ data: aspects, skipDuplicates: true });
    users = []; opinions = []; aspects = [];
  };

  outer: for (const file of o.files) {
    report.filesRead++;
    let mapper: ReturnType<typeof adapter.prepare> | null = null;
    for await (const row of readCsv(file)) {
      mapper ??= adapter.prepare(Object.keys(row), adapterOpts);
      report.rowsRead++;
      if (report.rowsRead % 5000 === 0) o.onProgress?.(report.rowsRead, report.kept);
      const m = mapper(row);
      if ("skip" in m) { skip(m.skip); continue; }
      const r: RawReview = m;
      if (onlyCities && !onlyCities.includes(r.city.toLowerCase())) { skip("city_filtered"); continue; }
      if (o.sample !== undefined && o.sample < 1 && parseInt(shortHash(r.externalId, 8), 16) / 0xffffffff >= o.sample) { skip("sampled_out"); continue; }

      const cleaned = normalizeText(r.text);
      const scrub = scrubPii(cleaned);
      const text = scrub.text;
      if (text.length < minChars) { skip("too_short"); continue; }
      if (text.length > maxChars) { skip("too_long"); continue; }
      if (!looksEnglish(text)) { skip("not_english"); continue; }
      const dk = dedupeKey(text);
      if (seenText.has(dk)) { skip("duplicate_text"); continue; }
      const opId = `op_${meta.shortCode}_${shortHash(r.externalId, 14)}`;
      if (seenIds.has(opId)) { skip("duplicate_id"); continue; }
      seenText.add(dk); seenIds.add(opId);

      const total = scrub.masked.emails + scrub.masked.urls + scrub.masked.phones + scrub.masked.handles;
      if (total) report.masked.rowsWithMasking++;
      report.masked.emails += scrub.masked.emails; report.masked.urls += scrub.masked.urls; report.masked.phones += scrub.masked.phones; report.masked.handles += scrub.masked.handles;

      const authorHex = pseudonym(r.authorKey ?? r.externalId);
      const authorId = `pub_${meta.shortCode}_${authorHex}`;
      users.push({ id: authorId, displayName: `Public reviewer ${authorHex.slice(0, 6)} (${meta.shortCode})`, isSynthetic: false });
      opinions.push({
        id: opId, authorId, text, city: r.city, neighborhood: r.neighborhood ?? null, category: r.category, writtenAt: r.writtenAt, sourceType: "PUBLIC_REVIEW",
        firsthand: meta.assumeFirsthand, visibility: "PUBLIC", rating: r.rating ?? null, provenanceSource: meta.id, externalId: r.externalId, isSynthetic: false,
        provenanceNote: `Imported from "${meta.name}" (${meta.license}). Cleaned: HTML removed, emails/links/phone-like numbers/@handles masked. Reviewer identity pseudonymised.`,
      });
      for (const a of extractAspects(text)) { aspects.push({ opinionId: opId, aspect: a.aspect, polarity: a.polarity, matchedTerms: a.matchedTerms, extractor: "lexicon-v1" }); report.aspectRows++; }

      report.kept++;
      report.cities[r.city] = (report.cities[r.city] ?? 0) + 1;
      const iso = r.writtenAt.toISOString();
      if (!report.dateFrom || iso < report.dateFrom) report.dateFrom = iso;
      if (!report.dateTo || iso > report.dateTo) report.dateTo = iso;
      if (opinions.length >= BATCH) await flush();
      if (o.limit && report.kept >= o.limit) break outer;
    }
  }
  await flush();

  if (!o.dryRun) {
    const count = await db.opinion.count({ where: { provenanceSource: meta.id } });
    const cityList = Object.keys(report.cities).sort().join(", ");
    await db.dataSource.update({
      where: { id: meta.id },
      data: { rowCount: count, importedAt: new Date(), dateFrom: report.dateFrom ? new Date(report.dateFrom) : null, dateTo: report.dateTo ? new Date(report.dateTo) : null, geography: cityList ? `${cityList} (as imported)` : meta.geography ?? null },
    });
  }
  report.durationMs = Math.round(performance.now() - t0);
  return report;
}
