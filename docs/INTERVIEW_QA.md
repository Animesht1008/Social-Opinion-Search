# Cross-questions and answers — Social Opinion Search

How to use this file: read **Part A** to defend the *project and its decisions*, **Part B** for the *tech-stack basics and definitions*, **Part C** for *search/ML concepts*, **Part D** for *scenario questions*, and **Part E** for the *uncomfortable honesty questions*. Answers are written the way you could say them aloud; the "Cross-question" lines are the follow-ups an interviewer is likely to push with.

> **Rule for answering well:** never claim more than the project proves. The strongest answers say what was measured, what was assumed and what is unverified (see Part E).

**Contents** — A. Project & design · B. Tech stack fundamentals · C. Search, ranking & ML concepts · D. Scenario / scaling / "what would you change" · E. Honesty & limitations · F. Rapid-fire definitions · G. Authentication & security (added) · H. Datasets, licences & data governance (added)

---

# A. Project and design questions

### A1. In one minute, what does this project do?
It answers natural-language questions about places ("where should I stay in Mumbai so I can return late at night — consider lighting, isolation and transport") by **retrieving the few most relevant opinions** from a corpus of social opinions, ranking them transparently, enforcing who may see which opinion, and then summarising them with citations — using an LLM only on the already-selected, already-authorized evidence. The hard part is retrieval, not text generation.
**Cross-question: why not just ask an LLM?** An LLM can't scan a large private corpus, may invent reviews, and would see data it shouldn't. Retrieval narrows the corpus to a handful of authorized, relevant opinions first; the LLM only summarises them and its citations are verified.

### A2. Is this collaborative filtering?
No, and the project says so. Collaborative filtering predicts what *you* will like from *other users' interaction patterns* (clicks, ratings). Here the central problem is **query-conditioned retrieval**: which opinions *answer this question*. Social context (who wrote it, relationship) is a separate, optional, gated signal. No collaborative method is implemented because there is no interaction data.
**Cross-question: could CF be added?** Yes, as an extra feature once interaction logs exist (e.g. matrix factorisation over user–place interactions as one more component score), but it would need its own evaluation and could not replace content relevance.

### A3. Why PostgreSQL for search instead of Elasticsearch plus a vector database?
One system holds relational data, full-text search (`tsvector` + GIN index) and vectors (`pgvector`). That means **access control is applied in the same SQL as retrieval**, transactions are simple, and local setup is one container. The cost: less sophisticated text-analysis features than Elasticsearch and no built-in ANN index at the default setup. For a corpus of this size (and into the hundreds of thousands of rows) that's a good trade; at very large scale you would reconsider.
**Cross-question: does Postgres FTS handle synonyms/typos?** Not by default (stemming and stopwords only). That's exactly why we add embeddings and the aspect lexicon.

### A4. Explain the three retrieval modes.
* **Lexical:** PostgreSQL full-text search. The question's keywords are OR-ed into a `tsquery`; `ts_rank_cd` ranks matches. Fast, exact on words, blind to synonyms.
* **Semantic:** the question and every opinion are turned into embedding vectors; pgvector returns the nearest vectors by cosine similarity. Matches meaning, but can return plausible-looking irrelevant text.
* **Hybrid:** take the union of both candidate sets (de-duplicated by opinion id), complete each candidate's missing scores, then **re-rank** with extra signals (aspect coverage, context match, specificity, provenance, freshness).
They are genuinely distinct — different candidate generators and different scoring.

### A5. What is an "indirect match" and how do you get it?
An opinion that describes the concept without using the query's words — e.g. "I counted maybe three other people on the street at 1 am" for a question about *isolation*. Keyword search misses it. We catch it with (1) embeddings (similar meaning) and (2) an aspect lexicon that maps phrases like "nobody around", "deserted" to the aspect *foot traffic / isolation*. The trace in `PROJECT_DEEP_DIVE.md §9` shows `op_m12`, which has no lexical match at all but still ranks 5th.

### A6. How does the ranking work? Is it a black box?
No. Every candidate carries its component scores: lexical, semantic, aspect coverage, context match, specificity, provenance, freshness, social boost, redundancy. In hybrid mode the score is a weighted mean of the available components; in lexical/semantic modes it's just that signal. The response includes an explanation list for each candidate, and the UI shows bars per component.
**Cross-question: how did you pick the weights?** Honestly: mostly a-priori. A few were checked with one-at-a-time experiments on a dev split; the data showed most weights are in a flat region (changes within noise). I do not claim they are optimal.

### A7. Why keep negative and contradictory opinions? Don't they hurt ranking?
For a safety-style question, the negative report is the most valuable one. So polarity is an *evidence characteristic*, not a penalty. We even have a balancing step: if the selected evidence is one-sided on an aspect and an eligible opposite-polarity opinion exists, it replaces the lowest-ranked item, and the reason is recorded. The answer then reports disagreement explicitly.

### A8. How do you handle duplicates?
Two cases: **explicit reposts** (`repost_of_id`) and **near-duplicate wording** (word-bigram Jaccard ≥ 0.5). Duplicates are clustered; the best one represents the cluster; the others are *suppressed from the selected evidence* (still in the database and listed in the response with the reason). Crucially, we don't count duplicates as independent corroboration — `independentFirsthandSources` counts distinct firsthand authors of non-repost opinions.
**Cross-question: what if someone paraphrases a review?** A paraphrase has low Jaccard and would be treated as independent. That's a known limitation; embedding-similarity clustering could help.
**Cross-question: why 0.5?** Measured on this corpus: duplicates scored 0.63–1.00, the most similar non-duplicates ≤ 0.14, so 0.5 sits in the gap. On real data it must be recalibrated.

