# Evaluation

All numbers below were **measured** by `npm run eval` / `npm run tune` on the synthetic benchmark in `data/eval/`.
Raw outputs are committed in `docs/results/` (`latest.md`, `latest-summary.json`, `tune.md`, `bootstrap.json`).
Nothing here is hard-coded; re-running the commands regenerates them (embedding results are deterministic given the same GloVe file).

> **Read this first — what these numbers can and cannot tell you.** The corpus, the relevance judgments, and the aspect lexicon were all written by the same author (the AI assistant that built this project), not by independent human annotators, and the corpus is small (108 opinions, 33 queries). The results show that the *pipeline behaves as designed on this benchmark* and allow a *relative* comparison of retrieval modes. They are **not** evidence of real-world accuracy, and absolute values are likely optimistic. See `docs/LIMITATIONS.md`.

## 1. Method

> **Scope note (added with the dataset importer):** every number here is measured on the **synthetic corpus only**. Imported public datasets and user posts have no relevance judgments, so the runner restricts retrieval to `synthetic-seed-v1` (`filters.dataSources`). After the authentication/import work the benchmark was re-run with fixture datasets present: all metrics for all four configurations were identical to those below, and the leak sweep stayed at 0 / 594.

| item | value |
|---|---|
| corpus | 108 synthetic opinions, 21 synthetic users, 12 relationships (accepted / pending / blocked), 5 cities, 2024–2026 timestamps (`data/seed/`) |
| queries | 33 (`data/eval/queries.json`), split alternately into **dev** (17) and **test** (16) |
| judgments | 387 graded pairs (`data/eval/judgments.json`); grades **0** irrelevant · **1** tangential · **2** relevant · **3** highly relevant; unjudged pairs = 0 (pooled judgments) |
| grading rubric | 3 = specifically addresses ≥2 of the query's concerns, firsthand-style detail; 2 = addresses one concern specifically (also negative/contrary evidence and non-firsthand reports); 1 = related but not answering; 0 = other topic. Duplicates/near-duplicates of a relevant opinion are graded like the original. Judgments are kept separate from system output (own files + own tables). |
| aspect labels | `data/eval/aspect_labels.json`: manual per-opinion aspect labels, independent of the rule-based lexicon, used only for aspect-coverage |
| reference date | pinned to 2026-10-20 (freshness, relative time windows) |
| intent parser | deterministic `rule-v1` (no LLM) for reproducibility |
| embeddings | **real learned embeddings**: GloVe-wiki-gigaword-100 averaged with SIF weighting (static word vectors, **not** a contextual sentence encoder), stored in pgvector. No hosted neural embedding model could be reached from the build sandbox, so none was evaluated. |
| effective grade | judged grade, set to 0 if the opinion is unauthorized for the requester (checked by an *independent* re-implementation of the visibility rules, `oracleCanView`) or violates the query's **manually annotated** hard constraints |
| relevant | grade ≥ 2 |

Metrics: **P@5** (fixed denominator 5), **P@5 strict** (grade 3 only), **NDCG@5** (gain 2^g−1, ideal from all judged documents authorized/valid for the requester), **candidate recall** (relevant docs inside the retrieved candidate pool of 50), **aspect coverage** (expected aspects covered by selected relevant opinions, via the manual labels), **hard-constraint satisfaction** (share of selected opinions satisfying the annotated constraints), **duplicate rate**, **inner-circle share**, **retrieval latency**, **unauthorized leaks**, **correct/false abstention**. Queries with no relevant document (the 2 expected-empty queries) are excluded from P/NDCG and scored on abstention instead.
"P@5/NDCG@5" are computed on the **ranked list** (before diversity selection); "sel." columns are computed on the final **selected evidence** (after relevance gate, duplicate collapse, MMR diversity and conflict balancing), which can be shorter than 5.

## 2. Results (all 33 queries)

### Retrieval / ranking modes
| config | P@5 | P@5 strict (≥3) | NDCG@5 | cand. recall | sel. P@5 | sel. NDCG@5 | aspect cov. | constraint sat. | dup. rate sel. | inner share sel. |
|---|---|---|---|---|---|---|---|---|---|---|
| lexical | 0.723 | 0.548 | 0.749 | 0.726 | 0.665 | 0.706 | 0.883 | 1.000 | 0.000 | 0.352 |
| semantic | 0.716 | 0.523 | 0.726 | 0.997 | 0.677 | 0.681 | 0.856 | 1.000 | 0.000 | 0.269 |
| hybrid (relevance-first) | 0.819 | 0.632 | 0.861 | 0.997 | 0.774 | 0.822 | 0.967 | 1.000 | 0.000 | 0.352 |
| hybrid (social-aware) | 0.800 | 0.639 | 0.842 | 0.997 | 0.761 | 0.801 | 0.967 | 1.000 | 0.000 | 0.487 |

