import { randomUUID } from "node:crypto";
import type { AppContext } from "../../context.js";
import { getEmbeddingStatus, hiddenDataSources } from "../../context.js";
import { Prisma } from "../../db/client.js";
import { DEFAULT_PARAMS, withWeights, type RankingParams, type RankingWeights } from "../ranking/config.js";
import { runSearch, type SearchRequest } from "../search/search-service.js";
import { loadEvalData, DUPLICATE_GROUPS, type EvalQueryRow } from "./data.js";
import { aspectCoverage, candidateRecall, duplicateRate, mean, ndcgAtK, percentile, precisionAtK, REL_THRESHOLD, STRICT_THRESHOLD } from "./metrics.js";

/** The benchmark's relevance judgments cover the synthetic corpus only; 
imported datasets and user posts are excluded so they cannot be unfairly counted as "irrelevant". */
export const EVAL_CORPUS = "synthetic-seed-v1";

/** Pinned so freshness scores and relative time windows are reproducible. */
export const EVAL_REFERENCE_DATE = "2026-10-20T00:00:00Z";
const K = 5;

export interface EvalConfig {
  name: string;
  mode: "lexical" | "semantic" | "hybrid";
  ranking: "relevance_first" | "social_aware";
  weights?: Partial<RankingWeights>;
  params?: RankingParams;
  group: "modes" | "ablation";
}

export const CORE_CONFIGS: EvalConfig[] = [
  { name: "lexical", mode: "lexical", ranking: "relevance_first", group: "modes" },
  { name: "semantic", mode: "semantic", ranking: "relevance_first", group: "modes" },
  { name: "hybrid (relevance-first)", mode: "hybrid", ranking: "relevance_first", group: "modes" },
  { name: "hybrid (social-aware)", mode: "hybrid", ranking: "social_aware", group: "modes" },
];
export const ABLATIONS: EvalConfig[] = [
  { name: "hybrid − aspect", mode: "hybrid", ranking: "relevance_first", weights: { aspect: 0 }, group: "ablation" },
  { name: "hybrid − context", mode: "hybrid", ranking: "relevance_first", weights: { context: 0 }, group: "ablation" },
  { name: "hybrid − specificity", mode: "hybrid", ranking: "relevance_first", weights: { specificity: 0 }, group: "ablation" },
  { name: "hybrid − provenance", mode: "hybrid", ranking: "relevance_first", weights: { provenance: 0 }, group: "ablation" },
  { name: "hybrid − freshness", mode: "hybrid", ranking: "relevance_first", weights: { freshness: 0 }, group: "ablation" },
  { name: "hybrid: lexical+semantic only", mode: "hybrid", ranking: "relevance_first", weights: { aspect: 0, context: 0, specificity: 0, provenance: 0, freshness: 0 }, group: "ablation" },
  { name: "hybrid: lexical+aspect only", mode: "hybrid", ranking: "relevance_first", weights: { semantic: 0, context: 0, specificity: 0, provenance: 0, freshness: 0 }, group: "ablation" },
];

/** Independent re-implementation of the visibility rules straight from raw relationship rows (not the production code path). */
export function oracleCanView(requester: string, o: { authorId: string; visibility: string; provenanceSource?: string }, rels: { requesterId: string; addresseeId: string; status: string; type: string; closeness: number }[], rule: { types: string[]; min: number }, hiddenSources: string[] = []): boolean {
  if (o.authorId === requester) return false;
  if (o.provenanceSource && hiddenSources.includes(o.provenanceSource)) return false;
  const between = rels.filter((r) => (r.requesterId === requester && r.addresseeId === o.authorId) || (r.requesterId === o.authorId && r.addresseeId === requester));
  if (between.some((r) => r.status === "BLOCKED")) return false;
  const accepted = between.find((r) => r.status === "ACCEPTED");
  if (o.visibility === "PUBLIC") return true;
  if (o.visibility === "CONNECTIONS") return !!accepted;
  if (o.visibility === "INNER_CIRCLE") return !!accepted && rule.types.includes(accepted.type) && accepted.closeness >= rule.min;
  return false;
}

