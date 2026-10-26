export const REL_THRESHOLD = 2; // grade >= 2 counts as relevant for precision / recall
export const STRICT_THRESHOLD = 3;

export function precisionAtK(ranked: string[], grade: (id: string) => number, k: number, threshold = REL_THRESHOLD): number {
  const top = ranked.slice(0, k);
  return top.filter((id) => grade(id) >= threshold).length / k;
}

const gain = (g: number) => 2 ** g - 1;

export function dcgAtK(grades: number[], k: number): number {
  return grades.slice(0, k).reduce((s, g, i) => s + gain(g) / Math.log2(i + 2), 0);
}

/** NDCG@k with exponential gain. `allGrades` are the effective grades of every judged candidate document. */
export function ndcgAtK(ranked: string[], grade: (id: string) => number, allGrades: number[], k: number): number | null {
  const ideal = dcgAtK([...allGrades].sort((a, b) => b - a), k);
  if (ideal === 0) return null; // no relevant documents: undefined
  return dcgAtK(ranked.slice(0, k).map(grade), k) / ideal;
}

export function candidateRecall(candidateIds: string[], relevantIds: string[]): number | null {
  if (relevantIds.length === 0) return null;
  const c = new Set(candidateIds);
  return relevantIds.filter((id) => c.has(id)).length / relevantIds.length;
}

export function aspectCoverage(expected: string[], coveredLabels: string[][]): number | null {
  if (expected.length === 0) return null;
  const covered = new Set(coveredLabels.flat());
  return expected.filter((a) => covered.has(a)).length / expected.length;
}

export function mean(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

/** Fraction of items that have a duplicate partner also present in the list. */
export function duplicateRate(ids: string[], dupGroups: string[][]): number | null {
  if (ids.length === 0) return null;
  const set = new Set(ids);
  let dup = 0;
  for (const id of ids) {
    const g = dupGroups.find((grp) => grp.includes(id));
    if (g && g.some((o) => o !== id && set.has(o))) dup++;
  }
  return dup / ids.length;
}
