/**
 * Rule-based aspect lexicon ("lexicon-v1").
 *
 * IMPORTANT: this is a transparent concept heuristic, NOT semantic search. It is used for
 *  (a) the aspect-coverage ranking signal, (b) polarity/contradiction display, and (c) intent parsing.
 * It is deliberately independent of the manually annotated evaluation judgments (which carry their own aspect labels).
 * Terms are matched on stems (see shared/text.ts). Multi-word entries match consecutive stems.
 */
import { splitSentences, stem, tokenize } from "../../shared/text.js";

export type PolarityLabel = "POSITIVE" | "NEGATIVE" | "MIXED" | "NEUTRAL";

export interface AspectDef {
  id: string;
  label: string;
  /** Mentions of the aspect (any one is enough). */
  terms: string[];
  /** Cues that, near a mention, make the stance favourable / unfavourable for the place. */
  pos: string[];
  neg: string[];
  /** Context aspects (e.g. time of day) are matched but have no polarity. */
  context?: boolean;
}

export const ASPECTS: AspectDef[] = [
  {
    id: "late_night", label: "Late-night context", context: true,
    terms: ["midnight", "late night", "late at night", "after dark", "at night", "night", "nighttime", "11 pm", "12 am", "1 am", "2 am", "3 am", "after 10", "after 11", "after midnight", "past midnight", "late"],
    pos: [], neg: [],
  },
  {
    id: "lighting", label: "Street lighting",
    terms: ["lit", "light", "lighting", "streetlight", "street light", "lamp", "lamp post", "illuminated", "bright", "brightly", "dark", "dim", "dimly", "unlit", "glow"],
    pos: ["well lit", "brightly", "bright", "lamp post", "working streetlight", "illuminated", "lit up", "well lit", "lit"],
    neg: ["dark", "dim", "dimly", "unlit", "poorly lit", "poorly", "one working streetlight", "patches", "no light", "pitch black"],
  },
  {
    id: "activity_isolation", label: "Foot traffic / isolation",
    terms: ["busy", "bustling", "lively", "crowd", "people around", "strolling", "joggers", "open late", "still open", "foot traffic", "isolated", "isolation", "deserted", "empty", "lonely", "no one", "nobody", "hardly anyone", "dead quiet", "dead end", "shutter", "few people", "other people", "alone", "stray dog", "vendor"],
    pos: ["busy", "bustling", "lively", "strolling", "joggers", "still open", "open late", "people around", "vendor", "crowd", "always people"],
    neg: ["isolated", "isolation", "deserted", "empty", "lonely", "no one", "nobody", "hardly anyone", "dead quiet", "dead end", "shutter", "few people", "stray dog", "nearly empty", "alone", "maybe three other people"],
  },
  {
    id: "transport", label: "Transport availability",
    terms: ["taxi", "cab", "uber", "ola", "auto", "rickshaw", "metro", "train", "station", "bus", "transport", "last local", "app cab", "ride", "commute", "airport transfer", "stand"],
    pos: ["available", "always", "plenty", "lined up", "frequent", "close", "reachable", "easy", "short walk", "all night", "every few", "right outside", "minutes"],
    neg: ["cancel", "cancelling", "waited", "wait", "refuse", "closes", "far", "surge", "hardly any", "no public", "stranded", "only cabs", "scarce", "no auto", "never came"],
  },
  {
    id: "police_security", label: "Police / security presence",
    terms: ["police", "security", "guard", "cctv", "patrol", "patrols", "cop", "police van", "secure", "escort", "camera"],
    pos: ["police van", "patrol", "cctv", "guard", "escort", "excellent", "secure", "camera"],
    neg: ["no police", "no security", "absent", "never saw any", "unattended"],
  },
  {
    id: "perceived_safety", label: "Perceived safety",
    terms: ["safe", "unsafe", "secure", "comfortable", "uncomfortable", "scared", "afraid", "worried", "danger", "dangerous", "sketchy", "threatening", "felt safe", "relaxed", "nervous"],
    pos: ["safe", "secure", "comfortable", "relaxed", "no issue", "fine", "without any issue", "no trouble"],
    neg: ["unsafe", "uncomfortable", "scared", "afraid", "worried", "dangerous", "sketchy", "threatening", "nervous", "not safe"],
  },
  {
    id: "harassment_crime", label: "Harassment / petty crime",
    terms: ["catcall", "catcalled", "harass", "harassed", "followed", "stare", "staring", "groped", "snatched", "theft", "stolen", "robbed", "intoxicated", "rowdy", "creepy", "drunk", "scam", "pickpocket"],
    pos: [], neg: ["catcall", "catcalled", "harass", "followed", "stare", "staring", "groped", "snatched", "theft", "stolen", "robbed", "intoxicated", "rowdy", "creepy", "drunk", "scam", "pickpocket"],
  },
  {
    id: "noise", label: "Noise / quiet",
    terms: ["noise", "noisy", "loud", "quiet", "silent", "peaceful", "calm", "music", "honking", "grinder", "hush", "serene", "tranquil", "sleep", "slept", "clatter"],
    pos: ["quiet", "peaceful", "calm", "silent", "serene", "tranquil", "slept well", "slept like", "hushed"],
    neg: ["noisy", "loud", "honking", "couldn't sleep", "could not sleep", "music", "packed until", "clatter", "grinder", "blaring", "din"],
  },
  {
    id: "wifi", label: "Wi-Fi / internet",
    terms: ["wifi", "wi-fi", "wi fi", "internet", "broadband", "mbps", "connection", "video call", "zoom", "call", "bandwidth", "network"],
    pos: ["fast", "stable", "reliable", "solid", "great", "mbps", "smooth", "no drops", "perfect"],
    neg: ["slow", "drops", "dropped", "patchy", "unreliable", "flaky", "disconnect", "disconnecting", "laggy", "kept cutting", "barely"],
  },
  {
    id: "power_outlets", label: "Power outlets",
    terms: ["plug", "socket", "outlet", "charging", "charger", "power point", "power", "extension cord"],
    pos: ["every table", "plenty", "lots", "available", "along the wall", "all along", "each table"],
    neg: ["few", "only two", "scarce", "no socket", "no plug", "hardly", "none", "dead battery", "no outlet"],
  },
  {
    id: "work_friendly", label: "Laptop / remote-work friendliness",
    terms: ["laptop", "work from", "remote", "working", "all day", "two hours", "time limit", "asked us to leave", "freelance", "cowork", "co-work", "study", "studying", "desk"],
    pos: ["welcome", "no one minded", "stay all day", "all day", "friendly to", "nobody minded", "regulars work", "encourage"],
    neg: ["kicked", "asked us to leave", "no laptop", "time limit", "not welcome", "rushed", "two hour", "turnover", "frown"],
  },
  {
    id: "seating", label: "Seating / space",
    terms: ["seating", "seat", "table", "chair", "sofa", "space", "spacious", "cramped", "stool", "bench", "booth", "elbow room", "tiny"],
    pos: ["spacious", "comfortable", "ample", "big tables", "roomy", "plenty of seating", "sofa", "large"],
    neg: ["cramped", "tiny", "uncomfortable", "stool", "packed", "no seat", "elbow", "standing"],
  },
  {
    id: "price", label: "Price / value",
    terms: ["price", "priced", "pricey", "expensive", "cheap", "affordable", "overpriced", "cost", "budget", "value", "rupee", "₹", "pay", "bill", "steep", "reasonable"],
    pos: ["cheap", "affordable", "reasonable", "value", "budget friendly", "fair price", "worth"],
    neg: ["expensive", "overpriced", "pricey", "steep", "rip off", "ripoff", "not worth", "costly"],
  },
  {
    id: "food_quality", label: "Food quality",
    terms: ["food", "taste", "tasty", "delicious", "flavour", "flavor", "dish", "thali", "curry", "breakfast", "menu", "meal", "bland", "fresh", "paneer", "dal", "kachori", "sweets", "coffee", "chai", "pastry", "brunch"],
    pos: ["delicious", "tasty", "fresh", "amazing", "authentic", "great", "flavourful", "flavorful", "best", "excellent", "spread", "rich"],
    neg: ["bland", "stale", "oily", "cold", "disappointing", "mediocre", "overcooked", "tasteless", "greasy", "average"],
  },
  {
    id: "vegetarian", label: "Vegetarian options",
    terms: ["vegetarian", "veg", "vegan", "jain", "pure veg", "plant based", "meatless", "no meat", "non veg", "non vegetarian", "egg"],
    pos: ["pure veg", "plenty of veg", "separate kitchen", "vegetarian friendly", "all vegetarian", "jain options", "fully vegetarian", "vegan options", "completely vegetarian"],
    neg: ["only meat", "few veg", "limited veg", "cooked with", "same grill", "not vegetarian", "few vegetarian", "meat heavy", "little for vegetarians"],
  },
  {
    id: "hygiene", label: "Cleanliness / hygiene",
    terms: ["clean", "dirty", "hygiene", "hygienic", "spotless", "filthy", "cockroach", "sanitary", "washroom", "restroom", "smelly", "stained", "dust"],
    pos: ["clean", "spotless", "hygienic", "immaculate", "tidy"],
    neg: ["dirty", "filthy", "cockroach", "smelly", "stained", "unhygienic", "dust", "flies"],
  },
  {
    id: "service", label: "Service / staff",
    terms: ["staff", "service", "waiter", "receptionist", "owner", "host", "friendly", "rude", "helpful", "attentive", "manager", "server"],
    pos: ["friendly", "helpful", "attentive", "polite", "courteous", "warm", "welcoming", "prompt"],
    neg: ["rude", "slow", "ignored", "dismissive", "inattentive", "indifferent", "careless"],
  },
  {
    id: "beach_access", label: "Beach access",
    terms: ["beach", "shore", "seafront", "sea view", "sand", "walk to the beach", "waves", "coast"],
    pos: ["steps from", "minutes walk", "right on", "close to the beach", "short walk", "empty beach", "clean beach", "beachfront"],
    neg: ["far from the beach", "rocky", "polluted", "garbage", "crowded beach", "no beach"],
  },
  {
    id: "nightlife", label: "Nightlife / party scene",
    terms: ["bar", "club", "nightlife", "party", "parties", "dj", "pub", "rave", "shack", "happy hour"],
    pos: ["vibrant", "fun", "great nightlife", "buzzing", "lively"],
    neg: ["loud", "rowdy", "drunk", "overcrowded", "tourist trap", "blaring"],
  },
  {
    id: "walkability", label: "Walkability",
    terms: ["walk", "walkable", "walking", "pedestrian", "footpath", "pavement", "sidewalk", "stroll", "on foot"],
    pos: ["walkable", "easy to walk", "shaded", "pedestrian friendly", "short walk", "pleasant walk", "wide pavement"],
    neg: ["no footpath", "broken pavement", "no sidewalk", "hard to walk", "traffic", "uneven", "dodging"],
  },
  {
    id: "airport_access", label: "Airport access",
    terms: ["airport", "flight", "terminal", "aerocity", "early flight", "airport express"],
    pos: ["close to the airport", "minutes from the airport", "quick", "direct", "airport express", "ten minutes", "twenty minutes"],
    neg: ["far from the airport", "traffic", "jam", "long ride", "hour to the airport", "stuck"],
  },
];