### Retrieval latency (PostgreSQL + pgvector, 108 rows, single local process, 1 vCPU sandbox)
| config | median ms | p95 ms |
|---|---|---|
| lexical | 3.6 | 20.1 |
| semantic | 3.9 | 9.6 |
| hybrid (relevance-first) | 5.6 | 11.0 |
| hybrid (social-aware) | 5.4 | 9.4 |

Latency on a 108-row corpus says nothing about scale (see LIMITATIONS: exact vector scan, no ANN index).

### Statistical caution: paired bootstrap over queries (10 000 resamples)
| comparison (NDCG@5, paired by query) | n | mean Δ | 95% bootstrap CI | wins / losses |
|---|---|---|---|---|
| hybrid−lexical | 31 | +0.112 | [+0.031, +0.208] | 18 / 10 |
| hybrid−semantic | 31 | +0.135 | [+0.056, +0.223] | 18 / 7 |
| social-aware−relevance-first | 31 | -0.020 | [-0.058, +0.017] | 7 / 12 |
| semantic−lexical | 31 | -0.023 | [-0.099, +0.054] | 15 / 14 |

* Hybrid beats both single-signal modes on NDCG@5 and the 95% CIs exclude 0, **on this benchmark**.
* Lexical vs semantic (GloVe) is not distinguishable.
* Social-aware vs relevance-first: −0.02, CI includes 0 — no measurable effect on *content relevance* (which is all the judgments measure). It raises the inner-circle share of selected evidence (0.352 → 0.487), but **no experiment here measures whether that is useful to users** (that would need trust-oriented judgments or a user study). We therefore make no claim that social-aware ranking "improves" results.

### Dev / test split (parameters were chosen on dev only; see §4)
Dev:

| config | P@5 | P@5 strict (≥3) | NDCG@5 |
|---|---|---|---|
| lexical | 0.700 | 0.525 | 0.726 |
| semantic | 0.675 | 0.500 | 0.693 |
| hybrid (relevance-first) | 0.800 | 0.575 | 0.842 |
| hybrid (social-aware) | 0.787 | 0.600 | 0.830 |

Test (held out from tuning):

| config | P@5 | P@5 strict (≥3) | NDCG@5 |
|---|---|---|---|
| lexical | 0.747 | 0.573 | 0.774 |
| semantic | 0.760 | 0.547 | 0.763 |
| hybrid (relevance-first) | 0.840 | 0.693 | 0.882 |
| hybrid (social-aware) | 0.813 | 0.680 | 0.854 |

### Ablations of the hybrid reranker (weights set to 0 one at a time)
| config | P@5 | P@5 strict (≥3) | NDCG@5 | cand. recall | aspect cov. |
|---|---|---|---|---|---|
| hybrid − aspect | 0.748 | 0.574 | 0.770 | 0.997 | 0.967 |
| hybrid − context | 0.819 | 0.632 | 0.848 | 0.997 | 0.967 |
| hybrid − specificity | 0.813 | 0.626 | 0.854 | 0.997 | 0.967 |
| hybrid − provenance | 0.813 | 0.626 | 0.848 | 0.997 | 0.967 |
| hybrid − freshness | 0.819 | 0.639 | 0.864 | 0.997 | 0.967 |
| hybrid: lexical+semantic only | 0.768 | 0.600 | 0.786 | 0.997 | 0.967 |
| hybrid: lexical+aspect only | 0.813 | 0.626 | 0.849 | 0.997 | 0.967 |

* Removing the **aspect** signal hurts most (NDCG@5 0.861 → 0.770). Note aspect coverage is a *lexicon heuristic*, not semantic understanding, and the lexicon was written by the benchmark author; this likely inflates its value.
* `lexical + aspect only` (0.849) is nearly as good as the full reranker, and `lexical + semantic only` (0.786) is clearly worse: on this benchmark the GloVe signal adds little beyond lexical + aspect matching (bootstrap CIs were not computed for ablations; treat small differences as noise).
* Context, specificity, provenance and freshness each change NDCG@5 by ≤0.013 — within noise at n=33.

### Safety and abstention
| config | unauthorized leaks | constraint violations | correct abstention (expected-empty) | false abstention (answerable) |
|---|---|---|---|---|
| lexical | 0 | 0 | 1.00 | 0.00 |
| semantic | 0 | 0 | 1.00 | 0.06 |
| hybrid (relevance-first) | 0 | 0 | 1.00 | 0.00 |
| hybrid (social-aware) | 0 | 0 | 1.00 | 0.00 |
| hybrid − aspect | 0 | 0 | 1.00 | 0.00 |
| hybrid − context | 0 | 0 | 1.00 | 0.00 |
| hybrid − specificity | 0 | 0 | 1.00 | 0.00 |
| hybrid − provenance | 0 | 0 | 1.00 | 0.00 |
| hybrid − freshness | 0 | 0 | 1.00 | 0.00 |
| hybrid: lexical+semantic only | 0 | 0 | 1.00 | 0.00 |
| hybrid: lexical+aspect only | 0 | 0 | 1.00 | 0.00 |

