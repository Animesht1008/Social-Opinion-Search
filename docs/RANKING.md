# Ranking and evidence selection

Everything here is implemented in `src/modules/ranking/` and is exposed per candidate in every API response (`components`, `finalScore`, `explanation`, `selectionReason`).
Defaults live in `src/modules/ranking/config.ts`. **The weights are an a-priori starting point that was lightly tuned on a dev split (docs/EVALUATION.md §4); they are not scientifically validated.**

## 1. Pipeline

```
query ─► intent (rule-v1 / LLM+grounding) ─► hard filters + authorization (SQL)
      ─► candidate generation  (lexical FTS │ pgvector cosine │ both, union by id)
      ─► hydrate + authorization re-check
      ─► component scores ─► mode score ─► (optional) social boost
      ─► relevance gate (eligible?) ─► duplicate clusters ─► MMR diversity ─► conflict balancing
      ─► adequacy ─► grounded answer
```

## 2. Component scores (all in [0,1] unless noted)

| component | definition | what it is / is not |
|---|---|---|
| `lexical` | `ts_rank_cd(search_vector, to_tsquery('english', k1 \| k2 …), 32)` — OR-query of intent keywords, normalisation 32 → `r/(r+1)` | plain PostgreSQL full-text search; null if no match |
| `semantic` | cosine similarity between query embedding and stored opinion embedding of the **same model key**; clamped at 0 for scoring | only with a real embedding provider; null otherwise |
| `aspect` | `|query aspects ∩ opinion aspects| / |query aspects|`, from the rule-based lexicon (`lexicon-v1`) | **concept heuristic, not semantic search**; null if the query has no recognised aspect |
| `context` | mean of city match (1/0, 0.5 if unspecified), topic/category match (1 / 0.2 / 0.5), neighborhood match (1 / 0.4 / 0.5) | location/context match |
| `specificity` | 0.7 × (share of 5 concrete cues: numeric/time expression, proper noun, first-person experience verb, ≥25 words, ≥2 aspects) + 0.3 × firsthand | heuristic; generic praise scores low |
| `provenance` | 0.3 explicit repost · 0.5 no attribution · 1.0 social user · 0.8 public review | source trust, deliberately **separate** from relevance |
| `freshness` | `0.5^(age_days / half_life)`; half-life 365 d (182 d when the user asks for "recent") | |
| `social` | social-aware mode only (see §4) | |
| `redundancy` | max unigram-Jaccard similarity to already-selected evidence | display only; the diversity step uses it |
| polarity | per query-aspect POSITIVE/NEGATIVE/MIXED/NEUTRAL from the lexicon (negation-aware within 3 tokens) | evidence characteristic; **never a penalty** |

## 3. Mode scores

* **lexical:** `final = lexical` (+ optional social boost).
* **semantic:** `final = max(0, cosine)`.
* **hybrid:** weighted mean over the *available* components, weights renormalised:
  `final = Σ wᵢ·cᵢ / Σ wᵢ` over lexical, semantic (if embedded), aspect (if the query has aspects), context, specificity, provenance, freshness.
  Default weights: lexical 0.20, semantic 0.25, aspect 0.20, context 0.08, specificity 0.10, provenance 0.05, freshness 0.02 (×5 if the query asks for recent evidence).

## 4. Relevance first vs social-aware

* `relevance_first` (default): relationship information is **not** used for ordering. Authorization still decides what may be retrieved at all.
* `social_aware`: adds `boost = w_social × strength × gate`, with `w_social = 0.08` (maximum possible boost);
  `strength` = `closeness/5` for inner-circle authors, `0.4 × closeness/5` for other accepted connections, 0 otherwise;
  `gate = smoothstep((contentRelevance − 0.12) / (0.30 − 0.12))` where `contentRelevance` is the mean of the available lexical / semantic / aspect scores.
  Therefore closeness **cannot rescue irrelevant text** (gate ≈ 0), cannot change eligibility (the relevance gate ignores it — tested), and cannot override a hard filter (filters run in SQL before ranking).
* Measured effect on content relevance: NDCG@5 −0.020 (95% CI −0.058…+0.017). Not demonstrated to be beneficial (docs/EVALUATION.md).

## 5. Eligibility ("relevance gate")

An opinion enters the evidence pool only if it clears a gate (so a recent, firsthand, specific but off-topic or 5-star-but-irrelevant opinion cannot be selected):

* lexical mode: `lexical ≥ 0.05`
* semantic mode: `cosine ≥ 0.50` (**GloVe-100/SIF specific**; re-tune per model)
* hybrid: ≥ 1 matched non-context query aspect **or** `cosine ≥ 0.50` **or** `lexical ≥ 0.15`

## 6. Evidence selection (`select.ts`), default k = 6 (1–10 allowed)

1. **Duplicate clusters:** eligible opinions are linked if they have an explicit `repostOfId` or word-bigram Jaccard ≥ 0.5 (measured gap on the corpus: duplicates ≥ 0.63, non-duplicates ≤ 0.14). The best-scoring member represents the cluster; the others are *suppressed from the selection* (never deleted) and returned in `suppressedDuplicates` with a reason. Repeated text is therefore not counted as independent corroboration.
2. **MMR diversity:** greedy `λ·score/topScore − (1−λ)·maxSim − 0.05·sameAuthorCount`, λ = 0.75, similarity = unigram Jaccard.
3. **Conflict balancing:** if the selection is one-sided on a query aspect (all positive or all negative) and an eligible, unselected opinion with the opposite polarity exists, it replaces the lowest-ranked selected item that is not the sole coverage of an aspect (max 2 swaps). The reason is recorded in `selectionReason`.
4. **Adequacy:** `sufficient` (≥3 selected and ≥50% of query aspects covered), `limited`, or `insufficient` (nothing eligible → no recommendation). `independentFirsthandSources` counts distinct authors of firsthand, non-repost selected opinions — a conservative count; true independence cannot be proven.

## 7. Calibrated vs a-priori values

| value | origin |
|---|---|
| semantic admission 0.50 | chosen on dev split (EVALUATION §4) |
| freshness weight 0.02 | lightly supported on dev; effect within noise after the stemmer fix |
| duplicate threshold 0.5 | measured similarity gap on the synthetic corpus |
| all other weights, MMR λ, social gate, recency ×5 | a-priori; one-at-a-time perturbations of the main weights did not beat defaults beyond noise; recency ×5 and social parameters are untuned |
