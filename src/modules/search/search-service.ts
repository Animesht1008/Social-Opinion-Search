import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getEmbeddingStatus, hiddenDataSources, providerSummary, type AppContext } from "../../context.js";
import { Prisma } from "../../db/client.js";
import { AppError } from "../../shared/errors.js";
import { buildWebSearchQuery, generateAnswer, isDestinationRecommendationQuery, type AnswerResult, type EvidenceItem } from "../answer/answer.js";
import { applyApiFilters, understandQuery } from "../query-understanding/parser.js";
import { deriveFilters, FiltersSchema, type HardFilters, type Intent } from "../query-understanding/intent.js";
import { ASPECT_BY_ID } from "../query-understanding/aspects.js";
import { rankCandidates } from "../ranking/rank.js";
import { DEFAULT_PARAMS, type RankingParams } from "../ranking/config.js";
import { selectEvidence, type Selection } from "../ranking/select.js";
import { fetchOpinions, knownLocations } from "../retrieval/repository.js";
import { retrieve } from "../retrieval/retrieve.js";
import type { RetrievalResult } from "../retrieval/types.js";
import { assertAuthorized, loadAccessContext, type AccessContext } from "../social-access/access.js";
import { fetchWebEvidence, type WebEvidence } from "../web-search/provider.js";
import { excerpt, round } from "../../shared/text.js";
import type { ScoredCandidate } from "../ranking/types.js";
import { buildPlaceRecommendations } from "./recommendations.js";

