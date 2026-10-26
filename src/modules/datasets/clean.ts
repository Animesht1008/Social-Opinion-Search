import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };

export function normalizeText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]{1,200}>/g, " ") // strip tags
    .replace(/&(?:amp|quot|#39|#x27|apos|lt|gt|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ") // control characters
    .replace(/\s+/g, " ")
    .trim();
}

export interface Scrubbed { text: string; masked: { emails: number; urls: number; phones: number; handles: number } }

/** Masks emails, URLs, phone-number-like digit runs (>= 9 digits) and @handles. Names inside free text cannot be detected reliably. */
export function scrubPii(text: string): Scrubbed {
  const masked = { emails: 0, urls: 0, phones: 0, handles: 0 };
  let t = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => (masked.emails++, "[email]"));
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>")]+/gi, () => (masked.urls++, "[link]"));
  t = t.replace(/(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g, (m) => {
    if ((m.match(/\d/g) ?? []).length < 9) return m; // dates, prices, short numbers stay
    masked.phones++;
    return "[phone]";
  });
  t = t.replace(/(?<![\w@])@\w{3,}/g, () => (masked.handles++, "[handle]"));
  return { text: t, masked };
}

const EN_STOP = new Set("the and was is of to in we it for with a i were had but not very this that they our are have on at as be from my so you there".split(" "));

export function looksEnglish(text: string): boolean {
  const nonSpace = text.replace(/\s/g, "");
  if (nonSpace.length === 0) return false;
  const ascii = (nonSpace.match(/[A-Za-z0-9.,!?'"()\-:;/&%$]/g) ?? []).length;
  if (ascii / nonSpace.length < 0.9) return false;
  const tokens = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (tokens.length < 6) return false;
  const hits = tokens.filter((t) => EN_STOP.has(t)).length;
  return hits / tokens.length >= 0.14;
}

export const dedupeKey = (text: string): string => createHash("sha1").update(text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).digest("hex");
export const shortHash = (s: string, n = 12): string => createHash("sha1").update(s).digest("hex").slice(0, n);

const CITY_ALIASES: Record<string, string> = {
  "new delhi": "Delhi", delhi: "Delhi", bangalore: "Bengaluru", bengaluru: "Bengaluru", bombay: "Mumbai", mumbai: "Mumbai",
  "new york city": "New York", nyc: "New York", newyork: "New York", "new york": "New York", "greater london": "London",
};

/** "New_Delhi", "new-york", " LONDON " -> canonical city name used by the rest of the system. */
export function canonicalCity(raw: string): string {
  const k = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!k) return "";
  return CITY_ALIASES[k] ?? k.replace(/\b\w/g, (c) => c.toUpperCase());
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return valid(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m) { const mo = monthIndex(m[2]!); return mo ? valid(+m[3]!, mo, +m[1]!) : null; }
  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) { const mo = monthIndex(m[1]!); return mo ? valid(+m[3]!, mo, +m[2]!) : null; }
  m = /^([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m) { const mo = monthIndex(m[1]!); return mo ? valid(+m[2]!, mo, 1) : null; }
  if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000);
  return null;
}
const monthIndex = (name: string): number | null => {
  const i = MONTHS.findIndex((m) => m === name.toLowerCase() || m.slice(0, 3) === name.toLowerCase().slice(0, 3));
  return i < 0 ? null : i + 1;
};
function valid(y: number, mo: number, d: number): Date | null {
  if (y < 1995 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, 12));
  return dt.getUTCMonth() === mo - 1 ? dt : null;
}

/** Ratings come as 1-5, 10-50 (TripAdvisor bubbles x10) or 0-10; returns a 1-5 integer or null. */
export function normalizeRating(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", ".").match(/-?\d+(\.\d+)?/)?.[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const five = n <= 5 ? n : n <= 10 ? n / 2 : n <= 50 ? n / 10 : NaN;
  if (!Number.isFinite(five)) return null;
  return Math.min(5, Math.max(1, Math.round(five)));
}
