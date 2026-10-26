/**
 * Runs the offline benchmark and writes reports/latest.json + reports/latest.md.
 *   npm run eval                 -> full run (modes + ablations + leak sweep)
 *   npm run eval -- --no-ablate  -> core modes only
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { createContext } from "../src/context.js";
import { runEvaluation } from "../src/modules/evaluation/runner.js";
import { renderMarkdown } from "../src/modules/evaluation/report.js";

const ctx = await createContext(loadConfig());
try {
  const t = performance.now();
  const r = await runEvaluation(ctx, { persist: true, includeAblations: !process.argv.includes("--no-ablate") });
  const md = renderMarkdown(r.summary, r.perQuery);
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/latest.json", JSON.stringify({ id: r.id, summary: r.summary, perQuery: r.perQuery }, null, 1));
  writeFileSync("reports/latest.md", md);
  console.log(md);
  console.log(`\nEvaluation ${r.id} finished in ${((performance.now() - t) / 1000).toFixed(1)}s. Wrote reports/latest.json and reports/latest.md`);
} finally {
  await ctx.close();
}