export const SearchRequestSchema = z
  .object({
    query: z.string().trim().min(3, "query must be at least 3 characters").max(500, "query must be at most 500 characters"),
    mode: z.enum(["lexical", "semantic", "hybrid"]).default("hybrid"),
    ranking: z.enum(["relevance_first", "social_aware"]).default("relevance_first"),
    limit: z.number().int().min(1).max(10).default(6),
    generateAnswer: z.boolean().default(true),
    includeWeb: z.boolean().default(true),
    allowFallback: z.boolean().default(false),
    candidatePool: z.number().int().min(10).max(200).default(50),
    filters: FiltersSchema.optional(),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export interface SearchInternals {
  intent: Intent;
  filters: HardFilters;
  access: AccessContext;
  retrieval: RetrievalResult;
  ranked: ScoredCandidate[];
  selection: Selection;
}

export interface SearchOptions {
  persist?: boolean;
  params?: RankingParams;
  /** Evaluation hook: reuse a pre-built intent instead of calling the parser. */
  intent?: Intent;
}

const ms = (x: number) => round(x, 1);

export async function runSearch(ctx: AppContext, requesterId: string, req: SearchRequest, opts: SearchOptions = {}) {
  const t0 = performance.now();
  const warnings: string[] = [];
  const params = opts.params ?? ctx.params ?? DEFAULT_PARAMS;

  const user = await ctx.db.user.findUnique({ where: { id: requesterId }, select: { id: true } });
  if (!user) throw new AppError("UNKNOWN_USER", `Unknown user ${requesterId}`, 401);
  const access = await loadAccessContext(ctx.db, requesterId, ctx.circleRule, await hiddenDataSources(ctx));

  // ---- 1. query understanding ----
  const tU = performance.now();
  const known = await knownLocations(ctx.db);
  const parseCtx = { cities: known.cities, neighborhoods: known.neighborhoods, now: ctx.now() };
  let intent = opts.intent ?? (await understandQuery({ query: req.query, ctx: parseCtx, llm: ctx.llm, useLlm: ctx.config.LLM_QUERY_UNDERSTANDING, timeoutMs: ctx.config.PROVIDER_TIMEOUT_MS }));
  intent = applyApiFilters(intent, req.filters);
  const filters = deriveFilters(intent);
  const understandMs = performance.now() - tU;
  for (const c of intent.hardConstraints.filter((c) => !c.verifiable)) warnings.push(`Hard constraint "${c.text}" cannot be verified against stored fields and was NOT applied as a filter.`);
  warnings.push(...intent.warnings);

  // ---- 2. web evidence (separate channel) runs concurrently with retrieval ----
  const destinationRecommendationQuery = isDestinationRecommendationQuery(req.query);
  const webPromise: Promise<WebEvidence> = req.includeWeb
    ? fetchWebEvidence(ctx.web, buildWebSearchQuery(req.query), ctx.config.PROVIDER_TIMEOUT_MS)
    : Promise.resolve({ status: "skipped", provider: ctx.web?.id ?? "none", reason: "includeWeb=false", results: [] });

  // ---- 3. retrieval ----
  const embStatus = await getEmbeddingStatus(ctx);
  const retrieval = await retrieve({
    db: ctx.db,
    ctx: access,
    intent,
    filters,
    mode: req.mode,
    poolSize: req.candidatePool,
    allowFallback: req.allowFallback,
    embedding: ctx.embedding,
    semanticIndexed: embStatus.semanticAvailable,
    timeoutMs: ctx.config.PROVIDER_TIMEOUT_MS,
  });
  warnings.push(...retrieval.warnings);
  if (embStatus.semanticAvailable && embStatus.indexedOpinions < embStatus.totalOpinions && retrieval.effectiveMode !== "lexical") warnings.push(embStatus.reason);

  // ---- 4. hydrate (authorization re-applied in SQL and in code) + rank ----
  const tH = performance.now();
  const recs = assertAuthorized(access, await fetchOpinions(ctx.db, access, retrieval.candidates.map((c) => c.id)));
  const records = new Map(recs.map((r) => [r.id, r]));
  const hydrateMs = performance.now() - tH;
  const tR = performance.now();
  const ranked = rankCandidates({ records, raw: retrieval.candidates, intent, ctx: access, mode: retrieval.effectiveMode, ranking: req.ranking, params, now: ctx.now() });
  const rankMs = performance.now() - tR;

  // ---- 5. evidence selection ----
  const tS = performance.now();
  const selection = selectEvidence(ranked, req.limit, intent, params);
  const selectMs = performance.now() - tS;

  const innerSelected = selection.selected.filter((c) => c.channel === "inner_circle").length;
  const webFallbackRequested = destinationRecommendationQuery && innerSelected === 0 && req.includeWeb;
  if (selection.selected.length > 0 && innerSelected === 0) warnings.push("No relevant inner-circle opinions were found for this query; the evidence below comes from wider social/public sources only. Absence of friend opinions says nothing about the place itself.");
  if (selection.adequacy === "insufficient") warnings.push("Insufficient evidence: " + selection.adequacyNote);
  const cityC = intent.hardConstraints.find((c) => c.kind === "city");
  if (selection.adequacy === "insufficient" && cityC && !known.cities.some((x) => x.toLowerCase() === String(cityC.value).toLowerCase())) warnings.push(`No opinions exist for location "${cityC.value}" in this corpus.`);

  // ---- 6. evidence items + answer ----
  const evidence: EvidenceItem[] = selection.selected.map((c) => ({
    id: c.id,
    channel: c.channel,
    sourceType: c.record.sourceType,
    firsthand: c.record.firsthand,
    writtenAt: c.record.writtenAt.toISOString(),
    text: c.record.text,
    isSynthetic: c.record.isSynthetic,
    aspects: c.record.aspects.map((a) => ({ aspect: a.aspect, polarity: a.polarity })),
  }));
  const web = await webPromise;
  if (web.status === "error") warnings.push(`Web search failed (${web.reason}); continuing without web evidence.`);
  if (web.status === "unavailable" && req.includeWeb) warnings.push(web.reason!);

  const tA = performance.now();
  let answer: AnswerResult | null = null;
  if (req.generateAnswer) {
    answer = await generateAnswer({ query: req.query, intent, evidence, selection, web, llm: ctx.llm, timeoutMs: ctx.config.PROVIDER_TIMEOUT_MS, enableWebRecommendations: webFallbackRequested });
    warnings.push(...answer.warnings);
  }
  const answerMs = performance.now() - tA;

  const providers = { embedding: embStatus, ...providerSummary(ctx), webSearch: { configured: !!ctx.web, provider: ctx.web?.id ?? "none", status: web.status, reason: web.reason ?? null }, intentParser: intent.parser };

  // ---- 7. response ----
  const cand = (c: ScoredCandidate, rank: number) => ({
    rank,
    opinionId: c.id,
    channel: c.channel,
    sourceType: c.record.sourceType,
    authorId: c.record.authorId,
    authorName: c.record.authorName,
    neighborhood: c.record.neighborhood,
    city: c.record.city,
    writtenAt: c.record.writtenAt.toISOString(),
    firsthand: c.record.firsthand,
    isSynthetic: c.record.isSynthetic,
    dataSource: c.record.dataSource,
    rating: c.record.rating,
    text: c.record.text,
    foundBy: c.raw.foundBy,
    components: c.components,
    relevanceScore: c.relevanceScore,
    finalScore: c.finalScore,
    eligible: c.isRelevant,
    eligibilityReason: c.relevanceReason,
    matchedKeywords: c.matchedKeywords,
    aspects: c.record.aspects,
    queryAspectPolarity: c.aspectPolarity,
    explanation: c.explanation,
  });
  const selIds = new Set(selection.selected.map((c) => c.id));
  const suppressedIds = new Map(selection.suppressed.map((s) => [s.id, s]));
  const candidates = ranked.slice(0, 40).map((c, i) => ({
    ...cand(c, i + 1),
    selected: selIds.has(c.id),
    selectionReason: selection.reasons.get(c.id) ?? suppressedIds.get(c.id)?.reason ?? (c.isRelevant ? "Eligible but not selected (lower rank or redundant with selected evidence)" : `Not eligible as evidence: ${c.relevanceReason}`),
  }));
  const selected = selection.selected.map((c) => ({ ...cand(c, ranked.indexOf(c) + 1), selectionReason: selection.reasons.get(c.id) ?? "" }));
  const placeRecommendations = ["hotel_area", "cafe", "restaurant"].includes(intent.topic ?? "")
    ? buildPlaceRecommendations(selection.selected
        .filter((c) => !intent.location.city || c.record.city.toLowerCase() === intent.location.city.toLowerCase())
        .map((c) => ({
          id: c.id,
          city: c.record.city,
          neighborhood: c.record.neighborhood,
          aspectPolarity: c.record.aspects.map(({ aspect, polarity }) => ({ aspect, polarity })),
          rating: c.record.rating,
        })))
    : [];

  const latencyMs = {
    total: ms(performance.now() - t0),
    understand: ms(understandMs),
    retrieval: { ...Object.fromEntries(Object.entries(retrieval.timingsMs).map(([k, v]) => [k, ms(v)])), hydrate: ms(hydrateMs + retrieval.timingsMs.hydrate) },
    rank: ms(rankMs),
    select: ms(selectMs),
    answer: ms(answerMs),
  };

  const runId = randomUUID();
  const response = {
    runId,
    query: req.query,
    requester: { id: requesterId },
    intent,
    appliedFilters: filters,
    retrieval: {
      requestedMode: retrieval.requestedMode,
      effectiveMode: retrieval.effectiveMode,
      rankingMode: req.ranking,
      fallback: retrieval.fallback,
      lexicalQuery: retrieval.lexicalQuery,
      candidatePool: req.candidatePool,
      candidateCount: ranked.length,
      eligibleCount: ranked.filter((c) => c.isRelevant).length,
    },
    providers,
    channels: {
      inner_circle: { eligible: ranked.filter((c) => c.isRelevant && c.channel === "inner_circle").length, selected: innerSelected },
      wider_social: { eligible: ranked.filter((c) => c.isRelevant && c.channel === "wider_social").length, selected: selection.selected.length - innerSelected },
      web: { status: web.status, provider: web.provider, results: web.results, reason: web.reason ?? null },
    },
    webFallback: { requested: webFallbackRequested, reason: webFallbackRequested ? "No relevant inner-circle opinions were selected for this destination-suggestion query." : null },
    adequacy: { status: selection.adequacy, note: selection.adequacyNote, uncoveredAspects: selection.uncoveredAspects, independentFirsthandSources: selection.independentFirsthandSources },
    aspectBalance: selection.aspectBalance.map((b) => ({ ...b, label: ASPECT_BY_ID.get(b.aspect)?.label ?? b.aspect })),
    placeRecommendations,
    selected,
    suppressedDuplicates: selection.suppressed,
    candidates,
    answer,
    latencyMs,
    warnings: [...new Set(warnings)],
  };

  if (opts.persist !== false) {
    // Logs hold ids, scores and metadata only — never opinion text.
    await ctx.db.searchRun.create({
      data: {
        id: runId,
        userId: requesterId,
        query: req.query,
        intent: intent as unknown as Prisma.InputJsonValue,
        retrievalMode: req.mode.toUpperCase() as "LEXICAL" | "SEMANTIC" | "HYBRID",
        rankingMode: req.ranking === "social_aware" ? "SOCIAL_AWARE" : "RELEVANCE_FIRST",
        effectiveMode: retrieval.effectiveMode,
        candidates: ranked.slice(0, 50).map((c, i) => ({ id: c.id, rank: i + 1, channel: c.channel, components: c.components, relevanceScore: c.relevanceScore, finalScore: c.finalScore, eligible: c.isRelevant })) as unknown as Prisma.InputJsonValue,
        selectedIds: selection.selected.map((c) => c.id),
        providerStatus: providers as unknown as Prisma.InputJsonValue,
        warnings: response.warnings,
        latencyMs: Math.round(latencyMs.total),
      },
    });
  }
  const internals: SearchInternals = { intent, filters, access, retrieval, ranked, selection };
  return { response, internals };
}

export { excerpt };
