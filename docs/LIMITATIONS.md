# Limitations (read before relying on any result)

## Data and evaluation
* **Everything is synthetic and was authored by one party** (the AI assistant that built the project): 108 opinions, 21 users, the relationship graph, the 387 relevance judgments, the aspect labels, *and* the rule-based aspect lexicon. Authors' knowledge of the lexicon and corpus design makes the benchmark easier than reality and probably inflates the aspect signal. No independent human annotators, no inter-annotator agreement.
* 33 queries, one pooled judgment per pair, unjudged = 0. Small differences (< ~0.03 NDCG) are noise. Only headline comparisons were bootstrapped; ablations were not.
* Candidate recall is nearly trivial (≈1.0) because the candidate pool (50) is comparable to the visible corpus per city.
* Hard-constraint and leak metrics are checked with independent code, but by the same author.
* Latency was measured on a 108-row corpus on a 1-vCPU sandbox and says nothing about scale.
* Duplicate and relevance thresholds were calibrated on this corpus; real data will have paraphrased copies the Jaccard rule misses.

## Retrieval and ranking
* **Embeddings:** the only evaluated embedding model is static averaged GloVe. No contextual/neural embedding model was evaluated (none was reachable). The OpenAI-compatible provider is tested against a mock server only. `semanticMin = 0.5` is specific to GloVe-100/SIF.
* **Aspect extraction and polarity are lexicon heuristics** (~20 aspects, crude negation window, sentence-level). They miss novel phrasing and mislabel sarcasm; they are *not* semantic understanding.
* **Query-side polarity/negation is not modelled** ("I don't need wifi", "not good for laptops", "cheap", "dark streets"); this is the main measured failure class.
* Neighborhoods are only soft context; English only; no stemming beyond a small suffix stripper in JS (PostgreSQL's `english` configuration is used for FTS).
* The lexical baseline is an OR-query over keywords; no phrase/proximity handling beyond `ts_rank_cd`.
* **Scale:** semantic search is an exact scan over a `vector` column without ANN index. For large corpora create a per-model expression index, e.g. `CREATE INDEX ON opinion_embeddings USING hnsw ((embedding::vector(100)) vector_cosine_ops) WHERE model = '<model key>'`, and query with the matching cast. Not implemented or tested here.
* Reviews are subjective: the system surfaces and summarises opinions; it does **not** establish whether a place is objectively safe. "Independent corroboration" counts distinct authors only; independence is never proven (copied or coordinated reviews are possible).

## Social graph, accounts and security
* Authentication is real but **minimal**: email + password, server-side sessions, rate limiting, CSRF origin check, CSP. Not provided: **email verification** (anyone can register any address), **password reset by email**, **MFA**, breached-password lookup (small built-in denylist only), a shared rate limiter (limits are per process), audit logging, and a security review. Details and trade-offs: `docs/AUTH.md` §8.
* Registration reveals whether an email is already registered (409). Display names are not unique, so name impersonation is possible.
* The inner circle is created by users' own accepted requests and a single shared `closeness` number per relationship (either party may change it); there is no per-opinion consent beyond four visibility levels, no groups/lists, no revocation history.
* User-posted opinions are **unmoderated**; there is a per-user cap (500) and write rate limits, nothing more.
* Search-run logs keep the user's query text and parsed intent (not opinion text). Treat queries as personal data and define retention.
* Evidence items show the author's display name next to authorized evidence for attribution; decide what identity detail you want to expose in a real deployment.

## Datasets
* **No dataset is bundled and none was verified on its real files** (the authoring environment could not reach Zenodo, Inside Airbnb, Kaggle, UCI or Hugging Face). The importer is tested on synthetic fixtures that imitate the documented layouts; the TripAdvisor-Dyadic adapter infers column names from the record description and will fail loudly (listing detected headers) if they differ — use `--map`.
* Licence notes come from pages read while building (CC BY-NC 4.0 for the TripAdvisor record; Inside Airbnb's data policies asking users not to republish). **Re-read the licence for your copy before use.** CC BY-NC means no commercial use; the Inside Airbnb source is hidden from other users in production by default.
* PII handling is **pattern masking** (emails, links, phone-like numbers, handles) and pseudonymous authors; **personal names inside review text are not detected**.
* `firsthand = true` for imported rows is an assumption about the platforms; English detection is a heuristic; the aspect lexicon covers ~20 concepts, so real review text will show lower aspect coverage and noisier polarity than the synthetic benchmark.
* **No accuracy metric exists for imported data** (no relevance judgments); `dataset:verify` is a qualitative spot-check.

## Providers
* LLM query understanding, LLM answers and Brave web search are implemented behind provider interfaces. Mock-server tests validate request handling; model names and availability depend on the configured provider.
* Answer *quality* (faithfulness, helpfulness) is not measured; only mechanical grounding (cited ids ⊆ selected evidence) is enforced.
* Web results are never fused into the social ranking; they are a separate, labelled channel.

## Operations
* Behind-a-real-HTTPS-proxy behaviour of cookies/CSRF/rate limits, Docker Compose, the production `Dockerfile` (its stages were simulated without Docker), `prisma migrate deploy`, Groq/Cloudflare/Neon/Render deployment, and the Windows PowerShell instructions were **not executed** in the build environment (see README "Verification status").
* No ESLint configuration; `npm run typecheck` is the static check.
* The semantic index is not refreshed automatically when opinions change; run `npm run embeddings:index`.
* `npm run db:seed` truncates the corpus (and therefore embeddings) — development only.