### A9. Explain the privacy model.
Each opinion has a visibility (`PUBLIC`, `CONNECTIONS`, `INNER_CIRCLE`, `PRIVATE`). The requester's relationships define their connections and inner circle. The rule is enforced **inside the SQL `WHERE` of every retrieval query** so unauthorized rows never leave the database; the application re-checks after fetching and throws on violation; logs store only ids and scores; the LLM prompt contains only selected authorized evidence (no author identities). Pending and blocked relationships grant nothing; blocked users' public opinions are hidden too.
**Cross-question: how do you know it works?** Integration tests assert absence of forbidden ids/texts in every response part for all modes; an equivalence test compares SQL and TypeScript predicates for all 21 users × 108 opinions; and I mutation-tested it by deliberately breaking the code and confirming the tests fail. The evaluation also uses an independently written oracle and a 594-search leak sweep (0 leaks).

### A10. What is the inner circle and how is it generated?
It is a **rule over stored relationships**: an `ACCEPTED` relationship whose type is in `INNER_CIRCLE_TYPES` (default FRIEND, FAMILY) and whose `closeness` ≥ `INNER_CIRCLE_MIN_CLOSENESS` (default 4). In the demo the relationship rows are synthetic, written by me in `data/seed/relationships.json`. In production, rows come from friend-request events (pending → accepted) and from user/app settings for type and closeness. Nothing is inferred from behaviour.
**Cross-question: so is "being in the inner circle" proof that they really know each other?** No — it's a flag in the data. It is exactly as trustworthy as the source that created the relationship.
**Cross-question: does inner circle rank higher?** Not by default. Only in `social_aware` mode, and then only via a small boost gated by content relevance — it cannot rescue irrelevant text.

### A11. Where did the data come from?
**The data bundled with the project is synthetic and I (the AI assistant that built it) wrote it:** 108 opinions, 21 users, 12 relationships, 33 queries, 387 judgments — nothing was downloaded or scraped. Reasons: no legally usable dataset with a real friendship graph exists; the brief forbids scraping restricted sources; and the brief requires deliberately engineered edge cases (duplicates, pending/blocked relationships, a 5-star irrelevant review). Two other kinds of opinion can now exist in the database: posts by registered users (`user-generated`) and rows **imported from public datasets that you download yourself** (see Part H). The only external artefact shipped or fetched by the project is the GloVe embedding file (public, PDDL).
**Cross-question: doesn't that make your evaluation meaningless?** It makes the *absolute* numbers optimistic and not predictive of real-world accuracy, and I say so. It still shows that the pipeline behaves as designed and supports *relative* comparisons (hybrid vs lexical), with caveats.

### A12. Why GloVe? Isn't that outdated?
It's a real learned embedding, free, and downloadable from a host reachable in my build environment (hosted embedding APIs weren't), which let me run a fully offline, reproducible evaluation. It's static (one vector per word), so weaker than contextual sentence encoders. The system treats embeddings as pluggable: any OpenAI-compatible endpoint (OpenAI, Cloudflare Workers AI, Ollama, vLLM…) works by configuration, with per-model vector keys.
**Cross-question: what changes when you switch to a better model?** Re-run `embeddings:index`, then re-tune `semanticMin` (the admission threshold is model-specific: cosine distributions differ), then re-run `npm run eval`.

### A13. How is the query understood?
A deterministic rule parser produces a validated structured intent: location (hard filter), topic (soft), aspects, keywords, hard constraints (firsthand-only, time window, inner-circle-only), unverifiable "must" constraints (disclosed, not applied), soft preferences, temporal hints, ambiguities. Optionally an LLM proposes the same structure; its output is **schema-validated and grounded** — e.g. a city must appear in the query text, otherwise it's dropped with a warning.
**Cross-question: why not trust the LLM?** Models can hallucinate a constraint ("firsthand only") that silently removes valid results. Grounding limits that.

### A14. What happens with a hard constraint you can't verify, like "must have a swimming pool"?
We don't have a structured field for amenities, so we can't filter on it. The system records it as an `unverifiable` constraint, shows it in the parsed intent, warns "cannot be verified and was NOT applied", and does not pretend otherwise.

### A15. What happens when there's no good evidence?
The relevance gate rejects irrelevant opinions; if none pass, adequacy is `insufficient`, the answer says "Insufficient evidence… no recommendation is made", and the LLM is not called. Example: "visiting Lisbon" → the city filter is enforced → zero results → abstain (it does not return Mumbai results).

### A16. What if there are no inner-circle opinions?
The pool contains all authorized opinions; if none from the inner circle are relevant, the response warns "No relevant inner-circle opinions were found… absence of friend opinions says nothing about the place itself" and continues with wider social/public evidence (and web evidence if configured).

### A17. How do you prevent the LLM from fabricating citations?
The prompt requires citing ids from the provided evidence; after generation we extract every `[id]` and every cited id and verify they're all in the selected evidence. If any isn't, the entire LLM answer is discarded and the deterministic summary is returned with a warning.
**Cross-question: prompt injection?** Opinions are user-generated text, so someone could write "ignore previous instructions…". Mitigations in place: the LLM has no tools or side effects, only sees ≤10 short opinions, must return JSON, and its citations are verified. Not fully solved — a malicious opinion could still skew wording. Further steps: delimiting/escaping untrusted text, a moderation pass, and output checks.

### A18. What does "grounded answer" mean?
Every claim should be traceable to a retrieved opinion; the answer cites ids, states the channel (inner-circle / wider social / web) and whether it is firsthand, surfaces disagreement and gaps, and adds a caveat that reviews aren't verified facts or proof of safety.