export const ASPECT_IDS = ASPECTS.map((a) => a.id);
export const ASPECT_BY_ID = new Map(ASPECTS.map((a) => [a.id, a]));

// ----- matching helpers -----
const stemPhrase = (p: string): string[] => tokenize(p).map(stem);

interface CompiledAspect {
  def: AspectDef;
  terms: string[][];
  pos: string[][];
  neg: string[][];
}
const COMPILED: CompiledAspect[] = ASPECTS.map((def) => ({
  def,
  terms: def.terms.map(stemPhrase),
  pos: def.pos.map(stemPhrase),
  neg: def.neg.map(stemPhrase),
}));

/** Find positions in `stems` where phrase occurs as consecutive tokens. */
function findPhrase(stems: string[], phrase: string[]): number[] {
  if (phrase.length === 0) return [];
  const hits: number[] = [];
  for (let i = 0; i <= stems.length - phrase.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) if (stems[i + j] !== phrase[j]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  return hits;
}

const NEGATORS = new Set(["not", "no", "never", "without", "nor", "neither", "hardly"].map(stem));
const GLOBAL_POS = ["great", "good", "excellent", "amazing", "lovely", "wonderful", "perfect", "fine"].map(stem);
const GLOBAL_NEG = ["bad", "terrible", "awful", "poor", "horrible", "worst", "disappointing", "avoid"].map(stem);

function negated(stems: string[], pos: number): boolean {
  for (let k = Math.max(0, pos - 3); k < pos; k++) if (NEGATORS.has(stems[k] as string)) return true;
  return false;
}

export interface ExtractedAspect {
  aspect: string;
  polarity: PolarityLabel;
  matchedTerms: string[];
}

/** Extract aspects + sentence-level polarity. Crude by design; see docs/LIMITATIONS.md. */
export function extractAspects(text: string): ExtractedAspect[] {
  const sentences = splitSentences(text).map((s) => stemTokens2(s));
  const out: ExtractedAspect[] = [];
  for (const ca of COMPILED) {
    const matched = new Set<string>();
    let posSentences = 0;
    let negSentences = 0;
    let mentioned = false;
    for (const st of sentences) {
      let mention = false;
      for (const t of ca.terms) {
        if (findPhrase(st, t).length) { mention = true; matched.add(t.join(" ")); }
      }
      if (!mention) continue;
      mentioned = true;
      if (ca.def.context) continue;
      let pos = 0, neg = 0;
      for (const p of ca.pos) for (const idx of findPhrase(st, p)) negated(st, idx) ? neg++ : pos++;
      for (const n of ca.neg) for (const idx of findPhrase(st, n)) negated(st, idx) ? pos++ : neg++;
      if (pos === 0 && neg === 0) {
        for (const g of GLOBAL_POS) for (const idx of findPhrase(st, [g])) negated(st, idx) ? neg++ : pos++;
        for (const g of GLOBAL_NEG) for (const idx of findPhrase(st, [g])) negated(st, idx) ? pos++ : neg++;
      }
      if (pos > neg) posSentences++;
      else if (neg > pos) negSentences++;
      else if (pos > 0 && pos === neg) { posSentences++; negSentences++; }
    }
    if (!mentioned) continue;
    let polarity: PolarityLabel = "NEUTRAL";
    if (!ca.def.context) {
      if (posSentences && negSentences) polarity = "MIXED";
      else if (posSentences) polarity = "POSITIVE";
      else if (negSentences) polarity = "NEGATIVE";
    }
    out.push({ aspect: ca.def.id, polarity, matchedTerms: [...matched].sort() });
  }
  return out;
}

function stemTokens2(s: string): string[] {
  return tokenize(s).map(stem);
}

/** Aspects mentioned in a *query* (no polarity). */
export function aspectsInQuery(text: string): string[] {
  const st = tokenize(text).map(stem);
  const ids: string[] = [];
  for (const ca of COMPILED) {
    if (ca.terms.some((t) => findPhrase(st, t).length)) ids.push(ca.def.id);
  }
  return ids;
}

/** Overall stance over a set of aspects: MIXED if both positive and negative signals exist. */
export function overallPolarity(aspects: { aspect: string; polarity: PolarityLabel }[], only?: string[]): PolarityLabel {
  const rel = aspects.filter((a) => !ASPECT_BY_ID.get(a.aspect)?.context && (!only || only.includes(a.aspect)));
  const pos = rel.some((a) => a.polarity === "POSITIVE" || a.polarity === "MIXED");
  const neg = rel.some((a) => a.polarity === "NEGATIVE" || a.polarity === "MIXED");
  if (pos && neg) return "MIXED";
  if (pos) return "POSITIVE";
  if (neg) return "NEGATIVE";
  return "NEUTRAL";
}
