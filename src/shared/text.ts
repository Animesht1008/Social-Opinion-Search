export const STOPWORDS = new Set(
  (
    "a an the and or but if then else of at by for with about against between into through during before after above below to from up down in out on off over under " +
    "again further once here there when where why how all any both each few more most other some such no nor not only own same so than too very can will just should now " +
    "is are was were be been being have has had having do does did doing i me my myself we our ours you your yours he him his she her hers it its they them their what which who whom " +
    "this that these those am would could might may must shall also really quite much many one two get got go going went come came see saw"
  ).split(/\s+/),
);

export const QUERY_META_WORDS = new Set(
  (
    "find show tell give recommend suggest suggestion looking look want need needs wanted searching search consider considering suitable good best great nice " +
    "please help me us visiting visit visited trip travelling traveling travel planning plan going opinions opinion review reviews people anyone someone " +
    "place places area areas spot spots option options thing things kind sort like likes prefer prefers preference"
  ).split(/\s+/),
);

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/n't\b/g, " not")
    .replace(/'s\b/g, "")
    .replace(/'/g, "");
}

/** Lowercase alphanumeric tokens (keeps ₹ and digits). */
export function tokenize(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-z0-9\u20b9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

const VOWEL = /[aeiouy]/;

/** Deliberately simple suffix stripper — consistent between lexicon and text, not linguistically perfect. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/(x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing") && VOWEL.test(w.slice(0, -3))) {
    w = w.slice(0, -3);
    if (/([^aeiou])\1$/.test(w)) w = w.slice(0, -1);
  } else if (w.length > 4 && w.endsWith("ied")) {
    w = w.slice(0, -3) + "y";
  } else if (w.length > 4 && w.endsWith("ed") && VOWEL.test(w.slice(0, -2))) {
    w = w.slice(0, -2);
    if (/([^aeiou])\1$/.test(w)) w = w.slice(0, -1);
  } else if (w.length > 4 && w.endsWith("ly")) {
    w = w.slice(0, -2);
  }
  return w;
}

export function stemTokens(text: string): string[] {
  return tokenize(text).map(stem);
}

export function contentStems(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Word-bigram shingles over content stems; used for near-duplicate detection. */
export function shingles(text: string, n = 2): Set<string> {
  const toks = stemTokens(text);
  const out = new Set<string>();
  if (toks.length < n) {
    if (toks.length) out.add(toks.join(" "));
    return out;
  }
  for (let i = 0; i <= toks.length - n; i++) out.add(toks.slice(i, i + n).join(" "));
  return out;
}

export function textSimilarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}

export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}

export function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function excerpt(text: string, max = 240): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}