* **Unauthorized leaks = 0** in every configuration, including a *leak sweep* of 594 searches (3 requesters × 33 queries × 3 retrieval modes × 2 ranking modes) checking raw SQL candidate ids against the independent oracle.
* Semantic-only abstained on 2 answerable queries (false abstention), hybrid on 0. Both expected-empty queries (unknown city; city with no matching topic) are abstained by **all** modes at the tuned threshold (correct abstention 1.00). Semantic-only needed its admission threshold raised from 0.30 to get there (§4); its two false abstentions were q05 and q15.

## 3. Failure cases (from `reports/latest.json`, hybrid relevance-first)

| query | NDCG@5 | what went wrong | root cause |
|---|---|---|---|
| q14 "Quiet cafe in Bengaluru where I can sit and read, **I don't need wifi**" | 0.57 | wifi-positive cafes rank high | the rule parser extracts `wifi` as a desired aspect and has no notion of *negated* query intent |
| q16 "great coffee but **not good for working on a laptop**" | 0.69 | laptop-friendly cafes (judged 0) in top 5 | same: negation/polarity in the *query* is not modelled; aspect match is polarity-agnostic by design |
| q23 "Best **cheap** kachori or street food" | 0.69 | an overpriced/bland review (judged 0) in top 5 | `price` and `food_quality` aspects match regardless of polarity |
| q32 "dark streets" | 0.62 | two "brightly lit" opinions (judged 0) in top 5 | polarity is an evidence characteristic, not a ranking signal (design decision D-08); the benchmark's judgments encode a stricter reading of the query than the product does |
| q29 "trouble with taxis or autos late at night, last year" | 0.60 | positive taxi reports outrank some negative ones | same polarity-agnostic behaviour; hard time window itself was satisfied |
| q07 "Colaba at night, last 6 months" | 0.70 | Bandra/Worli opinions (judged 0 for a Colaba query) in top 5 | neighborhood is only a soft context signal (weight 0.08) |

These six are among the eight lowest hybrid NDCG@5 scores (median over queries: 0.93). The other two of the eight, q19 (0.70) and q26 (0.71), were **not** analysed here. The common theme of the six is **query-side polarity/negation**. The highest-impact fix is polarity-conditioned matching (parse "not/without/cheap/dark" into a desired stance per aspect, e.g. via the optional LLM parser, then match against the stored aspect polarity).

Other measured observations: the dedupe step now removes every known duplicate from the *selected* evidence (duplicate rate 0.000), but the *ranked list* still contains duplicates by design (they are real candidates), so P@5 on the ranked list can be inflated by judged-relevant duplicates.

## 4. Tuning experiments (dev-selected, test-reported)

Procedure (`npm run tune`): each variant is run on all queries; the choice is made by looking at the **dev** columns only, and the **test** columns are reported alongside as a sanity check. With one expected-empty query in dev, this protocol is weak and the choices below should be regarded as provisional.

Full output: `docs/results/tune.md`.

