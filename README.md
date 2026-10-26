# Social Opinion Search

A natural-language **social-opinion retrieval and ranking engine**. The hard problem it addresses is not a polished directory or fluent LLM prose — it is retrieving the right handful of opinions from a large corpus *before* anything is sent to an LLM, then summarising them cautiously with citations.

> Example: *"I'm visiting Mumbai with my sister. Find a hotel area suitable for returning late at night; consider lighting, isolation and transport."*
> Useful evidence may say "the road is brightly lit and taxis line up outside" or "nobody around after 1 am" without ever using the word *safety*. The system retrieves positive, negative and contradictory reports and answers with cited, caveated evidence. Reviews never prove an area is objectively safe.

**The bundled data is synthetic** (108 illustrative opinions, 21 users) and labelled as such everywhere. The product has **real accounts** (email + password, server-side sessions) and can import **public datasets you download yourself** under their licences — none is bundled. See [Limitations](docs/LIMITATIONS.md) and [Verification status](#verification-status) before drawing conclusions.

## Why this is query-conditioned retrieval, not (only) collaborative filtering
Collaborative filtering predicts *taste similarity* from user–item interactions; it cannot tell which opinion answers "is it dark and empty after midnight?". This project ranks by **what an opinion says relative to the question** (full-text search, real embeddings, aspect coverage, context), keeps **social context** (authorship, relationship, authorization) as a separate, gated, evaluable signal, and keeps **web evidence** as a separate channel. No collaborative-filtering method is implemented or claimed. Details: [ARCHITECTURE](docs/ARCHITECTURE.md), [DECISIONS](docs/DECISIONS.md).

## What is implemented

* Fastify API · PostgreSQL 16 + Prisma 7 · pgvector · Zod validation · Vitest (179 tests)
* Three distinct retrieval modes: **lexical** (PostgreSQL FTS), **semantic** (pgvector cosine over stored embeddings), **hybrid** (union by id + reranker). Without an embedding provider, semantic/hybrid return `503 SEMANTIC_RETRIEVAL_UNAVAILABLE`; an explicit `allowFallback=true` returns a clearly labelled lexical result.
* Query understanding: validated structured intent (entity/location, aspects, hard constraints, soft preferences, temporal, evidence characteristics, ambiguities) from a deterministic parser, optionally LLM-assisted with schema validation and grounding against the query text. Unverifiable "must" constraints are disclosed, never silently applied.
* Inspectable ranking: lexical, semantic, aspect coverage, context, specificity/firsthand, provenance, freshness, redundancy, polarity (as an evidence characteristic). Relevance-first and social-aware ranking. Duplicate collapsing, MMR diversity and conflict balancing. [RANKING](docs/RANKING.md)
* Evidence-linked neighborhood summaries for hotel-area, cafe and restaurant queries: aggregate positive, negative, mixed and neutral aspect signals over the selected opinions, with evidence IDs and explicit caveats (not an objective place-quality or safety ranking).
* Explicit social graph (accepted / pending / blocked), configurable inner circle, authorization enforced in SQL **and** re-checked in code before ranking, logging, and LLM prompts.
* Three evidence channels (inner circle · wider social/public · web/AI) with disclosed fallback; grounded answers with validated citations and a deterministic fallback; honest *insufficient evidence* responses.
* Destination suggestions fall back to a separate, web-labelled list when a destination query has no relevant inner-circle evidence. The LLM may only recommend names found in cited web results; source links/snippets are displayed separately from social opinions, and unsupported suggestions are omitted.
* Offline benchmark: 33 queries, 387 graded judgments, P@5 / NDCG@5 / recall / aspect coverage / constraint satisfaction / latency / leaks / abstention, ablations, dev/test tuning protocol, bootstrap CIs. [EVALUATION](docs/EVALUATION.md)
* **Real authentication** ([docs/AUTH.md](docs/AUTH.md)): scrypt-hashed passwords, opaque server-side sessions (only a SHA-256 stored), HttpOnly SameSite cookie for browsers / Bearer tokens for API clients, rate limiting + lockout, CSRF origin check, strict CSP, change password, sign out everywhere, delete account.
* **A social graph users manage themselves**: find people, send/accept/decline/remove requests, set type and closeness (this *is* how the inner circle is formed), block; post opinions with a visibility level.
* **Public-dataset import with licence governance** ([docs/DATASETS.md](docs/DATASETS.md)): adapters for TripAdvisor-"Dyadic" restaurant reviews (CC BY-NC) and Inside Airbnb (private-use only), a generic CSV mapper, PII masking, pseudonymous authors, dedupe, provenance table, and a policy that hides non-displayable sources in production. **Verified on format fixtures only — no real file could be downloaded in the build environment.**
* Browser UI: sign-in/registration, search with a per-corpus filter and source/licence badges on every result, **My circle**, **My opinions**, **Data sources**, **Evaluation**, **Account**.

## Quick start

Prerequisites: Node.js ≥ 20.11 (built and tested on 22), npm, and either Docker **or** a local PostgreSQL 16 with the `pgvector` extension.

**macOS / Linux**
```bash
cp .env.example .env
docker compose up -d                 # PostgreSQL 16 + pgvector, creates social_opinion and social_opinion_test
npm install
npm run db:generate                  # Prisma client
npm run db:migrate                   # prisma migrate deploy
npm run db:seed                      # synthetic demo corpus + benchmark
npm run dev                          # http://127.0.0.1:3000
```

**Windows PowerShell**
```powershell
Copy-Item .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```
Open http://127.0.0.1:3000 and sign in. `npm run db:seed` prints the password for the three local demo accounts (`riya@gmail.com`, `aman@gmail.com`, `zoya@gmail.com`; these are login IDs, not verified email inboxes) — or set `DEMO_PASSWORD` in `.env` first — or simply **create your own account**. Lexical mode, tests and evaluation work with no API keys.

> If `npm run db:migrate` cannot download Prisma's schema-engine binary (restricted network), use the verified fallback instead (**not both** on the same database): `npm run db:migrate:sql`.
> If your Docker volume pre-dates this repo, create the test database once: `docker compose exec db psql -U sos -d postgres -c "CREATE DATABASE social_opinion_test"` and `docker compose exec db psql -U sos -d social_opinion_test -c "CREATE EXTENSION vector"`.

### Enable real semantic retrieval (no API key): GloVe static embeddings
```bash
npm run embeddings:glove             # downloads GloVe (public GitHub release), converts to data/models/*.bin (~41 MB)
# set in .env:  EMBEDDING_PROVIDER=local-glove
npm run embeddings:index             # embeds every opinion, stores vectors in pgvector
npm run dev
```
PowerShell one-off variables: `$env:EMBEDDING_PROVIDER="local-glove"; npm run eval`.
These are real learned embeddings but **static and non-contextual** (averaged word vectors) — weaker than modern sentence encoders. Re-run `npm run embeddings:index` after `npm run db:seed` (seeding truncates embeddings).

## npm scripts (identical to `package.json`)

| script | purpose |
|---|---|
| `npm run dev` | API + UI with auto-reload (`tsx watch src/server.ts`) |
| `npm run build` / `npm start` | compile to `dist/` / run `node dist/src/server.js` |
| `npm run typecheck` | `tsc --noEmit` (no ESLint is configured) |
| `npm test` | all Vitest tests (unit + integration; needs `TEST_DATABASE_URL`) |
| `npm run test:unit` | tests that need no database |
| `npm run db:generate` | `prisma generate` |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:migrate:sql` | fallback migration runner (plain `pg`) |
| `npm run db:seed` | reset + load synthetic corpus, aspects, benchmark queries/judgments |
| `npm run db:reset` | drop `public` schema and re-apply migrations (dev only) |
| `npm run embeddings:glove` | download/convert GloVe vectors |
| `npm run embeddings:index` | embed opinions with the configured provider |
| `npm run eval` | run the benchmark → `reports/latest.{json,md}` (+ DB row for the API/UI) |
| `npm run tune` | dev-selected / test-reported tuning experiments |
| `npm run user:admin -- <create\|set-password\|disable\|enable\|list> [email]` | operator tool (password via `USER_PASSWORD` env); the account-recovery path |
| `npm run dataset:list` | known public sources, their terms and import status |
| `npm run dataset:import -- --dataset <id> --file … --accept-license <ID>` | import a dataset you downloaded (see docs/DATASETS.md) |
| `npm run dataset:remove -- --dataset <id>` | delete an imported source and its pseudonymous authors |
| `npm run dataset:download -- --url … --out …` | optional helper: https download with size cap, prints SHA-256 |
| `npm run dataset:verify` | health report + spot-check queries for imported data |

`npm test` **drops the public schema of `TEST_DATABASE_URL`** (default `…/social_opinion_test`); it refuses to run if that name lacks "test" or equals `DATABASE_URL`. If PostgreSQL is unreachable, integration tests are skipped with a loud warning.

## Configuration (`.env.example`)

| variable | meaning |
|---|---|
| `DATABASE_URL`, `TEST_DATABASE_URL` | PostgreSQL connections |
| `INNER_CIRCLE_TYPES`, `INNER_CIRCLE_MIN_CLOSENESS` | inner circle = ACCEPTED + type ∈ list + closeness ≥ min (default FRIEND,FAMILY / 4) |
| `EMBEDDING_PROVIDER` | `none` (default) · `local-glove` · `openai` (any OpenAI-compatible `/embeddings`; `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`, `EMBEDDING_DIMENSIONS`) · `test-hash` (tests only; blocked in production) |
| `LLM_PROVIDER` | `none` · `anthropic` · `openai` (+ `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`); OpenAI-compatible endpoints such as Groq are supported. Groq GPT-OSS uses strict JSON Schema output plus local validation; used for validated intent parsing (`LLM_QUERY_UNDERSTANDING`) and grounded answers |
| `WEB_SEARCH_PROVIDER` | `none` · `brave` · `tavily` (+ `WEB_SEARCH_API_KEY`); results are a separate channel. Destination suggestions add visitor-review terms to the search and are only shown in a distinct web-sourced section when no relevant inner-circle evidence was selected |
| `ENABLE_DEV_ENDPOINTS` | enables `POST /api/v1/evaluation/run` (ignored when `NODE_ENV=production`) |
| `AUTH_SESSION_TTL_HOURS`, `AUTH_ALLOW_REGISTRATION`, `AUTH_SCRYPT_LOG2N`, `AUTH_COOKIE_SECURE`, `TRUST_PROXY`, `PUBLIC_ORIGIN` | session lifetime, open/closed registration, password-hash cost, cookie `Secure` mode (auto in production), proxy trust, canonical origin for the CSRF check |
| `RATE_LIMIT_ENABLED`, `RATE_LIMIT_SEARCH_PER_MIN`, `RATE_LIMIT_WRITE_PER_MIN` | in-memory per-process limits (login/registration limits are fixed) |
| `SEED_DEMO_LOGINS`, `DEMO_PASSWORD` | `db:seed` creates sign-in accounts for the 3 synthetic demo users; **set `SEED_DEMO_LOGINS=false` for public deployments** |
| `DATASET_ALLOW_RESTRICTED` | show `publicDisplayAllowed=false` data sources to users (default: allowed in development, **hidden in production**) |
| `REFERENCE_DATE` | pin "now" for reproducible freshness |

Misconfiguration (e.g. `EMBEDDING_PROVIDER=openai` without a key) stops startup with an explicit message — providers never switch silently. Secrets live only in `.env` (git-ignored).

## API

Authentication: sign in at `POST /api/v1/auth/login` (browser: HttpOnly cookie; API clients: `"mode":"token"` returns a Bearer token). Everything except `/health`, `/api/v1/auth/config|register|login`, and `/api/v1/data-sources` needs a session. Full reference: [docs/AUTH.md](docs/AUTH.md).

| endpoint | notes |
|---|---|
| `GET /health` | DB, pgvector, embedding/LLM/web status |
| `POST /api/v1/auth/register` · `login` · `logout` · `logout-all` | accounts and sessions; `GET /auth/me`, `GET /auth/config` |
| `POST /api/v1/auth/password` · `DELETE /api/v1/auth/account` | change password (revokes other sessions) · delete account and all its data |
| `POST /api/v1/search` | body: `query` (3–500), `mode` (`lexical`/`semantic`/`hybrid`), `ranking` (`relevance_first`/`social_aware`), `limit` (1–10, default 6), `generateAnswer`, `includeWeb`, `allowFallback`, `candidatePool`, `filters` (`city`,`category`,`since`,`firsthandOnly`,`sourceTypes`,`channels`,`dataSources`). 16 KB body limit; 60 searches/min per user. Returns intent, applied filters, provider status, candidates with component scores, selected evidence + reasons + `dataSource` provenance, suppressed duplicates, aspect balance, channel status, adequacy, answer + citations, latency, warnings. |
| `GET /api/v1/opinions` | authorized opinions only; `city`, `category`, `source`, `limit` (≤50), keyset `cursor` |
| `POST /api/v1/opinions` · `GET /api/v1/opinions/mine` · `DELETE /api/v1/opinions/:id` | post (visibility, firsthand, optional rating), list yours (incl. private), delete yours |
| `GET /api/v1/users/search?q=` | people with accounts, by name (≥3 letters) |
| `GET/POST /api/v1/relationships`, `POST …/:id/accept`, `POST …/:id/decline`, `PATCH`/`DELETE …/:id` | manage your graph; responses say whether each tie is currently **inner circle** |
| `POST /api/v1/blocks`, `DELETE /api/v1/blocks/:userId` | block / unblock |
| `GET /api/v1/me/access` | ids of your connections and inner circle |
| `GET /api/v1/data-sources` | provenance, licence, attribution, counts and displayability of every corpus |
| `GET /api/v1/search-runs/:id` | owner only (404 otherwise); ids and scores, never opinion text |
| `GET /api/v1/evaluation/summary` | latest stored evaluation (signed-in users; metrics + per-query ids) |
| `POST /api/v1/evaluation/run` | **development only** (404 unless `ENABLE_DEV_ENDPOINTS` and not production) |

Errors are structured: `{"error": {"code", "message", "details?"}}` with 400 / 401 / 403 / 404 / 409 / 413 / 429 (+`Retry-After`) / 503 / 500.

```bash
# sign in as an API client and search (Bearer token mode)
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"riya@gmail.com","password":"<your DEMO_PASSWORD>","mode":"token"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["token"])')
curl -s -X POST http://127.0.0.1:3000/api/v1/search -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"query":"I am visiting Mumbai with my sister. Find a hotel area suitable for returning late at night; consider lighting, isolation and transport.","mode":"hybrid"}'
```

## UI
Signed out: sign-in / create account (demo accounts listed in development). Signed in, six tabs:
* **Search** — question, mode, ranking, limit, **corpus checkboxes** ("Search in"), and the full pipeline inspector: parsed intent, provider/fallback status, channel counts, answer and citations, selected evidence with *why selected*, component bars, source/licence chips ("non-commercial licence", "SYNTHETIC") and an attribution line, aspect balance (conflicts), suppressed duplicates, the top-40 candidate table.
* **My circle** — the inner-circle rule in plain words; find people; accept/decline requests; edit each connection's type and closeness (an *inner circle* chip appears when the rule is met); remove, block, cancel, unblock.
* **My opinions** — post an opinion (visibility: connections / inner circle / everyone / only me), see detected aspects and semantic-index status, delete yours.
* **Data sources** — provenance, licence, attribution, geography, date range, commercial-use and display flags, limitations and counts for every corpus.
* **Evaluation** — the stored benchmark (synthetic corpus only).
* **Account** — change password, sign out everywhere, delete account.
Opinion text is inserted with `textContent` only; there are no inline scripts/styles (strict CSP).

## Evaluation results (measured; read the caveats in [EVALUATION](docs/EVALUATION.md))

33 queries / 387 judgments / 108 synthetic opinions, GloVe-100 SIF embeddings:

| mode | P@5 | NDCG@5 | aspect coverage | median retrieval ms |
|---|---|---|---|---|
| lexical | 0.723 | 0.749 | 0.883 | 3.6 |
| semantic | 0.716 | 0.726 | 0.856 | 3.9 |
| **hybrid (relevance-first)** | **0.819** | **0.861** | 0.967 | 5.6 |
| hybrid (social-aware) | 0.800 | 0.842 | 0.967 | 5.4 |

Hybrid − lexical ΔNDCG@5 = +0.112 (95% bootstrap CI +0.031…+0.208); social-aware vs relevance-first −0.020 (CI −0.058…+0.017, i.e. no measurable difference in *content* relevance). **Unauthorized leaks: 0** in 594 sweep searches. Known failures cluster around negated/polarised *query* intent (see EVALUATION §3). These are benchmark results on author-written synthetic data, not real-world accuracy.

## Privacy and authorization
* Visibility levels: `PUBLIC`, `CONNECTIONS` (accepted), `INNER_CIRCLE` (configured), `PRIVATE`. Pending and blocked relationships grant nothing; blocked users' public opinions are hidden too. Own opinions are not returned as social evidence.
* Identity comes from a verified session ([docs/AUTH.md](docs/AUTH.md)); the visibility rules below are enforced in the SQL of every retrieval query, re-asserted in code, and again before logs/LLM prompts (prompts exclude author identities). Data sources flagged `publicDisplayAllowed=false` are hidden by the same predicate in production.
* Tests cover pending vs accepted, unrelated and blocked users, private opinions, search-run logs, debug/summary endpoints, LLM prompt contents, and SQL≡TypeScript equivalence for all 21 users × 108 opinions. Mutation checks (deliberately weakening the predicate) make these tests fail.

## Provider details
* **LLM** (`anthropic` Messages API or OpenAI-compatible chat): intent parsing is Zod-validated and *grounded* (a city, time window or firsthand claim must appear in the query, otherwise it is dropped with a warning; unknown aspects become soft preferences). Answers receive only selected authorized evidence; any citation outside it discards the answer in favour of the deterministic summary. Provider errors/timeouts (`PROVIDER_TIMEOUT_MS`) degrade with a disclosed warning.
* **Web search** (Brave): returned verbatim as a separate channel (`W1…`), never mixed into social ranking, never fabricated.
* **Embeddings**: model key (e.g. `glove-wiki-gigaword-100@sif-v1`) is stored with every vector; queries are embedded with the same provider and compared only to vectors of the same key.

## Data: synthetic corpus, user posts, and public datasets
* `data/seed/` (users, relationships, places, opinions) and `data/eval/` (queries, judgments, aspect labels) are fully synthetic; every row is flagged `is_synthetic` with data source `synthetic-seed-v1`. The benchmark is pinned to this corpus.
* Users' own posts have source `user-generated` and are never part of the benchmark.
* **Public datasets are not bundled.** You download them from their official sites, accept their terms, and import with `npm run dataset:import` (details, licences, what was and was not verified: [docs/DATASETS.md](docs/DATASETS.md)). Supported: TripAdvisor "Dyadic Context" restaurant reviews (CC BY-NC 4.0 — non-commercial), Inside Airbnb (private analysis only; "do not republish"), and a generic mapper for any CSV you may use. Reviewer identities are pseudonymised, emails/links/phone-like numbers are masked, and each source's licence, attribution, geography, date range and limitations are stored and shown in the UI.
* **Honest status:** the importer is verified on fixtures that imitate the documented layouts. No real dataset file could be downloaded in the build environment, so the first real import is yours; `npm run dataset:verify` checks it.

## Verification status

| step | status in the build environment |
|---|---|
| `npm ci`, `npm run typecheck`, `npm run build`, `npm start` (compiled) | ✅ run from a clean copy |
| PostgreSQL 16 + pgvector 0.6.0, `db:migrate:sql`, `db:seed`, FTS and vector queries | ✅ (local apt install, not Docker) |
| `npm run db:generate` | ✅ — but only with a placeholder `PRISMA_SCHEMA_ENGINE_BINARY` because `binaries.prisma.sh` was unreachable; on a normal network no workaround is needed |
| `npm run db:migrate` (`prisma migrate deploy`) | ⚠️ **not run** (schema-engine binary unavailable). The SQL it would apply is the one verified through `db:migrate:sql` |
| `docker compose up` / `docker build` | ⚠️ **not run** (no Docker in the sandbox); the compose file, init SQL and `Dockerfile` are untested. The Dockerfile's stages (install → generate → build → prune → run in production mode) were simulated by hand and worked |
| `npm test` | ✅ 179 tests pass (14 files, unit + integration; real PostgreSQL) |
| Authentication (scrypt, sessions, cookies, CSRF, lockout, cascade delete), social graph, posting | ✅ unit + integration tests; **not** tested behind a real HTTPS proxy; no email verification / password reset by email / MFA |
| Dataset importer (CSV quoting, PII masking, pseudonyms, idempotency, governance, benchmark isolation) | ✅ on **synthetic fixtures that imitate** the TripAdvisor-Dyadic and Inside Airbnb layouts; ❌ **never run on a real dataset file** (unreachable from the sandbox) |
| `npm run embeddings:glove`, `embeddings:index`, `eval`, `tune` with real GloVe vectors | ✅ |
| Server + UI | ✅ health/search/error paths via HTTP; the UI was driven in headless Chromium end to end (sign-in, wrong password, registration with weak password, search with corpus filter, friend request → accept → inner-circle visibility → closeness change → visibility lost, posting, password change, account deletion) with **no CSP violations** |
| OpenAI-compatible embeddings, Anthropic/OpenAI LLM, Brave web search | ⚠️ implemented and tested against **mock HTTP servers only**; never called live |
| Windows PowerShell commands | ⚠️ not run on Windows (the scripts contain no shell-specific syntax) |

## Project tree
```
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── data/
│   ├── datasets/
│   │   ├── probe-queries.json
│   │   └── raw/
│   ├── eval/
│   │   ├── aspect_labels.json
│   │   ├── judgments.json
│   │   └── queries.json
│   ├── models/
│   └── seed/
│       ├── opinions.json
│       ├── places.json
│       ├── relationships.json
│       └── users.json
├── docker/
│   └── initdb/
│       └── 01-init.sql
├── docker-compose.yml
├── docs/
│   ├── ARCHITECTURE.md
│   ├── AUTH.md
│   ├── DATASETS.md
│   ├── DECISIONS.md
│   ├── DEPLOYMENT.md
│   ├── EVALUATION.md
│   ├── INTERVIEW_QA.md
│   ├── LIMITATIONS.md
│   ├── PROJECT_DEEP_DIVE.md
│   ├── RANKING.md
│   └── results/
│       ├── bootstrap.json
│       ├── latest-summary.json
│       ├── latest.md
│       └── tune.md
├── package-lock.json
├── package.json
├── prisma/
│   ├── migrations/
│   │   ├── 20261020000000_init/
│   │   │   └── migration.sql
│   │   ├── 20261022000000_auth_and_datasets/
│   │   │   └── migration.sql
│   │   └── migration_lock.toml
│   ├── schema.prisma
│   └── seed.ts
├── prisma.config.ts
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── reports/
├── scripts/
│   ├── _args.ts
│   ├── apply-migrations.ts
│   ├── dataset-download.ts
│   ├── dataset-import.ts
│   ├── dataset-verify.ts
│   ├── fetch-glove.ts
│   ├── index-embeddings.ts
│   ├── reset-db.ts
│   ├── run-eval.ts
│   ├── tune.ts
│   └── user-admin.ts
├── src/
│   ├── app.ts
│   ├── config/
│   │   └── env.ts
│   ├── context.ts
│   ├── db/
│   │   ├── client.ts
│   │   ├── embeddings-store.ts
│   │   └── seed.ts
│   ├── modules/
│   │   ├── answer/
│   │   │   └── answer.ts
│   │   ├── auth/
│   │   │   ├── cookies.ts
│   │   │   ├── password.ts
│   │   │   ├── rate-limit.ts
│   │   │   ├── service.ts
│   │   │   └── sessions.ts
│   │   ├── datasets/
│   │   │   ├── adapters.ts
│   │   │   ├── clean.ts
│   │   │   ├── importer.ts
│   │   │   └── registry.ts
│   │   ├── embeddings/
│   │   │   ├── glove.ts
│   │   │   ├── indexer.ts
│   │   │   ├── openai.ts
│   │   │   ├── provider.ts
│   │   │   └── test-hash.ts
│   │   ├── evaluation/
│   │   │   ├── data.ts
│   │   │   ├── metrics.ts
│   │   │   ├── report.ts
│   │   │   └── runner.ts
│   │   ├── llm/
│   │   │   └── provider.ts
│   │   ├── query-understanding/
│   │   │   ├── aspects.ts
│   │   │   ├── intent.ts
│   │   │   └── parser.ts
│   │   ├── ranking/
│   │   │   ├── config.ts
│   │   │   ├── rank.ts
│   │   │   ├── select.ts
│   │   │   └── types.ts
│   │   ├── retrieval/
│   │   │   ├── repository.ts
│   │   │   ├── retrieve.ts
│   │   │   └── types.ts
│   │   ├── search/
│   │   │   └── search-service.ts
│   │   ├── social-access/
│   │   │   └── access.ts
│   │   └── web-search/
│   │       └── provider.ts
│   ├── routes/
│   │   ├── account.ts
│   │   ├── auth.ts
│   │   ├── index.ts
│   │   ├── security.ts
│   │   └── social.ts
│   ├── server.ts
│   └── shared/
│       ├── errors.ts
│       └── text.ts
├── tests/
│   ├── fixtures/
│   │   ├── README.md
│   │   ├── airbnb-listings.csv
│   │   ├── airbnb-reviews.csv
│   │   └── dyadic-sample.csv
│   ├── global-setup.ts
│   ├── helpers.ts
│   ├── integration/
│   │   ├── api-data.test.ts
│   │   ├── auth.test.ts
│   │   ├── datasets.test.ts
│   │   ├── privacy.test.ts
│   │   ├── search.test.ts
│   │   └── social.test.ts
│   └── unit/
│       ├── access.test.ts
│       ├── answer-metrics.test.ts
│       ├── auth.test.ts
│       ├── datasets-clean.test.ts
│       ├── intent.test.ts
│       ├── providers.test.ts
│       ├── ranking.test.ts
│       └── text-aspects.test.ts
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

## More documentation
[docs/PROJECT_DEEP_DIVE.md](docs/PROJECT_DEEP_DIVE.md) (everything: every file, key code, data provenance, inner circle, diagrams) · [docs/INTERVIEW_QA.md](docs/INTERVIEW_QA.md) (cross-questions + tech-stack basics) · [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (Neon + Render + Groq + Cloudflare, step by step) · [docs/AUTH.md](docs/AUTH.md) · [docs/DATASETS.md](docs/DATASETS.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/RANKING.md](docs/RANKING.md) · [docs/EVALUATION.md](docs/EVALUATION.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/LIMITATIONS.md](docs/LIMITATIONS.md)