export interface QueryResult {
  queryId: string;
  split: string;
  tags: string[];
  config: string;
  effectiveMode: string;
  intent: { city: string | null; aspects: string[]; constraints: string[]; keywords: string[] };
  ranked: { id: string; grade: number }[];
  selected: { id: string; grade: number; channel: string }[];
  abstained: boolean;
  expectInsufficient: boolean;
  metrics: {
    p5: number | null; p5Strict: number | null; ndcg5: number | null; recall: number | null;
    selP5: number | null; selNdcg5: number | null; aspectCoverage: number | null;
    constraintSatisfaction: number | null; constraintViolations: number; leaks: number;
    duplicateRateTop5: number | null; duplicateRateSelected: number | null; innerShareSelected: number | null;
    retrievalMs: number; totalMs: number;
  };
}

function satisfies(o: { city: string; writtenAt: Date; firsthand: boolean; authorId: string }, hc: EvalQueryRow["hardConstraints"], innerIds: string[]): boolean {
  if (hc.city && o.city.toLowerCase() !== hc.city.toLowerCase()) return false;
  if (hc.firsthandOnly && !o.firsthand) return false;
  if (hc.since && o.writtenAt < new Date(hc.since + "T00:00:00Z")) return false;
  if (hc.channels?.includes("inner_circle") && hc.channels.length === 1 && !innerIds.includes(o.authorId)) return false;
  return true;
}

export interface EvalRunOutput {
  id: string;
  summary: any;
  perQuery: QueryResult[];
}