### A19. How did you evaluate? Are the numbers trustworthy?
33 queries, graded relevance (0–3), P@5, NDCG@5, recall, aspect coverage, constraint satisfaction, duplicate rate, abstention, latency, leaks. Tuning on a dev half, reporting on a test half, paired bootstrap CIs for the headline comparisons. Trustworthy *as measurements*, limited *as evidence*: one author wrote everything, n=33, small differences are noise.
**Cross-question: what do your numbers say?** Hybrid (NDCG@5 0.861) beat lexical (0.749) and semantic (0.726); hybrid−lexical +0.112 with a CI excluding zero. Social-aware vs relevance-first: −0.02, CI includes zero. Zero leaks.
**Cross-question: what is NDCG?** See C6.

### A20. What are the failure cases?
Mostly **query-side negation/polarity**: "I don't need wifi" is parsed as wanting wifi; "not good for laptops" ranks laptop-friendly places; "cheap" matches expensive reviews. Because polarity isn't a ranking signal, an aspect match counts regardless of stance. Fix: parse the desired stance per aspect and match it against stored polarity.

### A21. Why is the hybrid score a weighted sum? Why not Reciprocal Rank Fusion or a learned ranker?
A weighted sum of interpretable components is transparent and easy to debug/ablate, and works without training data. RRF fuses *ranks* and ignores score magnitudes — a reasonable alternative baseline. A learned-to-rank model (LambdaMART) or cross-encoder re-ranker would likely do better but needs far more labelled data (and for cross-encoders, GPU/latency budget). With 33 queries a learned ranker would overfit.

### A22. Why OR instead of AND in the full-text query?
Questions are long and conversational; AND would require every word to appear and usually match nothing. OR retrieves anything with some overlap, and the ranking (plus the relevance gate) sorts out quality.

### A23. What is `ts_rank_cd(..., 32)`?
`ts_rank_cd` is PostgreSQL's "cover density" ranking (rewards matched terms close together). The `32` flag normalises the score as `rank / (rank + 1)`, giving a bounded [0,1) value independent of document length — which lets us use absolute thresholds.

### A24. Why a *generated* `tsvector` column?
`search_vector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED` is maintained by Postgres automatically whenever `text` changes — no application code can forget to update it, and the GIN index on it makes `@@` queries fast.

### A25. Why is the vector column unconstrained and in a separate table?
Different embedding providers have different dimensions. Keying by `(opinion_id, model)` means each model has its own vectors, queries always filter `WHERE model = …`, and a vector from model A can never be compared with one from model B. The trade-off: no default ANN index (you create an expression HNSW index per model if needed).

### A26. Why the MMR step? What's the formula?
Top-k by score often returns near-identical results. MMR picks results that are relevant *and* different: `λ·(score/topScore) − (1−λ)·maxSimilarityToAlreadyChosen − 0.05·(same-author count)` with λ = 0.75.

### A27. What does the relevance gate do and why is it needed?
It decides whether an opinion may be evidence at all. Without it, a fresh, firsthand, specific but off-topic 5-star review could outrank on-topic ones through the quality components, and "top-k" would always return something even when nothing is relevant. The gate is also how abstention works.

### A28. How is "social-aware" ranking different, and why is it gated?
It adds up to 0.08 × (closeness strength) × (relevance gate) to the score. The gate is a smoothstep over content relevance, so for irrelevant text the boost is ≈ 0. This encodes "a friend's generic opinion may be less relevant than a specific report from another source". Measured effect on content relevance: no measurable difference; we make no claim that it improves user-perceived quality.

### A29. How does the API handle failures of external providers?
Fail soft and disclose: LLM down → deterministic summary + warning; intent LLM down → rule parser + warning; web search down → status `error`, social retrieval continues; embeddings missing → 503 (or explicit labelled fallback). Misconfiguration at startup fails fast with a clear message.

### A30. How is the UI safe from XSS?
Opinion text is untrusted user content. The UI builds DOM nodes with `textContent`/`createTextNode` only; it never uses `innerHTML` with data.

### A31. How does authentication work? (the old `x-user-id` header is gone)
Email + password; passwords hashed with scrypt; a successful login creates a server-side session whose random token is stored only as a SHA-256 hash; browsers get it in an HttpOnly, SameSite=Lax cookie, API clients can ask for a Bearer token. Details and trade-offs in Part G and `docs/AUTH.md`. The downstream authorization (who may see which opinion) is unchanged; it now receives a *verified* user id.

### A32. How reproducible is the evaluation?
The reference date is pinned, the intent parser is deterministic (no LLM), the DB is rebuilt from the same seed, embeddings come from a fixed model file. A clean-checkout run produced identical lexical metrics.

---

# B. Tech-stack fundamentals

## B1. JavaScript, TypeScript, Node.js

### What is JavaScript?
A dynamically typed, interpreted-by-engine programming language originally for browsers, now also used on servers. It is single-threaded with an **event loop**: slow operations (network, disk) are asynchronous (callbacks, Promises, `async/await`) so one thread can serve many requests.

### What is TypeScript and how does it differ from JavaScript?
TypeScript = JavaScript + a **static type system**. You annotate (or infer) types; the compiler (`tsc`) checks them and then *erases* them, emitting plain JavaScript. Differences: compile-time checking (catch typos/wrong shapes before running), interfaces/generics/enums, better editor tooling. **Types do not exist at runtime**, so untrusted data (HTTP bodies, env vars, LLM output) must still be validated at runtime — that's why we use Zod.
**Why TypeScript here?** The code passes many structured objects (intents, scores, records); the compiler catches mismatches. `strict` and `noUncheckedIndexedAccess` are enabled for extra safety.

