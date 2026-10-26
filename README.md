# Social Opinion Search

A natural-language **social-opinion retrieval and ranking engine**. The hard problem it addresses is not a polished directory or fluent LLM prose — it is retrieving the right handful of opinions from a large corpus *before* anything is sent to an LLM, then summarising them cautiously with citations.

> Example: *"I'm visiting Mumbai with my sister. Find a hotel area suitable for returning late at night; consider lighting, isolation and transport."*
> Useful evidence may say "the road is brightly lit and taxis line up outside" or "nobody around after 1 am" without ever using the word *safety*. The system retrieves positive, negative and contradictory reports and answers with cited, caveated evidence. Reviews never prove an area is objectively safe.



## What is implemented

* Fastify API · PostgreSQL 16 + Prisma 7 · pgvector · Zod validation · Vitest (179 tests)
* Three distinct retrieval modes: **lexical** (PostgreSQL FTS), **semantic** (pgvector cosine over stored embeddings), **hybrid** (union by id + reranker). Without an embedding provider, semantic/hybrid return `503 SEMANTIC_RETRIEVAL_UNAVAILABLE`; an explicit `allowFallback=true` returns a clearly labelled lexical result.
* Query understanding: validated structured intent (entity/location, aspects, hard constraints, soft preferences, temporal, evidence characteristics, ambiguities) from a deterministic parser, optionally LLM-assisted with schema validation and grounding against the query text. Unverifiable "must" constraints are disclosed, never silently applied.
* Inspectable ranking: lexical, semantic, aspect coverage, context, specificity/firsthand, provenance, freshness, redundancy, polarity (as an evidence characteristic). Relevance-first and social-aware ranking. Duplicate collapsing, MMR diversity and conflict balancing. [RANKING](docs/RANKING.md)
* Evidence-linked neighborhood summaries for hotel-area, cafe and restaurant queries: aggregate positive, negative, mixed and neutral aspect signals over the selected opinions, with evidence IDs and explicit caveats (not an objective place-quality or safety ranking).
* Explicit social graph (accepted / pending / blocked), configurable inner circle, authorization enforced in SQL **and** re-checked in code before ranking, logging, and LLM prompts.
* Three evidence channels (inner circle · wider social/public · web/AI) with disclosed fallback; grounded answers with validated citations and a deterministic fallback; honest *insufficient evidence* responses.
* Destination suggestions fall back to a separate, web-labelled list when a destination query has no relevant inner-circle evidence. The LLM may only recommend names found in cited web results; source links/snippets are displayed separately from social opinions, and unsupported suggestions are omitted.
* Offline benchmark: 33 queries, 387 graded judgments, P@5 / NDCG@5 / recall / aspect coverage / constraint satisfaction / latency / leaks / abstention, ablations, dev/test tuning protocol, bootstrap CIs.
* **Real authentication** : scrypt-hashed passwords, opaque server-side sessions (only a SHA-256 stored), HttpOnly SameSite cookie for browsers / Bearer tokens for API clients, rate limiting + lockout, CSRF origin check, strict CSP, change password, sign out everywhere, delete account.
* **A social graph users manage themselves**: find people, send/accept/decline/remove requests, set type and closeness (this *is* how the inner circle is formed), block; post opinions with a visibility level.
* **Public-dataset import with licence governance** : adapters for TripAdvisor-"Dyadic" restaurant reviews (CC BY-NC) and Inside Airbnb (private-use only), a generic CSV mapper, PII masking, pseudonymous authors, dedupe, provenance table, and a policy that hides non-displayable sources in production. **Verified on format fixtures only — no real file could be downloaded in the build environment.**
* Browser UI: sign-in/registration, search with a per-corpus filter and source/licence badges on every result, **My circle**, **My opinions**, **Evaluation**, **Account**.

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

## UI
Signed out: sign-in / create account (demo accounts listed in development). Signed in, six tabs:
* **Search** — question, mode, ranking, limit, **corpus checkboxes** ("Search in"), and the full pipeline inspector: parsed intent, provider/fallback status, channel counts, answer and citations, selected evidence with *why selected*, component bars, source/licence chips ("non-commercial licence", "SYNTHETIC") and an attribution line, aspect balance (conflicts), suppressed duplicates, the top-40 candidate table.
* **My circle** — the inner-circle rule in plain words; find people; accept/decline requests; edit each connection's type and closeness (an *inner circle* chip appears when the rule is met); remove, block, cancel, unblock.
* **My opinions** — post an opinion (visibility: connections / inner circle / everyone / only me), see detected aspects and semantic-index status, delete yours.
* **Evaluation** — the stored benchmark (synthetic corpus only).
* **Account** — change password, sign out everywhere, delete account.
Opinion text is inserted with `textContent` only; there are no inline scripts/styles (strict CSP).

## Evaluation results (measured)

33 queries / 387 judgments / 108 synthetic opinions, GloVe-100 SIF embeddings:

| mode | P@5 | NDCG@5 | aspect coverage | median retrieval ms |
|---|---|---|---|---|
| lexical | 0.723 | 0.749 | 0.883 | 3.6 |
| semantic | 0.716 | 0.726 | 0.856 | 3.9 |
| **hybrid (relevance-first)** | **0.819** | **0.861** | 0.967 | 5.6 |
| hybrid (social-aware) | 0.800 | 0.842 | 0.967 | 5.4 |

Hybrid − lexical ΔNDCG@5 = +0.112 (95% bootstrap CI +0.031…+0.208); social-aware vs relevance-first −0.020 (CI −0.058…+0.017, i.e. no measurable difference in *content* relevance). **Unauthorized leaks: 0** in 594 sweep searches. Known failures cluster around negated/polarised *query* intent. These are benchmark results on author-written synthetic data, not real-world accuracy.


## Data: synthetic corpus, user posts, and public datasets
* `data/seed/` (users, relationships, places, opinions) and `data/eval/` (queries, judgments, aspect labels) are fully synthetic; every row is flagged `is_synthetic` with data source `synthetic-seed-v1`. The benchmark is pinned to this corpus.
* Users' own posts have source `user-generated` and are never part of the benchmark.
* **Public datasets are not bundled.** You download them from their official sites, accept their terms, and import with `npm run dataset:import` (details, licences, what was and was not verified: [docs/DATASETS.md](docs/DATASETS.md)). Supported: TripAdvisor "Dyadic Context" restaurant reviews (CC BY-NC 4.0 — non-commercial), Inside Airbnb (private analysis only; "do not republish"), and a generic mapper for any CSV you may use. Reviewer identities are pseudonymised, emails/links/phone-like numbers are masked, and each source's licence, attribution, geography, date range and limitations are stored and shown in the UI.
* **Honest status:** the importer is verified on fixtures that imitate the documented layouts. No real dataset file could be downloaded in the build environment, so the first real import is yours; `npm run dataset:verify` checks it.

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
