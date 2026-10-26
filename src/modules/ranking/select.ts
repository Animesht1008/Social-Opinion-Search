import { ASPECT_BY_ID, type PolarityLabel } from "../query-understanding/aspects.js";
import type { Intent } from "../query-understanding/intent.js";
import { contentStems, jaccard, round, shingles } from "../../shared/text.js";
import type { RankingParams } from "./config.js";
import type { ScoredCandidate } from "./types.js";

export interface SuppressedDuplicate {
  id: string;
  duplicateOf: string;
  similarity: number;
  explicitRepost: boolean;
  reason: string;
}

export interface AspectBalance {
  aspect: string;
  positive: number;
  negative: number;
  mixed: number;
  neutral: number;
  conflicting: boolean;
  evidenceIds: string[];
}

export interface Selection {
  selected: ScoredCandidate[];
  reasons: Map<string, string>;
  suppressed: SuppressedDuplicate[];
  clusters: string[][];
  aspectBalance: AspectBalance[];
  uncoveredAspects: string[];
  /** Distinct authors among selected firsthand, non-repost, non-duplicate records. Conservative; independence is never proven. */
  independentFirsthandSources: number;
  adequacy: "sufficient" | "limited" | "insufficient";
  adequacyNote: string;
}

class UnionFind {
  private p = new Map<string, string>();
  find(x: string): string {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r)!;
    this.p.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

const hasPos = (p: PolarityLabel) => p === "POSITIVE" || p === "MIXED";
const hasNeg = (p: PolarityLabel) => p === "NEGATIVE" || p === "MIXED";

/**
 * Evidence selection: relevance gate -> duplicate clustering -> MMR diversity -> conflict/negative-evidence balancing.
 * `ranked` must be sorted by finalScore descending.
 */
export function selectEvidence(ranked: ScoredCandidate[], k: number, intent: Intent, P: RankingParams): Selection {
  const S = P.selection;
  const eligible = ranked.filter((c) => c.isRelevant);
  const contentAspects = intent.aspects.filter((a) => !ASPECT_BY_ID.get(a)?.context);

  // ---- 1. duplicate clusters (explicit repost links or near-identical wording) ----
  const sh = new Map(eligible.map((c) => [c.id, shingles(c.record.text)]));
  const uf = new UnionFind();
  const sim = new Map<string, number>();
  const explicit = new Set<string>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let i = 0; i < eligible.length; i++) {
    const a = eligible[i]!;
    uf.find(a.id);
    for (let j = i + 1; j < eligible.length; j++) {
      const b = eligible[j]!;
      const s = jaccard(sh.get(a.id)!, sh.get(b.id)!);
      const rep = a.record.repostOfId === b.id || b.record.repostOfId === a.id;
      if (s >= S.duplicateThreshold || rep) {
        uf.union(a.id, b.id);
        sim.set(key(a.id, b.id), s);
        if (rep) explicit.add(key(a.id, b.id));
      }
    }
  }
  const groups = new Map<string, ScoredCandidate[]>();
  for (const c of eligible) {
    const r = uf.find(c.id);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(c);
  }
  const reps: ScoredCandidate[] = [];
  const suppressed: SuppressedDuplicate[] = [];
  const clusters: string[][] = [];
  for (const g of groups.values()) {
    g.sort((x, y) => y.finalScore - x.finalScore || x.id.localeCompare(y.id));
    const rep = g[0]!;
    reps.push(rep);
    if (g.length > 1) clusters.push(g.map((x) => x.id));
    for (const d of g.slice(1)) {
      const k2 = key(rep.id, d.id);
      const s = sim.get(k2) ?? Math.max(...g.filter((x) => x.id !== d.id).map((x) => sim.get(key(x.id, d.id)) ?? 0));
      const isExplicit = explicit.has(k2) || d.record.repostOfId !== null;
      suppressed.push({
        id: d.id,
        duplicateOf: rep.id,
        similarity: round(s, 3),
        explicitRepost: isExplicit,
        reason: `${isExplicit ? "explicit repost" : "near-duplicate wording"} of ${rep.id} (similarity ${s.toFixed(2)}); collapsed so repeated text is not counted as independent corroboration`,
      });
    }
  }
  reps.sort((x, y) => y.finalScore - x.finalScore || x.id.localeCompare(y.id));