```
## Experiment 1 — relevance gate (semantic admission threshold), mode=semantic

| semanticMin | dev NDCG@5 | dev correct-abstain | dev false-abstain | test NDCG@5 | test correct-abstain | test false-abstain |
|---|---|---|---|---|---|---|
| 0.3 | 0.693 | 0.000 | 0.000 | 0.763 | 1.000 | 0.000 |
| 0.4 | 0.693 | 0.000 | 0.000 | 0.763 | 1.000 | 0.000 |
| 0.45 | 0.693 | 0.000 | 0.125 | 0.763 | 1.000 | 0.000 |
| 0.5 | 0.693 | 1.000 | 0.125 | 0.763 | 1.000 | 0.000 |
| 0.55 | 0.693 | 1.000 | 0.188 | 0.763 | 1.000 | 0.067 |
| 0.6 | 0.693 | 1.000 | 0.188 | 0.763 | 1.000 | 0.067 |
| 0.65 | 0.693 | 1.000 | 0.250 | 0.763 | 1.000 | 0.200 |
| 0.7 | 0.693 | 1.000 | 0.438 | 0.763 | 1.000 | 0.400 |

## Experiment 2 — hybrid admission (semanticMin x hybridLexicalMin), mode=hybrid

| semanticMin | hybridLexicalMin | dev NDCG@5 | dev correct-abstain | dev false-abstain | test NDCG@5 | test correct-abstain | test false-abstain |
|---|---|---|---|---|---|---|---|
| 0.45 | 0.1 | 0.842 | 0.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.45 | 0.15 | 0.842 | 0.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.45 | 0.25 | 0.842 | 0.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.5 | 0.1 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.5 | 0.15 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.5 | 0.25 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.55 | 0.1 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.55 | 0.15 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.55 | 0.25 | 0.842 | 1.000 | 0.063 | 0.882 | 1.000 | 0.000 |
| 0.6 | 0.1 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.6 | 0.15 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.6 | 0.25 | 0.842 | 1.000 | 0.063 | 0.882 | 1.000 | 0.000 |
| 0.65 | 0.1 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.65 | 0.15 | 0.842 | 1.000 | 0.000 | 0.882 | 1.000 | 0.000 |
| 0.65 | 0.25 | 0.842 | 1.000 | 0.063 | 0.882 | 1.000 | 0.000 |

## Experiment 3 — hybrid weights (gate fixed at default), one factor at a time

| variant | dev NDCG@5 | dev P@5 | test NDCG@5 | test P@5 |
|---|---|---|---|---|
| default | 0.842 | 0.800 | 0.882 | 0.840 |
| semantic 0.15 | 0.842 | 0.787 | 0.869 | 0.827 |
| semantic 0.35 | 0.833 | 0.800 | 0.881 | 0.840 |
| semantic 0.45 | 0.831 | 0.788 | 0.861 | 0.827 |
| aspect 0.10 | 0.841 | 0.788 | 0.883 | 0.840 |
| aspect 0.30 | 0.842 | 0.800 | 0.882 | 0.840 |
| aspect 0.40 | 0.842 | 0.800 | 0.882 | 0.840 |
| lexical 0.10 | 0.834 | 0.800 | 0.870 | 0.840 |
| lexical 0.30 | 0.846 | 0.800 | 0.870 | 0.840 |
| freshness 0 | 0.846 | 0.800 | 0.882 | 0.840 |
| freshness 0.02 | 0.842 | 0.800 | 0.882 | 0.840 |
| freshness 0.04 | 0.831 | 0.800 | 0.866 | 0.827 |
| specificity 0.2 | 0.812 | 0.762 | 0.848 | 0.813 |
```

Decisions taken (all in `src/modules/ranking/config.ts`):

1. **Semantic admission threshold 0.30 → 0.50.** At 0.30 the semantic and hybrid modes returned evidence for the expected-empty query "cafes in Jaipur with good wifi" (GloVe cosine is high for any English text pair). 0.50 is the lowest value in the grid for which the dev expected-empty query abstains without false abstention in hybrid mode. *This threshold is specific to GloVe-100/SIF and must be re-tuned for any other embedding model.*
2. **Freshness weight 0.07 → 0.02.** In the first tuning pass (before a stemmer bug fix, see below) dropping freshness improved dev NDCG@5 by ≈0.017. After the fix the effect shrank to within noise (≈0.004). The change is kept because the judgments reward content relevance only, but the data no longer *supports* it strongly; it is not claimed as an improvement.
3. **Duplicate threshold 0.8 → 0.5.** Measured on the corpus: the known duplicate pairs scored 0.63–1.00 word-bigram Jaccard, the most similar non-duplicate pair 0.14. The a-priori 0.8 missed the copied-wording pair (0.63). This is calibrated on a corpus whose duplicates were authored by the benchmark author, so the gap is likely wider than in real data; paraphrased copies would be missed.
4. Other weights unchanged: one-at-a-time variations (semantic 0.15–0.45, aspect 0.1–0.4, lexical 0.1–0.3, specificity 0.2) did not beat the defaults on dev beyond noise, or hurt on test.

A bug found *by the tests*: the stemmer excluded words ending in "-is", so "taxis" never matched "taxi" in aspect extraction. It was fixed (regression test added) and **all results above, and the tuning, were re-run after the fix**.

## 5. What was not evaluated

* Hosted neural embeddings, LLM query understanding, LLM answer quality, and live web search: no keys / network access in the build sandbox. Their *integration code* is unit-tested against mock HTTP servers only.
* Answer faithfulness (citation validity is enforced mechanically and tested; answer *quality* is not measured).
* Any real user data, other languages, or corpora larger than 108 opinions.
* ANN index recall/latency trade-offs.

## 6. Reproducing

```bash
docker compose up -d
npm install && npm run db:generate && npm run db:migrate && npm run db:seed
npm run embeddings:glove            # downloads GloVe (~70 MB gz, converted to ~41 MB)
# .env: EMBEDDING_PROVIDER=local-glove
npm run embeddings:index
npm run eval                        # writes reports/latest.json and reports/latest.md
npm run tune                        # prints the tuning tables
```
Without embeddings, `npm run eval` still runs the lexical baseline and reports semantic/hybrid as **UNAVAILABLE** (verified in a clean checkout).
