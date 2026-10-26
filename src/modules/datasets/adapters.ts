import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { canonicalCity, normalizeRating, parseDate, shortHash } from "./clean.js";

/** One review as read from a source file, before cleaning/filtering. */
export interface RawReview {
  externalId: string;
  text: string;
  city: string;
  neighborhood?: string | null;
  category: string;
  writtenAt: Date;
  rating?: number | null;
  /** Reviewer key from the source (pseudonymised on import; the reviewer's name is never read). */
  authorKey?: string | null;
}
export type RowResult = RawReview | { skip: string };
export type RowMapper = (row: Record<string, string>) => RowResult;
export class AdapterError extends Error {}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Finds the real header for the first matching alias (case/punctuation-insensitive). */
export function pick(headers: string[], aliases: string[]): string | undefined {
  const map = new Map(headers.map((h) => [norm(h), h]));
  for (const a of aliases) { const h = map.get(norm(a)); if (h) return h; }
  return undefined;
}

function need(headers: string[], what: string, aliases: string[], override?: string): string {
  if (override) {
    const h = pick(headers, [override]);
    if (!h) throw new AdapterError(`Column "${override}" (for ${what}) not found. Detected headers: ${headers.join(", ")}`);
    return h;
  }
  const h = pick(headers, aliases);
  if (!h) throw new AdapterError(`Could not find a column for ${what}. Tried: ${aliases.join(", ")}. Detected headers: ${headers.join(", ")}. Use --map ${what.split(" ")[0]}=<column> to point at it.`);
  return h;
}

/** Parses `--map text=Review,city=City,category=const:restaurant`. */
export function parseMap(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i < 1) throw new AdapterError(`Bad --map entry "${part}" (expected key=column)`);
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface AdapterOptions { map?: Record<string, string>; city?: string; listings?: Map<string, { neighborhood: string | null }>; category?: string }
export interface Adapter { id: string; prepare(headers: string[], o: AdapterOptions): RowMapper }

const valueOf = (spec: string | undefined, row: Record<string, string>): string | undefined => (spec === undefined ? undefined : row[spec]);

// ------------------------------------------------------------------------------------------------
// TripAdvisor "Dyadic Context" restaurant reviews. Column names are taken from the record's description and
// matched case-insensitively with aliases; this adapter has NOT been run against the real files (see docs/DATASETS.md).
// ------------------------------------------------------------------------------------------------
const tripadvisorDyadic: Adapter = {
  id: "tripadvisor-dyadic",
  prepare(headers, o) {
    const m = o.map ?? {};
    const text = need(headers, "text (review body)", ["review_full", "review_text", "reviewtext", "text", "review", "comment", "comments", "body", "content"], m.text);
    const title = pick(headers, m.title ? [m.title] : ["title_review", "title", "review_title"]);
    const date = need(headers, "date (review date)", ["date", "review_date", "date_review", "published_date", "date_of_visit"], m.date);
    const city = pick(headers, m.city ? [m.city] : ["city", "location", "town"]);
    const rating = pick(headers, m.rating ? [m.rating] : ["rating_review", "rating", "rating_value", "review_rating", "stars", "bubbles"]);
    const id = pick(headers, m.id ? [m.id] : ["review_id", "id", "reviewid"]);
    const place = pick(headers, m.place ? [m.place] : ["restaurant_name", "restaurant", "name", "place"]);
    if (!city && !o.city) throw new AdapterError(`No city column found and no --city given. Detected headers: ${headers.join(", ")}`);
    return (row) => {
      let body = (row[text] ?? "").trim();
      const t = title ? (row[title] ?? "").trim() : "";
      if (body.length < 20 && t) body = `${t}. ${body}`.trim();
      const d = parseDate(row[date] ?? "");
      if (!d) return { skip: "bad_date" };
      const c = canonicalCity(o.city ?? row[city!] ?? "");
      if (!c) return { skip: "no_city" };
      const key = id ? row[id] : undefined;
      return {
        externalId: key && key.trim() ? key.trim() : `h_${shortHash(`${place ? row[place] : ""}|${row[date]}|${body}`)}`,
        text: body, city: c, neighborhood: null, category: o.category ?? "restaurant", writtenAt: d, rating: normalizeRating(rating ? row[rating] : null),
        authorKey: null, // the dataset is not used for reviewer identity
      };
    };
  },
};