export async function runEvaluation(baseCtx: AppContext, opts: { persist?: boolean; configs?: EvalConfig[]; includeAblations?: boolean; params?: RankingParams; skipLeakSweep?: boolean } = {}): Promise<EvalRunOutput> {
  // Reproducible context: pinned clock, no LLM (rule-based intent parser), no web.
  const ctx: AppContext = { ...baseCtx, llm: null, web: null, now: () => new Date(EVAL_REFERENCE_DATE) };
  const baseParams = opts.params ?? ctx.params ?? DEFAULT_PARAMS;
  const { queries, aspectLabels } = await loadEvalData(ctx.db);
  const embRaw = await getEmbeddingStatus(ctx);
  // Test-only feature-hash vectors are lexical overlap in disguise: never report them as semantic retrieval metrics.
  const emb = embRaw.kind === "test-only" ? { ...embRaw, semanticAvailable: false, reason: "Embedding provider is TEST-ONLY (feature hashing); semantic metrics are not computed." } : embRaw;
  const rels = await ctx.db.relationship.findMany();
  const ops = await ctx.db.opinion.findMany({ select: { id: true, authorId: true, visibility: true, city: true, writtenAt: true, firsthand: true, provenanceSource: true } });
  const opById = new Map(ops.map((o) => [o.id, o]));
  const rule = { types: ctx.circleRule.types, min: ctx.circleRule.minCloseness };
  const hidden = await hiddenDataSources(ctx);
  const configs = opts.configs ?? [...CORE_CONFIGS, ...(opts.includeAblations === false ? [] : ABLATIONS)];

  const results: QueryResult[] = [];
  const unavailable: Record<string, string> = {};
  for (const cfg of configs) {
    if ((cfg.mode === "semantic" || cfg.mode === "hybrid") && !emb.semanticAvailable) {
      unavailable[cfg.name] = `UNAVAILABLE: ${emb.reason}`;
      continue;
    }
    const params = cfg.params ?? (cfg.weights ? withWeights(baseParams, cfg.weights) : baseParams);
    for (const q of queries) {
      const innerIds = (await import("../social-access/access.js")).buildAccessContext(q.requesterId, rels, ctx.circleRule).innerCircleIds;
      const req: SearchRequest = { query: q.query, mode: cfg.mode, ranking: cfg.ranking, limit: K, generateAnswer: false, includeWeb: false, allowFallback: false, candidatePool: 50, filters: { dataSources: [EVAL_CORPUS] } };
      const { response, internals } = await runSearch(ctx, q.requesterId, req, { persist: false, params });

      // Effective grade: judged grade, zeroed if the doc is unauthorized or violates the annotated hard constraints.
      const eff = (id: string): number => {
        const o = opById.get(id);
        if (!o) return 0;
        if (!oracleCanView(q.requesterId, o, rels, rule, hidden)) return 0;
        if (!satisfies(o, q.hardConstraints, innerIds)) return 0;
        return q.grades.get(id) ?? 0;
      };
      const allEff = [...q.grades.keys()].map(eff);
      const relevantIds = [...q.grades.keys()].filter((id) => eff(id) >= REL_THRESHOLD);
      const rankedIds = internals.ranked.map((c) => c.id);
      const selIds = internals.selection.selected.map((c) => c.id);
      const rawIds = internals.retrieval.candidates.map((c) => c.id);
      const leaks = [...new Set([...rawIds, ...rankedIds, ...selIds])].filter((id) => { const o = opById.get(id); return !o || !oracleCanView(q.requesterId, o, rels, rule, hidden); }).length;
      const hcActive = Object.keys(q.hardConstraints).length > 0;
      const violations = hcActive ? selIds.filter((id) => !satisfies(opById.get(id)!, q.hardConstraints, innerIds)).length : 0;
      const noRel = relevantIds.length === 0;
      const selGood = selIds.filter((id) => eff(id) >= REL_THRESHOLD);

      results.push({
        queryId: q.id, split: q.split, tags: q.tags, config: cfg.name, effectiveMode: response.retrieval.effectiveMode,
        intent: { city: internals.intent.location.city, aspects: internals.intent.aspects, constraints: internals.intent.hardConstraints.map((c) => `${c.kind}${c.verifiable ? "" : "(unverifiable)"}=${JSON.stringify(c.value)}`), keywords: internals.intent.keywords },
        ranked: rankedIds.slice(0, 10).map((id) => ({ id, grade: eff(id) })),
        selected: internals.selection.selected.map((c) => ({ id: c.id, grade: eff(c.id), channel: c.channel })),
        abstained: selIds.length === 0,
        expectInsufficient: q.expectInsufficient,
        metrics: {
          p5: noRel ? null : precisionAtK(rankedIds, eff, K),
          p5Strict: noRel ? null : precisionAtK(rankedIds, eff, K, STRICT_THRESHOLD),
          ndcg5: ndcgAtK(rankedIds, eff, allEff, K),
          recall: candidateRecall(rawIds, relevantIds),
          selP5: noRel ? null : precisionAtK(selIds, eff, K),
          selNdcg5: ndcgAtK(selIds, eff, allEff, K),
          aspectCoverage: aspectCoverage(q.expectedAspects, selGood.map((id) => aspectLabels[id] ?? [])),
          constraintSatisfaction: hcActive && selIds.length ? 1 - violations / selIds.length : null,
          constraintViolations: violations,
          leaks,
          duplicateRateTop5: duplicateRate(rankedIds.slice(0, K), DUPLICATE_GROUPS),
          duplicateRateSelected: duplicateRate(selIds, DUPLICATE_GROUPS),
          innerShareSelected: selIds.length ? internals.selection.selected.filter((c) => c.channel === "inner_circle").length / selIds.length : null,
          retrievalMs: Object.values(response.latencyMs.retrieval as Record<string, number>).reduce((s, x) => s + x, 0),
          totalMs: response.latencyMs.total,
        },
      });
    }
  }

  const summarize = (rows: QueryResult[]) => {
    const m = (f: (r: QueryResult) => number | null) => mean(rows.map(f));
    const withRel = rows.filter((r) => !r.expectInsufficient);
    const abst = rows.filter((r) => r.expectInsufficient);
    const ret = rows.map((r) => r.metrics.retrievalMs);
    return {
      queries: rows.length,
      "P@5": m((r) => r.metrics.p5), "P@5 strict (grade 3)": m((r) => r.metrics.p5Strict), "NDCG@5": m((r) => r.metrics.ndcg5),
      "candidate recall": m((r) => r.metrics.recall),
      "selected P@5": m((r) => r.metrics.selP5), "selected NDCG@5": m((r) => r.metrics.selNdcg5),
      "aspect coverage": m((r) => r.metrics.aspectCoverage), "hard-constraint satisfaction": m((r) => r.metrics.constraintSatisfaction),
      "constraint violations": rows.reduce((s, r) => s + r.metrics.constraintViolations, 0), "unauthorized leaks": rows.reduce((s, r) => s + r.metrics.leaks, 0),
      "duplicate rate top-5": m((r) => r.metrics.duplicateRateTop5), "duplicate rate selected": m((r) => r.metrics.duplicateRateSelected),
      "inner-circle share (selected)": m((r) => r.metrics.innerShareSelected),
      "correct abstention (expected-empty queries)": abst.length ? abst.filter((r) => r.abstained).length / abst.length : null,
      "false abstention (answerable queries)": withRel.length ? withRel.filter((r) => r.abstained).length / withRel.length : null,
      "retrieval ms (median)": percentile(ret, 50), "retrieval ms (p95)": percentile(ret, 95),
    };
  };
  const byConfig: Record<string, any> = {};
  for (const cfg of configs) {
    if (unavailable[cfg.name]) { byConfig[cfg.name] = { unavailable: unavailable[cfg.name] }; continue; }
    const rows = results.filter((r) => r.config === cfg.name);
    byConfig[cfg.name] = { group: cfg.group, all: summarize(rows), dev: summarize(rows.filter((r) => r.split === "dev")), test: summarize(rows.filter((r) => r.split === "test")) };
  }

  // Leak sweep: every requester x every query text x every available retrieval path.
  let sweepRuns = 0, sweepLeaks = 0;
  const requesters = ["u_riya", "u_aman", "u_zoya"];
  const sweepModes: ("lexical" | "semantic" | "hybrid")[] = emb.semanticAvailable ? ["lexical", "semantic", "hybrid"] : ["lexical"];
  for (const mode of opts.skipLeakSweep ? [] : sweepModes) {
    for (const ranking of ["relevance_first", "social_aware"] as const) {
      for (const who of requesters) {
        for (const q of queries) {
          const { internals } = await runSearch(ctx, who, { query: q.query, mode, ranking, limit: 8, generateAnswer: false, includeWeb: false, allowFallback: false, candidatePool: 100 }, { persist: false });
          sweepRuns++;
          for (const c of internals.retrieval.candidates) { const o = opById.get(c.id); if (!o || !oracleCanView(who, o, rels, rule, hidden)) sweepLeaks++; }
        }
      }
    }
  }

  const summary = {
    referenceDate: EVAL_REFERENCE_DATE, k: K, queryCount: queries.length, judgmentCount: queries.reduce((s, q) => s + q.grades.size, 0),
    relevanceThreshold: `grade >= ${REL_THRESHOLD} (0-3 scale)`,
    embedding: { available: emb.semanticAvailable, modelKey: emb.modelKey, kind: emb.kind, reason: emb.reason },
    unavailable, configs: byConfig, leakSweep: { searches: sweepRuns, unauthorizedCandidates: sweepLeaks },
    rankingParams: baseParams,
  };
  const id = randomUUID();
  if (opts.persist) {
    await ctx.db.evaluationRun.create({ data: { id, config: { configs: configs.map((c) => c.name), k: K } as Prisma.InputJsonValue, summary: summary as unknown as Prisma.InputJsonValue, perQuery: results as unknown as Prisma.InputJsonValue } });
  }
  return { id, summary, perQuery: results };
}
