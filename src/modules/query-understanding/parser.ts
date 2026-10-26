import { ASPECT_IDS, aspectsInQuery } from "./aspects.js";
import { IntentSchema, LlmIntentSchema, type ApiFilters, type HardConstraint, type Intent } from "./intent.js";
import type { LlmProvider } from "../llm/provider.js";
import { QUERY_META_WORDS, STOPWORDS, tokenize } from "../../shared/text.js";

export interface ParseContext {
  cities: string[];
  neighborhoods: Record<string, string[]>;
  now: Date;
}

const CITY_ALIASES: Record<string, string> = { bangalore: "Bengaluru", bombay: "Mumbai", "new delhi": "Delhi" };
const MONTHS = new Set("january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(" "));
const COMPANIONS = /\bwith (?:my |our )?(sister|brother|wife|husband|partner|mother|mom|father|dad|daughter|son|kids|children|family|friends|girlfriend|boyfriend|parents|colleagues)\b/i;
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, nine: 9, twelve: 12 };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function subtractMonths(now: Date, months: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** Deterministic baseline parser ("rule-v1"). Runs without any API key. */
export function parseQueryRules(query: string, ctx: ParseContext): Intent {
  const q = query.trim();
  const lower = q.toLowerCase();
  const constraints: HardConstraint[] = [];
  const soft: string[] = [];
  const ambiguities: string[] = [];
  const consumed: string[] = []; // phrases removed from keyword extraction
  let city: string | null = null;
  let neighborhood: string | null = null;

  // --- location (hard when explicit) ---
  const cityCandidates = [...ctx.cities.map((c) => [c, c] as const), ...Object.entries(CITY_ALIASES).filter(([, v]) => ctx.cities.includes(v)).map(([a, v]) => [a, v] as const)];
  for (const [alias, canonical] of cityCandidates) {
    const m = new RegExp(`\\b${esc(alias.toLowerCase())}\\b`, "i").exec(lower);
    if (m) {
      city = canonical;
      consumed.push(m[0]);
      constraints.push({ kind: "city", value: canonical, text: m[0], verifiable: true, source: "rule" });
      break;
    }
  }
  if (!city) {
    const m = /\b(?:visiting|travel(?:l)?ing to|trip to|going to|moving to|flying to|staying in|stay in)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/.exec(q);
    if (m && !MONTHS.has(m[1]!.toLowerCase())) {
      city = m[1]!;
      consumed.push(m[1]!);
      constraints.push({ kind: "city", value: city, text: m[0], verifiable: true, source: "rule" });
      ambiguities.push(`Location "${city}" is not present in the corpus; the city filter will be enforced and may return no results.`);
    }
  }
  if (!city) {
    // A neighborhood that exists in exactly one city implies that city (explicit, logged as an inferred constraint).
    for (const [c, hoods] of Object.entries(ctx.neighborhoods)) {
      const hit = hoods.find((n) => new RegExp(`\\b${esc(n.toLowerCase())}\\b`, "i").test(lower));
      if (hit) {
        city = c;
        constraints.push({ kind: "city", value: c, text: `${hit} (neighborhood in ${c}; inferred)`, verifiable: true, source: "rule" });
        break;
      }
    }
  }
  if (city) {
    for (const n of ctx.neighborhoods[city] ?? []) {
      if (new RegExp(`\\b${esc(n.toLowerCase())}\\b`, "i").test(lower)) {
        neighborhood = n;
        break;
      }
    }
  } else {
    ambiguities.push("No location detected; searching all cities.");
  }

  // --- topic (soft context, not a filter) ---
  const topicVotes: Record<string, number> = {
    hotel_area: (lower.match(/\b(hotel|stay|staying|accommodation|guesthouse|hostel|lodging)\b/g) ?? []).length,
    cafe: (lower.match(/\b(cafe|café|coffee|cowork|co-work|work from|laptop)\b/g) ?? []).length,
    restaurant: (lower.match(/\b(restaurant|dinner|lunch|eat|eating|food|thali|meal|vegetarian|veg)\b/g) ?? []).length,
  };
  const best = Object.entries(topicVotes).sort((a, b) => b[1] - a[1])[0]!;
  const topic = best[1] > 0 ? best[0] : null;

  // --- hard constraints (verifiable) ---
  const firsthand = /\b(first-?hand|personal experiences?|actually (?:stayed|been|visited|lived|gone|went)|(?:people|those|someone|anyone) who (?:actually )?(?:stayed|visited|lived|went|have been))\b/i.exec(q);
  if (firsthand) {
    constraints.push({ kind: "firsthand_only", value: true, text: firsthand[0], verifiable: true, source: "rule" });
    consumed.push(firsthand[0]);
  }
  let since: string | null = null;
  const sinceM = /\b(?:in |over |during |within )?the (?:last|past) (\d+|a|an|one|two|three|six|nine|twelve)?\s*(week|month|year)s?\b/i.exec(q);
  if (sinceM) {
    const n = sinceM[1] ? (/^\d+$/.test(sinceM[1]) ? Number(sinceM[1]) : (NUM_WORDS[sinceM[1].toLowerCase()] ?? 1)) : 1;
    const unit = sinceM[2]!.toLowerCase();
    const d = unit === "year" ? subtractMonths(ctx.now, 12 * n) : unit === "month" ? subtractMonths(ctx.now, n) : new Date(ctx.now.getTime() - n * 7 * 86400000);
    since = isoDay(d);
    constraints.push({ kind: "since", value: since, text: sinceM[0], verifiable: true, source: "rule" });
    consumed.push(sinceM[0]);
  } else if (/\bthis year\b/i.test(q)) {
    since = `${ctx.now.getUTCFullYear()}-01-01`;
    constraints.push({ kind: "since", value: since, text: "this year", verifiable: true, source: "rule" });
    consumed.push("this year");
  }
  const channelM = /\b(?:only|just)\b[^.,;]{0,25}\b(close friends|inner circle|my circle|my family|family and friends|my friends)\b/i.exec(q);
  if (channelM) {
    constraints.push({ kind: "channel", value: ["inner_circle"], text: channelM[0], verifiable: true, source: "rule" });
    consumed.push(channelM[0]);
  }

  // --- unverifiable hard constraints (explicit "must ..." phrasing we cannot check against a stored field) ---
  let residue = q;
  for (const c of constraints) residue = residue.replace(c.text, " ");
  const re = /\b(must|has to|have to|needs? to|without)\s+([^,.;?]{3,50})/gi;
  for (let m = re.exec(residue); m; m = re.exec(residue)) {
    const text = m[0].trim();
    constraints.push({ kind: "unverifiable", value: text, text, verifiable: false, source: "rule" });
    soft.push(text);
    consumed.push(text);
  }

  // --- temporal / soft ---
  const recent = /\b(recent|recently|latest|lately|these days|nowadays|currently|up[- ]to[- ]date)\b/i.test(q);
  const comp = COMPANIONS.exec(q);
  if (comp) {
    soft.push(`travelling with ${comp[1]!.toLowerCase()}`);
    consumed.push(comp[0]);
  }

  // --- aspects (lexicon-based) ---
  const aspects = aspectsInQuery(q);
  if (aspects.length === 0) ambiguities.push("No known aspect (e.g. lighting, transport, wifi, noise) recognised; ranking relies on keywords and embeddings only.");

  // --- keywords for lexical retrieval ---
  const drop = new Set(consumed.flatMap((p) => tokenize(p)));
  const keywords: string[] = [];
  for (const t of tokenize(q)) {
    if (t.length < 3 || STOPWORDS.has(t) || QUERY_META_WORDS.has(t) || drop.has(t) || /^\d+$/.test(t)) continue;
    if (!keywords.includes(t)) keywords.push(t);
  }
  if (keywords.length === 0) ambiguities.push("No content keywords left after removing constraints; lexical retrieval will return nothing.");

  const evidence: Intent["evidenceCharacteristics"] = ["include_negative", "include_conflicting"];
  if (firsthand) evidence.push("firsthand");
  if (recent || since) evidence.push("recent");
  if (aspects.length) evidence.push("specific");

  return IntentSchema.parse({
    rawQuery: q,
    parser: "rule-v1",
    topic,
    location: { city, neighborhood },
    aspects,
    keywords,
    hardConstraints: constraints,
    softPreferences: soft,
    temporal: { recencyPreference: recent || since ? "recent" : "none", since, note: sinceM ? sinceM[0] : recent ? "recency mentioned" : null },
    evidenceCharacteristics: evidence,
    ambiguities,
    warnings: [],
  });
}

/** Adds API-supplied filters as explicit hard constraints (source "api"), overriding parsed ones of the same kind. */
export function applyApiFilters(intent: Intent, f: ApiFilters | undefined): Intent {
  if (!f) return intent;
  const out: Intent = structuredClone(intent);
  const replace = (kind: HardConstraint["kind"], c: HardConstraint) => {
    out.hardConstraints = out.hardConstraints.filter((x) => x.kind !== kind);
    out.hardConstraints.push(c);
  };
  if (f.city) {
    replace("city", { kind: "city", value: f.city, text: `filters.city=${f.city}`, verifiable: true, source: "api" });
    out.location.city = f.city;
  }
  if (f.category) replace("category", { kind: "category", value: f.category, text: `filters.category=${f.category}`, verifiable: true, source: "api" });
  if (f.since) {
    replace("since", { kind: "since", value: f.since, text: `filters.since=${f.since}`, verifiable: true, source: "api" });
    out.temporal.since = f.since;
  }
  if (f.firsthandOnly) replace("firsthand_only", { kind: "firsthand_only", value: true, text: "filters.firsthandOnly=true", verifiable: true, source: "api" });
  if (f.sourceTypes) replace("source_type", { kind: "source_type", value: f.sourceTypes, text: `filters.sourceTypes=${f.sourceTypes.join("|")}`, verifiable: true, source: "api" });
  if (f.dataSources) replace("data_source", { kind: "data_source", value: f.dataSources, text: `filters.dataSources=${f.dataSources.join("|")}`, verifiable: true, source: "api" });
  if (f.channels) replace("channel", { kind: "channel", value: f.channels, text: `filters.channels=${f.channels.join("|")}`, verifiable: true, source: "api" });
  return IntentSchema.parse(out);
}

// ---------------------------------------------------------------------------------------------
// Optional LLM-assisted parsing. Output is schema-validated and *grounded* against the query text.
// ---------------------------------------------------------------------------------------------

const LLM_SYSTEM = `You convert a user's natural-language question about places into a JSON object. Return ONLY JSON.
Fields: city (string|null), neighborhood (string|null), topic ("hotel_area"|"cafe"|"restaurant"|"other"|null),
aspects (array of ids chosen ONLY from: ${ASPECT_IDS.join(", ")}), firsthandOnly (boolean; true only if the user explicitly asks for people who really visited/stayed),
sinceDate (YYYY-MM-DD|null; only if the user states a time window), onlyInnerCircle (boolean; only if the user explicitly restricts to close friends/family),
recencyPreference ("none"|"recent"), softPreferences (string[]), unverifiableConstraints (string[]; explicit must-haves that cannot be checked against these fields),
ambiguities (string[]). Never invent constraints the user did not state.`;

export async function understandQuery(args: {
  query: string;
  ctx: ParseContext;
  llm: LlmProvider | null;
  useLlm: boolean;
  timeoutMs: number;
}): Promise<Intent> {
  const rule = parseQueryRules(args.query, args.ctx);
  if (!args.llm || !args.useLlm) return rule;
  try {
    const out = await args.llm.generateJson({
      system: LLM_SYSTEM,
      user: `Known cities: ${args.ctx.cities.join(", ")}\nToday: ${isoDay(args.ctx.now)}\nQuestion: ${args.query}`,
      schema: LlmIntentSchema,
      timeoutMs: args.timeoutMs,
    });
    return mergeLlmIntent(rule, out, args.ctx, args.llm.id);
  } catch (err) {
    const r = structuredClone(rule);
    r.warnings.push(`LLM query understanding failed (${(err as Error).message}); the rule-based parser was used instead.`);
    return r;
  }
}

export function mergeLlmIntent(rule: Intent, raw: unknown, ctx: ParseContext, llmId: string): Intent {
  const llm = LlmIntentSchema.parse(raw);
  const out: Intent = structuredClone(rule);
  const q = rule.rawQuery.toLowerCase();
  out.parser = `llm:${llmId}+rule-v1-grounding`;

  // City: must be a known city AND literally present in the query (or a known alias).
  if (llm.city && !out.hardConstraints.some((c) => c.kind === "city")) {
    const known = ctx.cities.find((c) => c.toLowerCase() === llm.city!.toLowerCase());
    const alias = Object.entries(CITY_ALIASES).find(([, v]) => v.toLowerCase() === llm.city!.toLowerCase())?.[0];
    const grounded = known && (q.includes(known.toLowerCase()) || (alias && q.includes(alias)));
    if (known && grounded) {
      out.hardConstraints.push({ kind: "city", value: known, text: known, verifiable: true, source: "llm" });
      out.location.city = known;
    } else out.warnings.push(`LLM proposed city "${llm.city}" which is not a known, query-grounded city; ignored.`);
  }
  if (llm.neighborhood && !out.location.neighborhood && q.includes(llm.neighborhood.toLowerCase())) out.location.neighborhood = llm.neighborhood;

  // Aspects: canonical ids only; unknown ones become soft preferences instead of silently trusted fields.
  for (const a of llm.aspects) {
    if (ASPECT_IDS.includes(a)) {
      if (!out.aspects.includes(a)) out.aspects.push(a);
    } else if (!out.softPreferences.includes(a)) out.softPreferences.push(a);
  }

  if (llm.firsthandOnly && !out.hardConstraints.some((c) => c.kind === "firsthand_only")) {
    if (/\b(stayed|visited|lived|actually|firsthand|first-hand|personal|been there|went)\b/i.test(rule.rawQuery))
      out.hardConstraints.push({ kind: "firsthand_only", value: true, text: "llm:firsthandOnly (grounded)", verifiable: true, source: "llm" });
    else out.warnings.push("LLM suggested firsthand-only, but the query does not say so; ignored.");
  }
  if (llm.sinceDate && !out.hardConstraints.some((c) => c.kind === "since")) {
    if (/\b(last|past|since|this year|20\d\d)\b/i.test(rule.rawQuery)) {
      out.hardConstraints.push({ kind: "since", value: llm.sinceDate, text: "llm:sinceDate (grounded)", verifiable: true, source: "llm" });
      out.temporal.since = llm.sinceDate;
    } else out.warnings.push("LLM proposed a time window that the query does not state; ignored.");
  }
  if (llm.onlyInnerCircle && !out.hardConstraints.some((c) => c.kind === "channel")) {
    if (/\bonly\b|\bjust\b/i.test(rule.rawQuery) && /\b(friends|family|circle|people i know)\b/i.test(rule.rawQuery))
      out.hardConstraints.push({ kind: "channel", value: ["inner_circle"], text: "llm:onlyInnerCircle (grounded)", verifiable: true, source: "llm" });
    else out.warnings.push("LLM suggested an inner-circle-only restriction that the query does not state; ignored.");
  }
  if (llm.recencyPreference === "recent") out.temporal.recencyPreference = "recent";
  for (const u of llm.unverifiableConstraints) {
    if (!out.hardConstraints.some((c) => c.kind === "unverifiable" && c.text === u)) out.hardConstraints.push({ kind: "unverifiable", value: u, text: u, verifiable: false, source: "llm" });
  }
  for (const s of llm.softPreferences) if (!out.softPreferences.includes(s)) out.softPreferences.push(s);
  for (const a of llm.ambiguities) if (!out.ambiguities.includes(a)) out.ambiguities.push(a);
  return IntentSchema.parse(out);
}