// ------------------------------------------------------------------------------------------------
// Inside Airbnb: reviews.csv (listing_id, id, date, reviewer_id, reviewer_name, comments) joined with listings.csv.
// The reviewer's NAME is never read.
// ------------------------------------------------------------------------------------------------
const AUTOMATED = /^(the host canceled this reservation|the reservation was canceled|this is an automated posting|automated posting)/i;
const insideAirbnb: Adapter = {
  id: "inside-airbnb",
  prepare(headers, o) {
    const m = o.map ?? {};
    if (!o.city) throw new AdapterError("Inside Airbnb files do not carry the city name: pass --city \"<City>\".");
    const listing = need(headers, "listing id", ["listing_id", "listingid"], m.listing);
    const id = need(headers, "review id", ["id", "review_id"], m.id);
    const date = need(headers, "date", ["date"], m.date);
    const text = need(headers, "text (comments)", ["comments", "comment", "review", "text"], m.text);
    const reviewer = pick(headers, m.author ? [m.author] : ["reviewer_id", "reviewerid"]);
    const city = canonicalCity(o.city);
    return (row) => {
      const body = (row[text] ?? "").trim();
      if (AUTOMATED.test(body)) return { skip: "automated" };
      const d = parseDate(row[date] ?? "");
      if (!d) return { skip: "bad_date" };
      const l = o.listings?.get(String(row[listing]));
      if (o.listings && !l) return { skip: "unknown_listing" };
      return { externalId: row[id]!, text: body, city, neighborhood: l?.neighborhood ?? null, category: o.category ?? "hotel_area", writtenAt: d, rating: null, authorKey: reviewer ? row[reviewer] ?? null : null };
    };
  },
};

// ------------------------------------------------------------------------------------------------
// Generic CSV: you supply the column mapping. Required: text, date, city (or --city). Optional: id, neighborhood, category, rating, author.
// Any value may be a constant: category=const:restaurant
// ------------------------------------------------------------------------------------------------
const genericCsv: Adapter = {
  id: "generic-csv",
  prepare(headers, o) {
    const m = o.map ?? {};
    const col = (k: string, required: boolean): string | undefined => {
      const spec = m[k];
      if (!spec) { if (required) throw new AdapterError(`generic-csv needs --map ${k}=<column>. Detected headers: ${headers.join(", ")}`); return undefined; }
      if (spec.startsWith("const:")) return spec;
      const h = pick(headers, [spec]);
      if (!h) throw new AdapterError(`Column "${spec}" (for ${k}) not found. Detected headers: ${headers.join(", ")}`);
      return h;
    };
    const get = (spec: string | undefined, row: Record<string, string>): string | undefined => (spec?.startsWith("const:") ? spec.slice(6) : valueOf(spec, row));
    const text = col("text", true)!, date = col("date", true)!;
    const city = col("city", !o.city), id = col("id", false), hood = col("neighborhood", false), cat = col("category", false), rating = col("rating", false), author = col("author", false);
    return (row) => {
      const body = (get(text, row) ?? "").trim();
      const d = parseDate(get(date, row) ?? "");
      if (!d) return { skip: "bad_date" };
      const c = canonicalCity(o.city ?? get(city, row) ?? "");
      if (!c) return { skip: "no_city" };
      return {
        externalId: get(id, row)?.trim() || `h_${shortHash(`${get(date, row)}|${body}`)}`,
        text: body, city: c, neighborhood: get(hood, row)?.trim() || null, category: (get(cat, row) ?? o.category ?? "other").toLowerCase().replace(/[^a-z_]+/g, "_"),
        writtenAt: d, rating: normalizeRating(get(rating, row)), authorKey: get(author, row) ?? null,
      };
    };
  },
};

export const ADAPTERS: Record<string, Adapter> = { "tripadvisor-dyadic": tripadvisorDyadic, "inside-airbnb": insideAirbnb, "generic-csv": genericCsv };

/** Streams a CSV file as row objects (RFC 4180: quoted fields, embedded newlines/quotes, BOM). */
export async function* readCsv(file: string): AsyncGenerator<Record<string, string>> {
  const parser = createReadStream(file).pipe(parse({ columns: (h: string[]) => h.map((x) => x.trim()), bom: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true, skip_records_with_error: true }));
  for await (const rec of parser) yield rec as Record<string, string>;
}

export async function readHeaders(file: string): Promise<string[]> {
  for await (const row of readCsv(file)) return Object.keys(row);
  throw new AdapterError(`${file} has no data rows.`);
}

/** Loads Inside Airbnb's listings.csv into id -> neighbourhood. */
export async function loadListings(file: string): Promise<Map<string, { neighborhood: string | null }>> {
  const out = new Map<string, { neighborhood: string | null }>();
  let idCol: string | undefined, hoodCol: string | undefined;
  for await (const row of readCsv(file)) {
    if (!idCol) {
      const headers = Object.keys(row);
      idCol = need(headers, "listing id", ["id", "listing_id"]);
      hoodCol = pick(headers, ["neighbourhood_cleansed", "neighbourhood", "neighborhood"]);
    }
    const hood = hoodCol ? (row[hoodCol] ?? "").trim() : "";
    out.set(String(row[idCol]), { neighborhood: hood || null });
  }
  return out;
}