### What is Node.js?
A JavaScript runtime (built on Chrome's V8 engine) that runs JS outside the browser, with APIs for files, networking, processes. Version 22 here (≥ 20.11 required). It has built-in `fetch`, `AbortSignal.timeout`, etc.

### What is the event loop? Why does it matter?
Node runs your JS on one thread; when you `await` an I/O call, the thread is free to handle other requests. CPU-heavy work (e.g. loading 100k GloVe vectors, big loops) blocks everyone — a reason GloVe is loaded once at startup, and a reason for scale-out.

### `npm`, `package.json`, `package-lock.json`, `node_modules`
`npm` is Node's package manager. `package.json` lists dependencies and **scripts** (`npm run dev`). `package-lock.json` pins exact versions so `npm ci` reproduces the same tree. `node_modules` is where packages are installed (never committed).

### ES modules vs CommonJS
Two module systems. ESM (`import x from "y"`, `"type": "module"`) is the modern standard; CommonJS uses `require()`. We use ESM, so relative imports include the `.js` extension even in `.ts` files (TypeScript's NodeNext resolution).

### `async/await` and Promises
A Promise represents a future value. `await` pauses the function until it resolves without blocking the thread. Errors become exceptions (`try/catch`).

### What does `tsx` do vs `tsc`?
`tsc` compiles TS to JS (`npm run build` → `dist/`) and type-checks (`npm run typecheck` uses `--noEmit`). `tsx` runs TS directly in development *without* type-checking.

## B2. Fastify, HTTP, REST

### What is Fastify and why not Express?
A high-performance Node web framework: routes, hooks, JSON serialisation, plugins, logging (pino). Chosen for speed, a clean plugin model and good TypeScript support; Express is older/simpler but slower and with less built-in structure.

### What is a REST API? Which status codes do you use?
REST = resources identified by URLs manipulated with HTTP verbs. We use: 200 OK, 400 validation error, 401 unauthenticated/unknown user, 404 not found (also used for "not yours" to avoid revealing existence), 413 payload too large, 500 internal error, 503 service unavailable (semantic retrieval not available).

### What is a request body limit and why?
Fastify's `bodyLimit` (16 KB) rejects giant payloads (a cheap denial-of-service guard).

### What are headers? Which ones matter here?
Key–value metadata on HTTP requests/responses. Here: `Authorization: Bearer …` (API credentials), `Cookie`/`Set-Cookie` (browser session), `Origin` and `Sec-Fetch-Site` (CSRF check), `Content-Security-Policy` and friends (response hardening), `Retry-After` (rate limiting).

### CORS?
Browser rule restricting cross-origin requests. Our UI is served by the same server (same origin), so no CORS config is needed. A separate front-end domain would need CORS settings.

### Rate limiting?
Limiting requests per client/time to protect resources (each search can trigger LLM calls). Not implemented; recommended before public use (`@fastify/rate-limit`).

## B3. Zod and validation

### What is Zod?
A TypeScript-first runtime schema library: define a schema, `parse()` data, get either a typed value or detailed errors. Used for: request bodies, environment variables, LLM JSON output, the intent object. `.strict()` rejects unknown keys.

### Why validate LLM output?
Models return text that *should* be JSON but may not be; validating prevents malformed/malicious structure from flowing into code.

## B4. Environment variables

### What is `.env`/`dotenv`? Why not hard-code?
Environment variables hold configuration and secrets outside code. `dotenv` loads `.env` into `process.env`. Secrets must never be committed; `.env` is git-ignored, `.env.example` documents the variables.

## B5. Docker

### What is Docker? Image vs container?
Docker packages an app with its dependencies so it runs the same everywhere. An **image** is a read-only template (like a class); a **container** is a running instance (like an object). A **Dockerfile** is the recipe for an image. **Docker Compose** defines multi-container setups in YAML.

### Why Docker here?
Locally: to run PostgreSQL 16 *with the pgvector extension* without installing anything (`docker compose up -d`). In production: the `Dockerfile` builds the app image.

### What is a volume? A healthcheck? A multi-stage build?
A **volume** persists data outside the container (our Postgres data). A **healthcheck** is a command Docker runs to see if the container is healthy. A **multi-stage build** uses one stage to build (compilers, dev deps) and copies only the results into a smaller runtime stage.

### What does `docker compose up -d` do?
Starts the defined services in the background (`-d` = detached).

### What is `.dockerignore`?
Files excluded from the build context (node_modules, .env, tests) — smaller images and no leaked secrets.

## B6. PostgreSQL and SQL

### What is PostgreSQL? What is SQL?
An open-source relational database. SQL is the language for defining and querying tables.

### Primary key, foreign key, unique constraint, CHECK constraint?
Primary key uniquely identifies a row; foreign key references another table's key (integrity); unique prevents duplicates (e.g. one relationship row per user pair); CHECK enforces a condition (closeness between 1 and 5).

### What is an index? Why GIN?
An index speeds lookups at the cost of writes/space. **GIN** (Generalized Inverted Index) maps each word to the rows containing it — ideal for full-text search (`tsvector`).

### What are `tsvector` and `tsquery`?
`tsvector` = a document normalised into stemmed, stop-word-free tokens with positions; `tsquery` = a search expression; `@@` tests a match; `ts_rank_cd` ranks.

### What is a transaction / ACID?
A transaction groups statements atomically. ACID = Atomicity, Consistency, Isolation, Durability. Our migration runner wraps each migration in a transaction.

### What is an enum type?
A column limited to named values (e.g. `Visibility`: PUBLIC, CONNECTIONS, INNER_CIRCLE, PRIVATE).

### What is SQL injection? How do you avoid it?
Attackers injecting SQL via input. We never concatenate user input into SQL; Prisma's `sql` template turns `${value}` into **bound parameters**. The only raw identifier (`o`) is a constant.

### What is connection pooling (PgBouncer, Neon pooler)?
Reusing a limited set of DB connections across many clients. Serverless/free hosts favour pooled connections for the app, direct connections for migrations.

### What is a `JOIN`? A `CTE`?
JOIN combines rows from tables; a CTE is a named sub-query. We use JOINs (opinions ↔ users/places/embeddings).

## B7. pgvector

### What is pgvector?
A Postgres extension adding a `vector` type and distance operators: `<=>` cosine distance, `<->` Euclidean, `<#>` negative inner product. Supports exact search and ANN indexes (HNSW, IVFFlat).

### Exact vs approximate (ANN) search?
Exact compares to every row (accurate, O(n)); ANN indexes (HNSW graphs, IVFFlat clusters) trade a little recall for big speedups. We use exact scan (fine at this size) and document how to add HNSW.

## B8. Prisma

### What is an ORM? What is Prisma?
An ORM maps database tables to code objects. Prisma provides a schema file, a typed client, and migrations. We use it for typed CRUD/seeding and use `$queryRaw` for FTS/vector SQL.

### What are migrations?
Versioned scripts that evolve the schema. Ours are hand-written SQL (Prisma can't generate tsvector/pgvector/CHECKs). `npm run db:migrate` = `prisma migrate deploy`; `db:migrate:sql` is a verified fallback runner.

### What is a driver adapter (Prisma 7)?
Prisma 7 talks to the DB through a JS driver (`pg`) via `@prisma/adapter-pg`.

### Why `Unsupported("tsvector")`?
Prisma doesn't model that type; marking it unsupported lets the schema describe the column while SQL handles it.

## B9. Testing

### Unit vs integration tests?
Unit = one piece in isolation (parser, scoring). Integration = pieces together with a real DB (search + SQL). We have 8 unit files and 6 integration files (179 tests).

### What is a mock? Why use a mock HTTP server?
A stand-in for a real dependency. Provider tests run against a local HTTP server and assert the exact request/response handling — deterministic, free, offline. It does **not** prove the real service behaves identically.

### What is Vitest? What is a global setup?
Vitest is a TypeScript-friendly test runner. A global setup runs once before all tests (we rebuild and seed the test DB).

### What is mutation testing (as done here)?
Deliberately breaking the code to check tests fail. We did this by hand for the authorization logic.

### What is a regression test?
A test that locks in a fixed bug (the "taxis" stemming bug).

## B10. Security basics

### Authentication vs authorization?
Authentication = who are you; authorization = what may you access. We have *real* authorization logic on top of a *demo* authentication.

### JWT?
JSON Web Token: a signed token containing claims (e.g. user id). The server verifies the signature to trust the identity.

### XSS? CSRF? TLS?
XSS = injected script running in a browser (avoid `innerHTML` with untrusted data). CSRF = tricking a logged-in browser into sending requests (relevant for cookie auth). TLS = encryption in transit (HTTPS; Neon requires `sslmode=require`).

### Why not log opinion text?
Logs can leak private content to people with log access; we store ids and scores only.

## B11. Git, CI/CD

### Git? `.gitignore`?
Version control. `.gitignore` lists files never tracked (`.env`, `node_modules`, `dist`, generated code, model files).

### CI/CD?
Automatically build/test (CI) and deploy (CD) on each push. Render redeploys on pushes to `main`. A CI workflow running `npm ci && npm run typecheck && npm test` is a good addition (not included).

## B12. The providers

### What is Groq?
An inference provider serving open-weight LLMs very fast with an OpenAI-compatible API (`https://api.groq.com/openai/v1`) and a free tier. Doesn't (to my knowledge) provide embeddings — hence the separate embedding provider.

### What are Cloudflare Workers AI embeddings?
Cloudflare hosts open models (e.g. `@cf/baai/bge-base-en-v1.5`, 768-d) and exposes an OpenAI-compatible `/ai/v1/embeddings` endpoint, with a free daily allowance.

### What is "OpenAI-compatible"?
An API that accepts the same request/response JSON shape as OpenAI's (`/chat/completions`, `/embeddings`). Our `openai` providers therefore work with Groq, Cloudflare, Ollama, vLLM, etc. by changing base URL, key and model.

### What are Neon and Render?
Neon = serverless Postgres (supports pgvector, scale-to-zero, pooler). Render = a hosting platform that builds and runs web services (incl. from a Dockerfile).

---

# C. Search, ranking and ML concepts

### C1. What is an embedding?
A fixed-length list of numbers representing text such that similar meanings are close. Produced by a model (GloVe averaged word vectors; bge/OpenAI transformer encoders).

### C2. Static vs contextual embeddings?
Static (GloVe/word2vec): one vector per word regardless of context ("bank" is the same). Contextual (transformers): the vector depends on the whole sentence, so they handle polysemy and phrasing far better.

### C3. Explain SIF averaging.
Sentence vector = average of word vectors where each word's weight is `a/(a+p(w))` (frequent words like "the" are down-weighted), then remove the projection on the "common direction" shared by all sentences. Arora et al., 2017. A simple strong baseline for static vectors.

### C4. What is cosine similarity? Why normalise vectors?
`cos(a,b) = a·b / (|a||b|)` — the angle between vectors, in [-1,1]. With unit-length vectors, cosine = dot product. pgvector's `<=>` returns `1 − cosine`.

### C5. Why do thresholds depend on the model?
Cosine distributions differ per model (GloVe pairs are generally high; bge differs). A threshold tuned for one model is meaningless for another — re-tune with `npm run tune`.

### C6. Define P@k, NDCG@k, recall.
* **P@k** = (relevant in top k)/k.
* **DCG@k** = Σ (2^grade − 1)/log2(rank+1); **NDCG@k** = DCG / ideal DCG ∈ [0,1], rewarding highly relevant items early.
* **Recall** = fraction of relevant items retrieved.
We also report aspect coverage, constraint satisfaction, duplicate rate, leaks, abstention.

### C7. Why graded judgments (0–3)? What are "pooled judgments"?
Graded relevance captures "highly relevant" vs "somewhat". Pooling = only judged-relevant pairs are listed; unlisted pairs count as 0 — standard IR practice.

### C8. What is a bootstrap confidence interval?
Resample the queries with replacement many times, recompute the mean difference each time; the 2.5–97.5 percentile range is a 95% CI. If it excludes 0, the difference is unlikely to be pure sampling noise (for this query set).

### C9. What is RAG?
Retrieval-Augmented Generation: retrieve relevant documents, then have an LLM generate an answer from them. This project is RAG with strict access control, evidence selection and citation checks.

### C10. What are tokens, temperature, hallucination?
Tokens = text pieces models process (and are billed for). Temperature = randomness of generation. Hallucination = fluent but unsupported output; mitigated here by grounding and citation validation.

### C11. Stemming vs lemmatization; stop words?
Stemming chops suffixes ("lights" → "light"); lemmatization uses vocabulary rules ("better" → "good"). Stop words ("the", "and") carry little meaning. PostgreSQL's `english` config does both stemming and stop-word removal; we also have a small JS stemmer for the aspect lexicon.

### C12. Jaccard similarity? Shingles?
`|A∩B|/|A∪B|` of two sets. Word-bigram **shingles** (pairs of consecutive words) make it sensitive to phrasing, good for near-duplicate detection.

### C13. BM25 vs `ts_rank_cd`?
Both rank by term statistics. BM25 (used by Elasticsearch/Lucene) uses TF-IDF with length normalisation; Postgres's `ts_rank_cd` uses term frequency and proximity (cover density) without IDF. For production-grade lexical search you could add ParadeDB/pg_search for BM25.

### C14. What is Reciprocal Rank Fusion?
Fuse several ranked lists with `Σ 1/(k + rank)`. A simple hybrid alternative to weighted score sums.

### C15. What is a cross-encoder re-ranker?
A model that reads query and document *together* and outputs a relevance score; more accurate than embeddings but slower. A possible next stage over the top 50 candidates.

### C16. What is HNSW?
Hierarchical Navigable Small World graph: an ANN index that navigates a layered proximity graph. Fast and accurate; memory-hungry; supported by pgvector.

---

# D. Scenario, scaling and "what would you change" questions

### D1. Scale to 100 million opinions?
* Shard or partition by city/region; keep authorization predicates efficient (precomputed visibility sets or ACL tables, denormalised author→connections lookups, caching `AccessContext`).
* Use ANN (HNSW) per embedding model, or a dedicated vector DB; keep the pgvector filter+ANN interplay in mind (filtering after ANN can lose recall — use iterative scans/partitioned indexes).
* Lexical: a real search engine (OpenSearch/Elasticsearch/ParadeDB) for BM25 + analyzers.
* Compute embeddings asynchronously via a queue on write; cache query embeddings.
* Two-stage ranking: cheap candidate generation → heavy reranker on top-N.
* Observability: tracing per stage (we already return stage timings).

### D2. How would you add real authentication?
Verify a session/JWT in `requireUser()` (e.g. `@fastify/jwt`, Auth0/Clerk/Supabase Auth); the rest already works from the user id. Remove `/users` and the UI user switcher.

### D3. How would you fix the negation failure?
Extend the intent to `aspects: [{aspect, desiredStance}]` (e.g. wifi: not_needed; price: cheap; lighting: dark_reports). Use the LLM parser (with grounding) or rules for "not/without/don't need/cheap/dark". At ranking time, score aspect matches by stance compatibility with each opinion's stored polarity (and exclude "not needed" aspects).

### D4. How would you improve duplicate detection?
Add embedding-similarity clustering (e.g. cosine > 0.95), author/time heuristics, and MinHash/LSH for scale.

### D5. How would you get better evaluation data?
Independent human annotators with a rubric, inter-annotator agreement, real (consented/licensed) data, larger query sets, a held-out test set never used for tuning, and user studies for the social-aware value.

### D6. How would you monitor quality in production?
Log (anonymised) query intents, adequacy rates, abstention rates, click/helpfulness feedback, latency per stage; periodic re-evaluation on a fixed benchmark; alerts on provider errors.

### D7. How do you handle GDPR "delete my data"?
Opinions cascade-delete with the user (FK `ON DELETE CASCADE`); embeddings and aspects cascade from opinions; `search_runs` cascade from users; but you'd also need to purge backups/logs and define retention for stored queries.

### D8. Latency budget?
Measured on the tiny corpus: ~4–6 ms median retrieval. In production the LLM call dominates (hundreds of ms to seconds). Options: stream the answer, cache, parallelise (web search already runs concurrently with retrieval), skip LLM intent parsing.

### D9. How would you deploy with zero downtime?
Run ≥2 instances behind a load balancer; migrations backward-compatible (expand/contract); health checks (`/health`) gate traffic.

### D10. What would you change if you had another week?
(1) real auth; (2) query-side polarity; (3) live-verify Groq/Cloudflare/Docker/`prisma migrate deploy`; (4) CI pipeline; (5) human-annotated benchmark; (6) HNSW + background reindexing; (7) a prompt-injection hardening pass.

---

# E. Honesty and limitations ("gotcha" questions)

### E1. "Is it finished?"
Feature-complete against the brief, plus real authentication, a user-managed social graph, posting, and a licence-aware dataset importer; verified in my build environment (179 tests, real-embedding evaluation, UI driven end to end in headless Chromium with no CSP violations). **Not verified:** Docker Compose/`Dockerfile` with real Docker, `prisma migrate deploy` (engine download was blocked), live Groq/Cloudflare/Brave/OpenAI/Anthropic calls (mock-tested only), behaviour behind a real HTTPS proxy, Windows commands, and — importantly — **the dataset importer on a real dataset file** (only fixtures that imitate the documented layouts). **Not built:** email verification, password reset by email, MFA, a shared rate limiter, content moderation, ESLint.

### E2. "Did you write the benchmark yourself?"
Yes — corpus, judgments, aspect labels and the lexicon all by the same author. So the numbers are optimistic. I mitigated circularity by labelling aspects manually (independent of the code's lexicon) and by using an independent authorization oracle, but it's still one author.

### E3. "Your hybrid wins — is that real?"
On this benchmark, yes: +0.112 NDCG@5 with a CI excluding zero. But the gain comes largely from the aspect signal, which is a lexicon written by the benchmark's author; the ablation without aspects drops hybrid to 0.770, and "lexical + semantic only" is 0.786. So I would not claim embeddings alone made the difference.

### E4. "Did you tune on the test set?"
No: choices were made on dev only and test was reported alongside. But with ~1 expected-empty dev query the protocol is weak, and after a bug fix the "freshness" tuning result shrank to noise — documented.

### E5. "Is the social-aware ranking better?"
Unproven. It didn't change content relevance measurably (−0.02, CI includes 0) and no experiment measures whether users value friend evidence more.

### E6. "What if I switch to a real embedding model?"
Should work by configuration (OpenAI-compatible provider, tested against a mock). You must re-index and re-tune `semanticMin`; results will differ from the GloVe numbers.

### E7. "What bugs did you find?"
The "-is" stemming bug (found by a test, fixed, everything re-run); the semantic threshold too low; duplicate threshold too high; a config edit that swallowed properties; the static-files path in the compiled build. See `PROJECT_DEEP_DIVE.md §12`.

### E8. "Is the authentication production-ready?"
It is real and tested, but minimal. Good: scrypt hashes, hashed server-side sessions, HttpOnly SameSite cookies, enumeration-resistant login, lockout, CSRF origin check, CSP, revocation everywhere, cascade deletion. Missing: email verification (anyone can register any address), password reset by email, MFA, shared rate limiting across instances, breached-password checks, audit logging, a security review. I would call it "sound foundations, not finished security".

### E9. "What if the opinions contain personal data?"
The demo corpus is synthetic. A real deployment needs consent/licensing, moderation, retention rules and a privacy impact assessment.

---

# G. Authentication and security (added)

### G1. Why scrypt? Why not bcrypt or Argon2?
All three are deliberately slow, salted password hashes. scrypt is **memory-hard** (an attacker needs lots of RAM per guess, which hurts GPUs/ASICs) and ships inside Node (`crypto.scrypt`), so there is no native module to build in Docker/PaaS. Argon2id is the current top recommendation in OWASP guidance and would be a fine upgrade; bcrypt is older, not memory-hard, and truncates long passwords. Our hash string is self-describing (`scrypt$N$r$p$salt$hash`), so raising the cost later is a config change plus transparent rehash on login.

### G2. What do N, r and p mean?
N = CPU/memory cost (2^15 here ≈ 32 MiB), r = block size, p = parallelism. Cost is tuned so one hash takes tens of milliseconds on the server — fast enough for users, slow enough to make brute force expensive.

### G3. Why a salt?
A random per-password value mixed into the hash so identical passwords produce different hashes and precomputed (rainbow) tables are useless.

### G4. Sessions vs JWT — why sessions?
Sessions are looked up server-side, so logout/password-change/disable take effect **immediately** and there is no signing key to protect. JWTs are stateless and good for service-to-service or multi-service setups, but cannot be revoked before expiry without extra state. For one app with one database, sessions are simpler and safer.
**Cross-question: doesn't a DB lookup per request hurt performance?** It is a primary-key lookup on a tiny table; it can be cached briefly if needed. Authorization queries already hit the database.

### G5. Why store only a SHA-256 of the session token?
If the database leaks, the attacker gets hashes, not usable tokens. A fast hash is fine here because the token is 256 bits of randomness (not a guessable password).

### G6. What does the cookie's `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-` mean?
* `HttpOnly` — JavaScript cannot read it (an XSS bug cannot steal the session).
* `SameSite=Lax` — not sent on cross-site POST/fetch, which blocks the classic CSRF attack.
* `Secure` — sent only over HTTPS.
* `__Host-` prefix — the browser accepts it only if it is `Secure`, `Path=/` and has no `Domain`, so a sibling subdomain cannot overwrite it.

### G7. What is CSRF and how is it handled here?
Cross-Site Request Forgery: a malicious site makes your browser send an authenticated request to ours. Defences: SameSite cookies; JSON-only endpoints; and an **Origin check** — an unsafe request carrying our cookie must come from our own origin (or have no `Origin` and no `Sec-Fetch-Site: cross-site`). Bearer-token requests are exempt because the token is not attached automatically by the browser.
**Cross-question: a bug you hit?** `new URL("http://localhost:80").host` removes the default port, while the `Host` header kept it, so legitimate requests were blocked; a test found it and both sides are now normalised with the Origin's scheme.

### G8. What is XSS and what stops it here?
Injected script running in a user's browser. We never put user text into `innerHTML` (only `textContent`), there is no inline script/style, and a strict **Content-Security-Policy** (`script-src 'self'`) would block injected scripts anyway. The CSP even blocked my own Playwright test that evaluated a string — proof it works.

### G9. How do you prevent user enumeration and timing leaks?
Login returns the same 401 message for unknown email, wrong password and disabled account; for unknown emails we still verify a dummy hash so response time looks the same. Friend search only exposes accounts to signed-in users, and blocked/unknown users look identical ("no such user"). **Exception (documented):** registration returns 409 for an existing email.

### G10. How is brute force handled?
Per-IP limits (30 logins per 15 min, 10 registrations per hour) and a per-(email, IP) failure lockout (5 failures → 429 with `Retry-After`; even the correct password is refused until the window ends). Limits are in-memory per process — behind several instances use a shared store.
**Cross-question: can an attacker lock a victim out?** Partly: the lockout key includes the IP, so an attacker can only lock *their own* IP out of that account, not the victim from their own device.

### G11. What happens on password change / delete account?
Change needs the current password, applies the policy, and **revokes every other session**. Delete needs the password and removes the user; `ON DELETE CASCADE` removes sessions, relationships, opinions (with aspects and embeddings) and search runs.

### G12. Why no password reset by email?
There is no email channel in the project, so a reset link cannot be delivered. The recovery path is an operator command (`npm run user:admin -- set-password …`). Adding email would also allow email verification — both are on the "not done" list.

### G13. How does real authentication connect to the inner circle?
The session gives a verified user id; `loadAccessContext` reads that user's relationship rows; the same SQL predicate decides visibility. Users now create those rows themselves (request → accept → type/closeness), so the inner circle is something a person can inspect and edit in the UI.

### G14. What is the difference between authentication and authorization in this project?
Authentication = proving who you are (password → session). Authorization = what you may see (relationships + visibility + data-source policy). They are separate modules; a test suite mutation-checks the second.

### G15. What would you add next for security?
Email verification and reset, MFA (TOTP/WebAuthn), shared rate limiting (Redis or edge), breached-password checks (k-anonymity API), audit logs and alerting, session/device list, content moderation for posts, and an external security review.

# H. Datasets, licences and data governance (added)

### H1. You were asked to use a public dataset. Which one did you use?
None is bundled, and **I could not download any real dataset in my build environment** (it could reach GitHub/PyPI/npm only). I built an importer instead and documented the realistic sources: the TripAdvisor "Dyadic Context" restaurant reviews (CC BY-NC 4.0) and Inside Airbnb (private analysis only). The importer is verified on synthetic fixtures that imitate their layouts; the first real import is on the user's machine.
**Cross-question: isn't that dodging the task?** It is the honest outcome of two constraints: licences (non-commercial, "do not republish") and access. Shipping those datasets would have meant redistributing data I have no right to redistribute, and I could not have tested it anyway. The deliverable is a tested, governed import path plus a verification script.

### H2. What are the licence terms you have to respect?
CC BY-NC 4.0: attribution required, no commercial use. Inside Airbnb: attribute and cite; the data policies ask users not to republish the data, so I flag it `publicDisplayAllowed=false` — stored for private analysis, hidden from other users in production. Always re-read the licence of your copy.

### H3. How does the system enforce those terms?
`data_sources` rows carry `commercialUseAllowed` and `publicDisplayAllowed`. The importer refuses to run without `--accept-license <ID>`. The SQL authorization predicate hides non-displayable sources when the policy says so (automatic in production). The UI and API show licence + attribution with every result, and a "non-commercial licence" chip.

### H4. How is personal data in reviews handled?
Reviewer names are never read; authors become pseudonyms `pub_<code>_<hash>` from an HMAC with a random per-run key that is discarded (irreversible, unlinkable across imports). Emails, URLs, phone-like numbers and @handles are masked. **Names inside free text are not detected** — so the data is not claimed to be anonymised.

### H5. Why does the benchmark ignore imported data?
Imported rows have no relevance judgments; if they were included they would be counted as irrelevant and silently distort every metric. The evaluation filters to the synthetic corpus, and a test plus a full re-run confirmed identical metrics with imports present.

### H6. Can you tell me how good retrieval is on the real dataset?
No, and the project says so. There is no judged sample, so no accuracy number is reported. `npm run dataset:verify` prints probe-query results for a human to read. A proper evaluation would need annotated queries on that data.

### H7. What bug did the importer tests reveal?
A failed import (wrong file) deleted previously imported data because removal happened before header validation. Fixed with a pre-flight check and a test that asserts earlier data survives.

### H8. What does the importer do to each row?
Stream CSV → map columns (alias-tolerant, fails loudly with detected headers) → strip HTML → mask PII → filter by length, English heuristic, valid date → deduplicate → pseudonymise author → store with aspects and provenance → update the source's counts/date range.

### H9. Why a registry of sources instead of free-form imports?
So the licence claims live in one reviewable place and each source has explicit governance flags. A `generic` path exists for any CSV, but it requires you to supply the licence metadata and acknowledgement.

### H10. What would you do before showing imported data publicly?
Confirm the licence for your exact copy, keep non-commercial data off commercial deployments, keep "do not republish" data hidden, add a takedown path, review PII masking on a sample, add moderation, and measure retrieval quality on a judged sample.

# F. Rapid-fire definitions

| term | definition |
|---|---|
| API | a defined interface for programs to talk to each other |
| endpoint | one URL + method of an API |
| JSON | text format for structured data |
| schema | a formal description of data shape |
| middleware/hook | code that runs before/after request handlers |
| idempotent | repeating the operation has the same effect (our `embeddings:index`) |
| ORM | maps tables to objects |
| migration | versioned database schema change |
| index (DB) | data structure for fast lookup |
| tsvector | normalised searchable document |
| vector | list of numbers |
| cosine distance | 1 − cosine similarity |
| ANN | approximate nearest neighbour search |
| HNSW | graph-based ANN index |
| MMR | relevance + diversity selection |
| NDCG | graded ranking metric |
| RAG | retrieve, then generate |
| grounding | tying output to verifiable sources |
| hallucination | unsupported generated content |
| prompt injection | untrusted text hijacking an LLM's instructions |
| mock | fake dependency for tests |
| fixture | fixed test data |
| container | running instance of an image |
| volume | persistent storage for a container |
| env var | configuration passed outside the code |
| CORS | browser cross-origin policy |
| JWT | signed identity token |
| TLS | encryption in transit |
| rate limiting | request throttling |
| scale-to-zero | service sleeps when idle (Neon/Render free) |
| OpenAI-compatible | same JSON API shape as OpenAI |
| p95 latency | 95% of requests are at least this fast |
