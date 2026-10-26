import { ASPECT_BY_ID } from "../query-understanding/aspects.js";
import type { Intent } from "../query-understanding/intent.js";
import { channelOf, type AccessContext } from "../social-access/access.js";
import type { OpinionRecord, RankingMode, RawCandidate, RetrievalMode } from "../retrieval/types.js";
import { clamp, contentStems, round, tokenize, stem, STOPWORDS } from "../../shared/text.js";
import type { RankingParams } from "./config.js";
import type { ComponentScores, ScoredCandidate } from "./types.js";

const DAY = 86400000;

export function contextScore(o: OpinionRecord, intent: Intent): number {
  const city = intent.location.city ? (o.city.toLowerCase() === intent.location.city.toLowerCase() ? 1 : 0) : 0.5;
  const category = intent.topic ? (o.category === intent.topic ? 1 : 0.2) : 0.5;
  const hood = intent.location.neighborhood ? (o.neighborhood?.toLowerCase() === intent.location.neighborhood.toLowerCase() ? 1 : 0.4) : 0.5;
  return round((city + category + hood) / 3);
}

/** Heuristic evidence specificity: concrete cues in the text plus a firsthand bonus. Not a validated quality model. */
export function specificityScore(o: OpinionRecord): number {
  const t = o.text;
  const cues = [
    /\b(\d{1,2}(:\d{2})?\s?(am|pm)|\d+\s?(minutes?|mins?|hours?|nights?|days?|km|m)\b|midnight)/i.test(t),
    /(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}/.test(t.replace(/^\s*[A-Z]/, "x")),
    /\b(i|we|my|our)\b[^.]*\b(stayed|walked|took|waited|came back|returned|got|saw|counted|felt|asked|had|booked|tried|ordered)\b/i.test(t),
    t.split(/\s+/).length >= 25,
    o.aspects.filter((a) => !ASPECT_BY_ID.get(a.aspect)?.context).length >= 2,
  ];
  const detail = cues.filter(Boolean).length / cues.length;
  return round(0.7 * detail + 0.3 * (o.firsthand ? 1 : 0));
}

/** Trust in the source record (attribution / independence), deliberately separate from topical relevance. */
export function provenanceScore(o: OpinionRecord): number {
  if (o.repostOfId) return 0.3; // explicit repost: not independent evidence
  if (!o.provenanceSource) return 0.5;
  return o.sourceType === "SOCIAL_USER" ? 1 : 0.8;
}

export function freshnessScore(o: OpinionRecord, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - o.writtenAt.getTime()) / DAY);
  return round(Math.pow(0.5, ageDays / halfLifeDays));
}

export function aspectScore(o: OpinionRecord, intent: Intent): { score: number | null; matched: string[] } {
  if (intent.aspects.length === 0) return { score: null, matched: [] };
  const have = new Set(o.aspects.map((a) => a.aspect));
  const matched = intent.aspects.filter((a) => have.has(a));
  return { score: round(matched.length / intent.aspects.length), matched };
}

const smoothstep = (x: number) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};

export function socialStrength(ctx: AccessContext, authorId: string): number {
  const c = ctx.closeness[authorId];
  if (!c) return 0;
  return ctx.innerCircleIds.includes(authorId) ? c / 5 : (0.4 * c) / 5;
}

export interface RankArgs {
  records: Map<string, OpinionRecord>;
  raw: RawCandidate[];
  intent: Intent;
  ctx: AccessContext;
  mode: RetrievalMode; // effective mode
  ranking: RankingMode;
  params: RankingParams;
  now: Date;
}

