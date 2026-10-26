import type { Db } from "../../db/client.js";
import type { AccessContext } from "../social-access/access.js";
import type { HardFilters, Intent } from "../query-understanding/intent.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { AppError } from "../../shared/errors.js";
import { buildTsQuery, lexicalScoresFor, lexicalSearch, semanticScoresFor, semanticSearch } from "./repository.js";
import type { RawCandidate, RetrievalMode, RetrievalResult } from "./types.js";

export interface RetrieveArgs {
  db: Db;
  ctx: AccessContext;
  intent: Intent;
  filters: HardFilters;
  mode: RetrievalMode;
  poolSize: number;
  allowFallback: boolean;
  embedding: EmbeddingProvider | null;
  /** True only if vectors for `embedding.modelKey` exist in the DB. */
  semanticIndexed: boolean;
  timeoutMs: number;
}

const now = () => performance.now();

/**
 * Candidate generation for the three genuinely distinct modes. Authorization and hard filters are in the SQL of every
 * retriever. Hybrid = union of both candidate sets deduplicated by opinion id; the missing component scores are then
 * completed with targeted queries so every candidate carries both lexical and semantic evidence where it exists.
 */
export async function retrieve(a: RetrieveArgs): Promise<RetrievalResult> {
  const warnings: string[] = [];
  const t = { lexical: 0, semantic: 0, embed: 0, hydrate: 0 };
  let effective = a.mode;
  let fallback: RetrievalResult["fallback"] = null;

  const needsSemantic = a.mode === "semantic" || a.mode === "hybrid";
  if (needsSemantic && (!a.embedding || !a.semanticIndexed)) {
    const reason = !a.embedding
      ? "No embedding provider is configured (EMBEDDING_PROVIDER=none), so true embedding-based semantic retrieval is unavailable."
      : `No stored embeddings exist for model ${a.embedding.modelKey}. Run \`npm run embeddings:index\`.`;
    if (!a.allowFallback) throw new AppError("SEMANTIC_RETRIEVAL_UNAVAILABLE", `${reason} Retry with mode=lexical, or pass allowFallback=true to accept an explicitly labelled lexical fallback.`, 503, { requestedMode: a.mode });
    effective = "lexical";
    fallback = { from: a.mode, to: "lexical", reason };
    warnings.push(`FALLBACK: ${reason} Results below are LEXICAL ONLY and must not be read as semantic search.`);
  }

  const tsQuery = buildTsQuery(a.intent.keywords);
  const doLex = effective === "lexical" || effective === "hybrid";
  const doSem = effective === "semantic" || effective === "hybrid";
  if (doLex && !tsQuery) warnings.push("No usable keywords for lexical retrieval.");

  let lex: { id: string; score: number }[] = [];
  let sem: { id: string; score: number }[] = [];
  let qvec: number[] | null = null;

  if (doLex && tsQuery) {
    const s = now();
    lex = await lexicalSearch(a.db, a.ctx, a.filters, tsQuery, a.poolSize);
    t.lexical = now() - s;
  }
  if (doSem && a.embedding) {
    const s = now();
    qvec = (await a.embedding.embed([a.intent.rawQuery], { inputType: "query", timeoutMs: a.timeoutMs }))[0] ?? null;
    t.embed = now() - s;
    const s2 = now();
    sem = await semanticSearch(a.db, a.ctx, a.filters, a.embedding.modelKey, qvec!, a.poolSize);
    t.semantic = now() - s2;
  }

  const byId = new Map<string, RawCandidate>();
  lex.forEach((r, i) => byId.set(r.id, { id: r.id, lexical: r.score, semantic: null, lexicalRank: i + 1, semanticRank: null, foundBy: ["lexical"] }));
  sem.forEach((r, i) => {
    const c = byId.get(r.id);
    if (c) {
      c.semantic = r.score;
      c.semanticRank = i + 1;
      c.foundBy.push("semantic");
    } else byId.set(r.id, { id: r.id, lexical: null, semantic: r.score, lexicalRank: null, semanticRank: i + 1, foundBy: ["semantic"] });
  });

  if (effective === "hybrid") {
    const s = now();
    const missingLex = [...byId.values()].filter((c) => c.lexical === null).map((c) => c.id);
    const missingSem = [...byId.values()].filter((c) => c.semantic === null).map((c) => c.id);
    if (tsQuery && missingLex.length) {
      const m = await lexicalScoresFor(a.db, a.ctx, a.filters, tsQuery, missingLex);
      for (const [id, sc] of m) byId.get(id)!.lexical = sc;
    }
    if (qvec && a.embedding && missingSem.length) {
      const m = await semanticScoresFor(a.db, a.ctx, a.filters, a.embedding.modelKey, qvec, missingSem);
      for (const [id, sc] of m) byId.get(id)!.semantic = sc;
    }
    t.hydrate = now() - s;
  }

  return { requestedMode: a.mode, effectiveMode: effective, candidates: [...byId.values()], fallback, lexicalQuery: tsQuery, timingsMs: t, warnings };
}
