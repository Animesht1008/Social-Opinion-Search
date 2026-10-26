# Evaluation report

- Reference date: 2026-10-20T00:00:00Z
- Queries: 33, judgments: 387, k = 5, relevant = grade >= 2 (0-3 scale)
- Embeddings: AVAILABLE — glove-wiki-gigaword-100@sif-v1 (static-word-vectors)
- Leak sweep: 594 searches (3 requesters × all queries × available modes × 2 ranking modes) → **0** unauthorized candidates

## Retrieval / ranking modes (all)

| config | P@5 | P@5 strict (grade 3) | NDCG@5 | candidate recall | selected P@5 | selected NDCG@5 | aspect coverage | hard-constraint satisfaction | duplicate rate top-5 | duplicate rate selected | inner-circle share (selected) | retrieval ms (median) | retrieval ms (p95) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lexical | 0.723 | 0.548 | 0.749 | 0.726 | 0.665 | 0.706 | 0.883 | 1.000 | 0.103 | 0.000 | 0.352 | 3.6 | 20.1 |
| semantic | 0.716 | 0.523 | 0.726 | 0.997 | 0.677 | 0.681 | 0.856 | 1.000 | 0.087 | 0.000 | 0.269 | 3.9 | 9.6 |
| hybrid (relevance-first) | 0.819 | 0.632 | 0.861 | 0.997 | 0.774 | 0.822 | 0.967 | 1.000 | 0.175 | 0.000 | 0.352 | 5.6 | 11.0 |
| hybrid (social-aware) | 0.800 | 0.639 | 0.842 | 0.997 | 0.761 | 0.801 | 0.967 | 1.000 | 0.175 | 0.000 | 0.487 | 5.4 | 9.4 |

## Retrieval / ranking modes (dev)

| config | P@5 | P@5 strict (grade 3) | NDCG@5 | candidate recall | selected P@5 | selected NDCG@5 | aspect coverage | hard-constraint satisfaction | duplicate rate top-5 | duplicate rate selected | inner-circle share (selected) | retrieval ms (median) | retrieval ms (p95) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lexical | 0.700 | 0.525 | 0.726 | 0.728 | 0.650 | 0.681 | 0.813 | 1.000 | 0.100 | 0.000 | 0.344 | 3.5 | 20.1 |
| semantic | 0.675 | 0.500 | 0.693 | 0.994 | 0.650 | 0.637 | 0.792 | 1.000 | 0.094 | 0.000 | 0.257 | 3.7 | 9.6 |
| hybrid (relevance-first) | 0.800 | 0.575 | 0.842 | 0.994 | 0.750 | 0.811 | 0.938 | 1.000 | 0.165 | 0.000 | 0.331 | 5.9 | 11.2 |
| hybrid (social-aware) | 0.787 | 0.600 | 0.830 | 0.994 | 0.725 | 0.782 | 0.938 | 1.000 | 0.212 | 0.000 | 0.444 | 5.4 | 14.3 |

## Retrieval / ranking modes (test)

| config | P@5 | P@5 strict (grade 3) | NDCG@5 | candidate recall | selected P@5 | selected NDCG@5 | aspect coverage | hard-constraint satisfaction | duplicate rate top-5 | duplicate rate selected | inner-circle share (selected) | retrieval ms (median) | retrieval ms (p95) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lexical | 0.747 | 0.573 | 0.774 | 0.724 | 0.680 | 0.732 | 0.964 | 1.000 | 0.107 | 0.000 | 0.360 | 3.8 | 28.5 |
| semantic | 0.760 | 0.547 | 0.763 | 1.000 | 0.707 | 0.729 | 0.929 | 1.000 | 0.080 | 0.000 | 0.280 | 4.1 | 15.7 |
| hybrid (relevance-first) | 0.840 | 0.693 | 0.882 | 1.000 | 0.800 | 0.835 | 1.000 | 1.000 | 0.187 | 0.000 | 0.373 | 5.5 | 11.0 |
| hybrid (social-aware) | 0.813 | 0.680 | 0.854 | 1.000 | 0.800 | 0.821 | 1.000 | 1.000 | 0.133 | 0.000 | 0.533 | 5.2 | 9.1 |

## Ablations of the hybrid reranker (all)