export function rankCandidates(a: RankArgs): ScoredCandidate[] {
  const { params: P, intent } = a;
  const recent = intent.temporal.recencyPreference === "recent";
  const w = { ...P.weights };
  if (recent) w.freshness *= P.recencyWeightMultiplier;
  const half = recent ? P.freshnessHalfLifeDays / 2 : P.freshnessHalfLifeDays;
  const contentAspects = intent.aspects.filter((x) => !ASPECT_BY_ID.get(x)?.context);
  const kwStems = [...new Set(intent.keywords.map((k) => stem(k)))];

  const out: ScoredCandidate[] = [];
  for (const raw of a.raw) {
    const o = a.records.get(raw.id);
    if (!o) continue; // not hydrated => failed authorization re-check; never ranked
    const asp = aspectScore(o, intent);
    const comps: ComponentScores = {
      lexical: raw.lexical === null ? null : round(raw.lexical),
      semantic: raw.semantic === null ? null : round(raw.semantic),
      aspect: asp.score,
      context: contextScore(o, intent),
      specificity: specificityScore(o),
      provenance: provenanceScore(o),
      freshness: freshnessScore(o, a.now, half),
      social: 0,
      redundancy: 0,
    };
    const lexV = comps.lexical ?? 0;
    const semV = Math.max(0, comps.semantic ?? 0);

    // --- relevance score by mode ---
    let relevance: number;
    if (a.mode === "lexical") relevance = lexV;
    else if (a.mode === "semantic") relevance = semV;
    else {
      const parts: [number, number][] = [
        [w.lexical, lexV],
        [w.aspect, comps.aspect ?? 0],
        [w.context, comps.context],
        [w.specificity, comps.specificity],
        [w.provenance, comps.provenance],
        [w.freshness, comps.freshness],
      ];
      // Semantic joins only if embeddings exist; the aspect weight drops out when the query has no aspects.
      let active = parts;
      if (comps.aspect === null) active = active.filter((p) => p[0] !== w.aspect);
      if (raw.semantic !== null) active = [...active, [w.semantic, semV]];
      const wsum = active.reduce((s, p) => s + p[0], 0) || 1;
      relevance = active.reduce((s, p) => s + p[0] * p[1], 0) / wsum;
    }

    // --- optional social-aware boost, gated by content relevance ---
    const channel = channelOf(a.ctx, o.authorId);
    let social = 0;
    const explanation: string[] = [];
    if (a.ranking === "social_aware") {
      const contentParts = [raw.lexical !== null ? lexV : null, raw.semantic !== null ? semV : null, comps.aspect].filter((x): x is number => x !== null);
      const contentRel = contentParts.length ? contentParts.reduce((s, x) => s + x, 0) / contentParts.length : 0;
      const gate = smoothstep((contentRel - P.socialGate.low) / (P.socialGate.high - P.socialGate.low));
      const strength = socialStrength(a.ctx, o.authorId);
      social = round(P.weights.social * strength * gate);
      if (strength > 0) explanation.push(`social context: ${channel === "inner_circle" ? "inner-circle" : "connection"} (closeness ${a.ctx.closeness[o.authorId]}), strength ${strength.toFixed(2)} × relevance gate ${gate.toFixed(2)} → +${social.toFixed(3)}`);
    }
    comps.social = social;

    // --- relevance gate (is this opinion eligible as evidence at all?) ---
    const G = P.relevanceGate;
    const matchedKeywords = kwStems.length ? kwStems.filter((k) => contentStems(o.text).includes(k)) : [];
    const matchedContentAspects = asp.matched.filter((x) => !ASPECT_BY_ID.get(x)?.context);
    const explicitCityAndTopicMatch = !!intent.location.city &&
      o.city.toLowerCase() === intent.location.city.toLowerCase() &&
      intent.topic === o.category;
    const contextualSemanticMin = G.semanticMin * 0.85;
    const byContext = explicitCityAndTopicMatch && raw.semantic !== null && semV >= contextualSemanticMin;
    let isRelevant = false;
    let reason = "";
    if (a.mode === "lexical") {
      isRelevant = lexV >= G.lexicalMin;
      reason = isRelevant ? `lexical match ${lexV.toFixed(3)} ≥ ${G.lexicalMin}` : `lexical score ${lexV.toFixed(3)} below ${G.lexicalMin}`;
    } else if (a.mode === "semantic") {
      isRelevant = semV >= G.semanticMin || byContext;
      reason = semV >= G.semanticMin
        ? `cosine ${semV.toFixed(3)} ≥ ${G.semanticMin}`
        : byContext
          ? `contextual semantic match ${semV.toFixed(3)} ≥ ${contextualSemanticMin.toFixed(3)} with explicit city and topic: ${intent.location.city} / ${intent.topic}`
          : `cosine ${semV.toFixed(3)} below ${G.semanticMin}`;
    } else {
      const byAspect = matchedContentAspects.length >= G.minContentAspects && contentAspects.length > 0;
      const bySem = raw.semantic !== null && semV >= G.semanticMin;
      const byLex = lexV >= G.hybridLexicalMin;
      isRelevant = byAspect || bySem || byLex || byContext;
      reason = [
        byAspect && `aspects matched: ${matchedContentAspects.join(", ")}`,
        bySem && `cosine ${semV.toFixed(2)} ≥ ${G.semanticMin}`,
        byLex && `lexical ${lexV.toFixed(2)} ≥ ${G.hybridLexicalMin}`,
        byContext && `contextual semantic match ${semV.toFixed(3)} ≥ ${contextualSemanticMin.toFixed(3)} with explicit city and topic: ${intent.location.city} / ${intent.topic}`,
      ].filter(Boolean).join("; ") || "no relevance signal cleared its threshold";
    }

    // --- human-readable explanation ---
    if (raw.lexical !== null) explanation.unshift(`lexical (PostgreSQL FTS) ${lexV.toFixed(3)}${matchedKeywords.length ? ` — matched terms: ${matchedKeywords.join(", ")}` : ""}`);
    if (raw.semantic !== null) explanation.push(`semantic cosine ${(comps.semantic ?? 0).toFixed(3)}`);
    if (asp.score !== null) explanation.push(`aspect coverage ${asp.matched.length}/${intent.aspects.length}${asp.matched.length ? ` (${asp.matched.join(", ")})` : ""} [lexicon heuristic]`);
    explanation.push(o.firsthand ? "firsthand report" : "secondhand / not marked firsthand");
    if (o.repostOfId) explanation.push(`explicit repost of ${o.repostOfId} — low provenance weight`);

    const finalScore = round(relevance + social);
    out.push({
      id: o.id,
      record: o,
      raw,
      channel,
      components: comps,
      relevanceScore: round(relevance),
      finalScore,
      isRelevant,
      relevanceReason: reason,
      matchedKeywords,
      matchedAspects: asp.matched,
      aspectPolarity: intent.aspects.filter((x) => !ASPECT_BY_ID.get(x)?.context).map((x) => ({ aspect: x, polarity: o.aspects.find((y) => y.aspect === x)?.polarity ?? "NEUTRAL" })),
      explanation,
    });
  }
  out.sort((x, y) => y.finalScore - x.finalScore || x.id.localeCompare(y.id));
  return out;
}

// Re-exported so callers do not need to know where tokenisation lives.
export { tokenize, STOPWORDS };
