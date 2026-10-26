import type { QueryResult } from "./runner.js";

const f = (x: unknown, d = 3) => (typeof x === "number" ? x.toFixed(d) : x === null || x === undefined ? "–" : String(x));

export function renderMarkdown(summary: any, perQuery: QueryResult[]): string {
  const out: string[] = [];
  out.push(`# Evaluation report`, ``, `- Reference date: ${summary.referenceDate}`, `- Queries: ${summary.queryCount}, judgments: ${summary.judgmentCount}, k = ${summary.k}, relevant = ${summary.relevanceThreshold}`);
  out.push(`- Embeddings: ${summary.embedding.available ? `AVAILABLE — ${summary.embedding.modelKey} (${summary.embedding.kind})` : `UNAVAILABLE — ${summary.embedding.reason}`}`);
  out.push(`- Leak sweep: ${summary.leakSweep.searches} searches (3 requesters × all queries × available modes × 2 ranking modes) → **${summary.leakSweep.unauthorizedCandidates}** unauthorized candidates`, ``);
  const cols = ["P@5", "P@5 strict (grade 3)", "NDCG@5", "candidate recall", "selected P@5", "selected NDCG@5", "aspect coverage", "hard-constraint satisfaction", "duplicate rate top-5", "duplicate rate selected", "inner-circle share (selected)", "retrieval ms (median)", "retrieval ms (p95)"];
  const table = (title: string, group: string, scope: "all" | "dev" | "test") => {
    out.push(`## ${title} (${scope})`, ``, `| config | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
    for (const [name, v] of Object.entries<any>(summary.configs)) {
      if (v.unavailable) { if (group === "modes") out.push(`| ${name} | ${v.unavailable} |`); continue; }
      if (v.group !== group) continue;
      out.push(`| ${name} | ${cols.map((c) => f(v[scope][c], c.includes("ms") ? 1 : 3)).join(" | ")} |`);
    }
    out.push(``);
  };
  table("Retrieval / ranking modes", "modes", "all");
  table("Retrieval / ranking modes", "modes", "dev");
  table("Retrieval / ranking modes", "modes", "test");
  table("Ablations of the hybrid reranker", "ablation", "all");
  out.push(`## Safety / abstention`, ``, `| config | unauthorized leaks | constraint violations | correct abstention (expected-empty) | false abstention (answerable) |`, `|---|---|---|---|---|`);
  for (const [name, v] of Object.entries<any>(summary.configs)) if (!v.unavailable) out.push(`| ${name} | ${v.all["unauthorized leaks"]} | ${v.all["constraint violations"]} | ${f(v.all["correct abstention (expected-empty queries)"], 2)} | ${f(v.all["false abstention (answerable queries)"], 2)} |`);
  // per-query for the headline modes
  out.push(``, `## Per-query NDCG@5 (ranked list), core modes`, ``);
  const modes = Object.entries<any>(summary.configs).filter(([, v]) => v.group === "modes").map(([n]) => n);
  out.push(`| query | split | tags | ${modes.join(" | ")} |`, `|---|---|---|${modes.map(() => "---").join("|")}|`);
  const qids = [...new Set(perQuery.map((r) => r.queryId))];
  for (const q of qids) {
    const rows = modes.map((m) => perQuery.find((r) => r.queryId === q && r.config === m));
    const first = rows.find(Boolean)!;
    out.push(`| ${q} | ${first.split} | ${first.tags.slice(0, 3).join(", ")} | ${rows.map((r) => (r ? (r.expectInsufficient ? (r.abstained ? "abstained ✓" : `returned ${r.selected.length} ✗`) : f(r.metrics.ndcg5, 2)) : "–")).join(" | ")} |`);
  }
  return out.join("\n");
}