  // ---- 2. MMR diversity selection over cluster representatives ----
  const topScore = reps[0]?.finalScore || 1;
  const uni = new Map(reps.map((c) => [c.id, new Set(contentStems(c.record.text))]));
  const chosen: ScoredCandidate[] = [];
  const reasons = new Map<string, string>();
  const pool = [...reps];
  const redundancy = (c: ScoredCandidate) => (chosen.length ? Math.max(...chosen.map((s) => jaccard(uni.get(c.id)!, uni.get(s.id)!))) : 0);
  while (chosen.length < k && pool.length) {
    let bestIdx = 0, bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      const sameAuthor = chosen.filter((s) => s.record.authorId === c.record.authorId).length;
      const val = S.mmrLambda * (c.finalScore / topScore) - (1 - S.mmrLambda) * redundancy(c) - S.sameAuthorPenalty * sameAuthor;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    const pick = pool.splice(bestIdx, 1)[0]!;
    const red = redundancy(pick);
    pick.components.redundancy = round(red);
    const rank = ranked.findIndex((r) => r.id === pick.id) + 1;
    reasons.set(pick.id, chosen.length === 0 ? `Top relevant result (rank ${rank}, score ${pick.finalScore.toFixed(3)})` : `Selected for relevance and diversity (rank ${rank}, score ${pick.finalScore.toFixed(3)}, max similarity to already-selected evidence ${red.toFixed(2)})`);
    chosen.push(pick);
  }
  for (const c of pool) c.components.redundancy = round(redundancy(c));

  // ---- 3. conflict / negative-evidence balancing (surface disagreement; never penalise polarity) ----
  const polarityOf = (c: ScoredCandidate, a: string): PolarityLabel => c.aspectPolarity.find((x) => x.aspect === a)?.polarity ?? "NEUTRAL";
  let swaps = 0;
  for (const a of contentAspects) {
    for (const want of ["neg", "pos"] as const) {
      if (swaps >= S.maxBalanceSwaps || chosen.length < 2) break;
      const test = want === "neg" ? hasNeg : hasPos;
      const other = want === "neg" ? hasPos : hasNeg;
      const selHasWanted = chosen.some((c) => test(polarityOf(c, a)));
      const selHasOther = chosen.some((c) => other(polarityOf(c, a)));
      if (selHasWanted || !selHasOther) continue; // only act if the selection is one-sided on this aspect
      const cand = pool.find((c) => test(polarityOf(c, a)));
      if (!cand) continue;
      // Replace the lowest-scored selected item whose removal does not drop an aspect's only coverage.
      const removable = [...chosen].reverse().find((c) => {
        const rest = chosen.filter((x) => x.id !== c.id);
        return contentAspects.every((asp) => !chosen.some((x) => x.id === c.id && x.matchedAspects.includes(asp)) || rest.some((x) => x.matchedAspects.includes(asp)));
      });
      if (!removable) continue;
      chosen.splice(chosen.indexOf(removable), 1, cand);
      pool.splice(pool.indexOf(cand), 1);
      reasons.delete(removable.id);
      reasons.set(cand.id, `Included to surface ${want === "neg" ? "negative" : "positive"}/conflicting evidence on "${ASPECT_BY_ID.get(a)?.label ?? a}" (the selection was otherwise one-sided)`);
      swaps++;
    }
  }
  chosen.sort((x, y) => y.finalScore - x.finalScore || x.id.localeCompare(y.id));

  // ---- 4. aspect balance + adequacy ----
  const aspectBalance: AspectBalance[] = contentAspects.map((a) => {
    const ev = chosen.filter((c) => c.matchedAspects.includes(a));
    const pols = ev.map((c) => polarityOf(c, a));
    const positive = pols.filter((p) => p === "POSITIVE").length;
    const negative = pols.filter((p) => p === "NEGATIVE").length;
    const mixed = pols.filter((p) => p === "MIXED").length;
    return { aspect: a, positive, negative, mixed, neutral: pols.length - positive - negative - mixed, conflicting: (positive > 0 && negative > 0) || mixed > 0, evidenceIds: ev.map((c) => c.id) };
  });
  const uncovered = aspectBalance.filter((b) => b.evidenceIds.length === 0).map((b) => b.aspect);
  const independent = new Set(chosen.filter((c) => c.record.firsthand && !c.record.repostOfId).map((c) => c.record.authorId)).size;
  let adequacy: Selection["adequacy"] = "insufficient";
  let note = "No opinion cleared the relevance gate for this query.";
  if (chosen.length > 0) {
    const coveredFrac = contentAspects.length ? (contentAspects.length - uncovered.length) / contentAspects.length : 1;
    if (chosen.length >= 3 && coveredFrac >= 0.5) {
      adequacy = "sufficient";
      note = `${chosen.length} relevant opinions from ${independent} distinct firsthand author(s)${uncovered.length ? `; no evidence found for: ${uncovered.join(", ")}` : ""}.`;
    } else {
      adequacy = "limited";
      note = `Only ${chosen.length} relevant opinion(s)${uncovered.length ? `; no evidence found for: ${uncovered.join(", ")}` : ""}. Treat conclusions as tentative.`;
    }
  }
  return { selected: chosen, reasons, suppressed, clusters, aspectBalance, uncoveredAspects: uncovered, independentFirsthandSources: independent, adequacy, adequacyNote: note };
}