| config | P@5 | P@5 strict (grade 3) | NDCG@5 | candidate recall | selected P@5 | selected NDCG@5 | aspect coverage | hard-constraint satisfaction | duplicate rate top-5 | duplicate rate selected | inner-circle share (selected) | retrieval ms (median) | retrieval ms (p95) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hybrid − aspect | 0.748 | 0.574 | 0.770 | 0.997 | 0.755 | 0.772 | 0.967 | 1.000 | 0.200 | 0.000 | 0.358 | 5.4 | 13.9 |
| hybrid − context | 0.819 | 0.632 | 0.848 | 0.997 | 0.774 | 0.812 | 0.967 | 1.000 | 0.175 | 0.000 | 0.352 | 6.1 | 10.9 |
| hybrid − specificity | 0.813 | 0.626 | 0.854 | 0.997 | 0.781 | 0.820 | 0.967 | 1.000 | 0.137 | 0.000 | 0.332 | 4.8 | 8.0 |
| hybrid − provenance | 0.813 | 0.626 | 0.848 | 0.997 | 0.774 | 0.815 | 0.967 | 1.000 | 0.225 | 0.000 | 0.290 | 6.5 | 11.7 |
| hybrid − freshness | 0.819 | 0.639 | 0.864 | 0.997 | 0.781 | 0.823 | 0.967 | 1.000 | 0.175 | 0.000 | 0.352 | 4.9 | 8.1 |
| hybrid: lexical+semantic only | 0.768 | 0.600 | 0.786 | 0.997 | 0.768 | 0.785 | 0.967 | 1.000 | 0.100 | 0.000 | 0.300 | 6.0 | 19.4 |
| hybrid: lexical+aspect only | 0.813 | 0.626 | 0.849 | 0.997 | 0.768 | 0.812 | 0.967 | 1.000 | 0.150 | 0.000 | 0.352 | 5.1 | 12.5 |

## Safety / abstention

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

## Per-query NDCG@5 (ranked list), core modes

| query | split | tags | lexical | semantic | hybrid (relevance-first) | hybrid (social-aware) |
|---|---|---|---|---|---|---|
| q01 | dev | headline, multi_aspect, indirect | 0.92 | 0.93 | 0.83 | 0.83 |
| q02 | test | multi_aspect, direct | 0.83 | 0.71 | 0.80 | 0.84 |
| q03 | dev | direct, negative_evidence | 0.92 | 0.55 | 0.78 | 1.00 |
| q04 | test | indirect, no_keyword_overlap | 1.00 | 0.53 | 0.93 | 1.00 |
| q05 | dev | negative_evidence, neighborhood_inferred | 0.07 | 0.00 | 0.93 | 0.93 |
| q06 | test | hard_constraint_firsthand, multi_aspect | 0.92 | 1.00 | 1.00 | 1.00 |
| q07 | dev | hard_constraint_time, neighborhood_inferred | 0.80 | 0.35 | 0.70 | 0.60 |
| q08 | test | hard_constraint_channel, inner_circle | 0.70 | 0.65 | 1.00 | 1.00 |
| q09 | dev | no_inner_circle_evidence, wider_fallback, unauthorized_private | 0.90 | 0.91 | 0.91 | 0.91 |
| q10 | test | wider_only, unauthorized_private, multi_aspect | 0.93 | 1.00 | 1.00 | 1.00 |
| q11 | dev | social_graph_variation, inner_circle_available, multi_aspect | 1.00 | 0.85 | 1.00 | 1.00 |
| q12 | test | multi_aspect, direct | 0.93 | 0.79 | 1.00 | 0.90 |
| q13 | dev | indirect, multi_aspect | 0.75 | 0.36 | 0.83 | 0.85 |
| q14 | test | indirect, contradiction_on_wifi | 0.74 | 0.51 | 0.57 | 0.74 |
| q15 | dev | negative_evidence, sparse_relevant | 0.50 | 0.79 | 1.00 | 1.00 |
| q16 | test | contradiction, multi_aspect | 0.37 | 0.57 | 0.69 | 0.39 |
| q17 | dev | social_graph_variation, inner_circle_available, unauthorized_private | 0.78 | 0.82 | 0.83 | 0.77 |
| q18 | test | multi_aspect, negative_evidence, near_duplicates | 0.92 | 1.00 | 1.00 | 1.00 |
| q19 | dev | multi_aspect | 0.81 | 0.78 | 0.70 | 0.83 |
| q20 | test | wider_only, unauthorized_private | 0.88 | 1.00 | 1.00 | 1.00 |
| q21 | dev | direct, near_duplicates | 1.00 | 1.00 | 1.00 | 1.00 |
| q22 | test | negative_evidence | 0.83 | 0.52 | 1.00 | 0.99 |
| q23 | dev | multi_aspect | 0.71 | 0.74 | 0.69 | 0.53 |
| q24 | test | empty_results, unknown_location | abstained ✓ | abstained ✓ | abstained ✓ | abstained ✓ |
| q25 | dev | empty_results, insufficient_evidence | abstained ✓ | abstained ✓ | abstained ✓ | abstained ✓ |
| q26 | test | neighborhood_inferred, multi_aspect, contradiction | 0.64 | 0.89 | 0.71 | 0.61 |
| q27 | dev | multi_aspect, direct | 1.00 | 0.92 | 1.00 | 1.00 |
| q28 | test | direct, negative_evidence | 0.73 | 0.77 | 0.98 | 0.97 |
| q29 | dev | hard_constraint_time, negative_evidence | 0.62 | 0.79 | 0.60 | 0.51 |
| q30 | test | duplicates, direct, keyword_style | 0.90 | 0.84 | 0.93 | 0.93 |
| q31 | dev | unverifiable_constraint | 0.00 | 0.45 | 0.93 | 1.00 |
| q32 | test | short_query, direct | 0.30 | 0.65 | 0.62 | 0.44 |
| q33 | dev | high_rated_irrelevant_for_other_queries, direct | 0.86 | 0.86 | 0.75 | 0.52 |