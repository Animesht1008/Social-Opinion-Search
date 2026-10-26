/**
 * Small, honest tuning experiment. Parameters are CHOSEN ON THE DEV SPLIT ONLY and then reported on the held-out
 * TEST split. With 33 queries this is a weak protocol (see docs/EVALUATION.md); it exists to avoid tuning on the
 * numbers we report, not to claim optimality.
 *   npm run tune
 */
import { loadConfig } from "../src/config/env.js";
import { createContext } from "../src/context.js";
import { runEvaluation, type EvalConfig } from "../src/modules/evaluation/runner.js";
import { DEFAULT_PARAMS, withWeights, type RankingParams } from "../src/modules/ranking/config.js";

const ctx = await createContext(loadConfig());
const hybrid: EvalConfig = { name: "hybrid", mode: "hybrid", ranking: "relevance_first", group: "modes" };
const semantic: EvalConfig = { name: "semantic", mode: "semantic", ranking: "relevance_first", group: "modes" };
const f = (x: unknown) => (typeof x === "number" ? x.toFixed(3) : "–");

async function score(p: RankingParams, cfg: EvalConfig) {
  const r = await runEvaluation(ctx, { configs: [cfg], params: p, skipLeakSweep: true });
  const c = (r.summary.configs as any)[cfg.name];
  return { dev: c.dev, test: c.test, all: c.all };
}
const withGate = (g: Partial<RankingParams["relevanceGate"]>): RankingParams => ({ ...DEFAULT_PARAMS, relevanceGate: { ...DEFAULT_PARAMS.relevanceGate, ...g } });

try {
  console.log("## Experiment 1 — relevance gate (semantic admission threshold), mode=semantic\n");
  console.log("| semanticMin | dev NDCG@5 | dev correct-abstain | dev false-abstain | test NDCG@5 | test correct-abstain | test false-abstain |\n|---|---|---|---|---|---|---|");
  for (const t of [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
    const s = await score(withGate({ semanticMin: t }), semantic);
    console.log(`| ${t} | ${f(s.dev["NDCG@5"])} | ${f(s.dev["correct abstention (expected-empty queries)"])} | ${f(s.dev["false abstention (answerable queries)"])} | ${f(s.test["NDCG@5"])} | ${f(s.test["correct abstention (expected-empty queries)"])} | ${f(s.test["false abstention (answerable queries)"])} |`);
  }
  console.log("\n## Experiment 2 — hybrid admission (semanticMin x hybridLexicalMin), mode=hybrid\n");
  console.log("| semanticMin | hybridLexicalMin | dev NDCG@5 | dev correct-abstain | dev false-abstain | test NDCG@5 | test correct-abstain | test false-abstain |\n|---|---|---|---|---|---|---|---|");
  for (const t of [0.45, 0.5, 0.55, 0.6, 0.65]) for (const l of [0.1, 0.15, 0.25]) {
    const s = await score(withGate({ semanticMin: t, hybridLexicalMin: l }), hybrid);
    console.log(`| ${t} | ${l} | ${f(s.dev["NDCG@5"])} | ${f(s.dev["correct abstention (expected-empty queries)"])} | ${f(s.dev["false abstention (answerable queries)"])} | ${f(s.test["NDCG@5"])} | ${f(s.test["correct abstention (expected-empty queries)"])} | ${f(s.test["false abstention (answerable queries)"])} |`);
  }
  console.log("\n## Experiment 3 — hybrid weights (gate fixed at default), one factor at a time\n");
  console.log("| variant | dev NDCG@5 | dev P@5 | test NDCG@5 | test P@5 |\n|---|---|---|---|---|");
  const variants: [string, Partial<RankingParams["weights"]>][] = [
    ["default", {}], ["semantic 0.15", { semantic: 0.15 }], ["semantic 0.35", { semantic: 0.35 }], ["semantic 0.45", { semantic: 0.45 }],
    ["aspect 0.10", { aspect: 0.1 }], ["aspect 0.30", { aspect: 0.3 }], ["aspect 0.40", { aspect: 0.4 }],
    ["lexical 0.10", { lexical: 0.1 }], ["lexical 0.30", { lexical: 0.3 }],
    ["freshness 0", { freshness: 0 }], ["freshness 0.02", { freshness: 0.02 }], ["freshness 0.04", { freshness: 0.04 }], ["specificity 0.2", { specificity: 0.2 }],
  ];
  for (const [name, w] of variants) {
    const s = await score(withWeights(DEFAULT_PARAMS, w), hybrid);
    console.log(`| ${name} | ${f(s.dev["NDCG@5"])} | ${f(s.dev["P@5"])} | ${f(s.test["NDCG@5"])} | ${f(s.test["P@5"])} |`);
  }
} finally {
  await ctx.close();
}
