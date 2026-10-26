# Deployment guide (from zero)

This guide takes you from "I have the zip" to "my app is running on a public URL", using **free-tier** services:

| piece | service | why |
|---|---|---|
| database (Postgres + pgvector) | **Neon** | free tier, supports `pgvector`, scale-to-zero, built-in connection pooler |
| app hosting | **Render** (Docker web service) | deploys straight from a Dockerfile; free tier exists |
| LLM (intent parsing + answers) | **Groq** | OpenAI-compatible API, free tier, very fast |
| embeddings | **Cloudflare Workers AI** | OpenAI-compatible `/embeddings` endpoint, free daily allowance |

> **Updated:** the app now has **real authentication** (see `docs/AUTH.md`) and a licence-aware dataset importer (`docs/DATASETS.md`). The old "replace the demo header" requirement is gone; §6 lists what you still must configure.
>
> **Honesty box.** I (the author of this code) could not run Docker, Neon, Render, Groq or Cloudflare from my build environment. What *was* verified: the production build, `npm prune --omit=dev`, starting the compiled server with `NODE_ENV=production`, and the dev endpoint being disabled in production. The provider integrations are covered by tests against *mock* servers only. Free-tier limits and model names change often — **always check the provider's current dashboard/docs**. Treat every step below as "very likely correct, not yet proven in your account" and use the smoke tests (§5) to prove each piece before moving on.

---

## 0. Decide what "deploy" means for you

| goal | what to do |
|---|---|
| Show it to an interviewer / reviewer on your laptop | Skip this guide. Follow the README "Quick start". |
| A public demo URL with synthetic data | Follow this guide (Option A). |
| Your own server / VPS | Follow §10 (Option B: Docker Compose). |
| Real users and real data | Do **everything** in §6 ("Required code changes") first — the demo authentication is not safe for real data. |

---

## 1. Create the accounts (all free)

1. **GitHub** — https://github.com (stores your code so Render can read it). *(Alternative without GitHub: push the Docker image to Docker Hub; see §8.4.)*
2. **Neon** — https://neon.tech
3. **Cloudflare** — https://dash.cloudflare.com (for Workers AI)
4. **Groq** — https://console.groq.com
5. **Render** — https://render.com (sign in with GitHub for the simplest flow)

Keep a text file (never commit it) where you paste the secrets you will create below.

---

## 2. Prepare the code on your computer

1. Install **Node.js 22 LTS** from https://nodejs.org (the installer adds `node` and `npm`). Check: open a terminal and run `node -v` (expect v22.x or ≥ v20.11).
2. Install **Git** from https://git-scm.com.
3. Unzip `social-opinion-search.zip`, open a terminal **inside** the unzipped folder (Windows: right-click the folder → "Open in Terminal"; macOS: right-click → "New Terminal at Folder").
4. Run:
   ```bash
   npm install
   npm run db:generate
   ```
   `db:generate` creates the Prisma client in `src/generated/` (git-ignored — Docker regenerates it).
5. Check everything compiles: `npm run typecheck` (no output = good).

---

## 3. Create the database on Neon

1. Neon → **New project**. Choose the region closest to your users (and, later, close to your Render region — same continent is enough).
2. After creation, open **Connect** (or "Connection details"). You will see connection strings. You need **two**:
   * **Direct** connection (host name does *not* contain `-pooler`) → use for migrations, seeding and embedding indexing from your laptop.
   * **Pooled** connection (host contains `-pooler`) → use for the running app (many short connections).
   Both end with `?sslmode=require` — keep that (Neon requires TLS).
3. Open Neon's **SQL Editor** and run: `CREATE EXTENSION IF NOT EXISTS vector;` (our migration also does this; running it once manually avoids permission surprises).
4. Create the schema from your laptop. In the project folder copy the env template and edit it:
   ```bash
   cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
   ```
   Open `.env` and set `DATABASE_URL=<your DIRECT Neon string>`.
5. Apply the migration — use **one** of these, never both on the same database:
   ```bash
   npm run db:migrate        # standard: prisma migrate deploy (needs to download Prisma's engine binary)
   # or, if that cannot download the binary on your network:
   npm run db:migrate:sql    # verified fallback runner
   ```
6. Load the synthetic demo data: `SEED_DEMO_LOGINS=false npm run db:seed` (prints counts: 21 users, 108 opinions…). With `SEED_DEMO_LOGINS=false` no sign-in accounts are created; people register through the UI (or you create them with `npm run user:admin`). Migration 2 (accounts, sessions, data sources) is applied by the same `db:migrate` / `db:migrate:sql` command.

---

## 4. Get your provider keys

### 4.1 Groq (LLM)
1. Groq console → **API Keys** → create a key → save as `GROQ_KEY`.
2. Pick a model id from https://console.groq.com/docs/models. Choose a normal **instruct/chat** model that supports JSON mode (as of my knowledge, names like `llama-3.3-70b-versatile` or the smaller `llama-3.1-8b-instant` existed — **verify**; avoid pure "reasoning" models for the JSON parser).
3. In `.env`:
   ```
   LLM_PROVIDER=openai
   LLM_BASE_URL=https://api.groq.com/openai/v1
   LLM_API_KEY=<GROQ_KEY>
   LLM_MODEL=<the model id you chose>
   LLM_QUERY_UNDERSTANDING=false     # start with false: halves LLM calls and keeps you inside free-tier rate limits
   ```
   (`LLM_PROVIDER=openai` just means "OpenAI-compatible protocol"; Groq speaks it.)

### 4.2 Cloudflare Workers AI (embeddings)
1. Cloudflare dashboard → note your **Account ID** (right sidebar of the account home).
2. **My Profile → API Tokens → Create Token** → use the "Workers AI" template (or custom: permission *Account → Workers AI → Read/Edit*) → copy the token.
3. In `.env`:
   ```
   EMBEDDING_PROVIDER=openai
   EMBEDDING_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
   EMBEDDING_API_KEY=<CLOUDFLARE_API_TOKEN>
   EMBEDDING_MODEL=@cf/baai/bge-base-en-v1.5
   ```
   `bge-base-en-v1.5` produces 768-dimensional vectors; our schema accepts any dimension (see DECISIONS D-04). Other Workers AI embedding models exist (e.g. `bge-large-en-v1.5`, 1024-d); verify current names in Cloudflare's model catalogue.

---

## 5. Smoke-test each provider BEFORE running the app

Replace the capitalised placeholders. **Groq:**
```bash
curl -s https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<MODEL>","messages":[{"role":"user","content":"Reply with the JSON {\"ok\":true}"}],"response_format":{"type":"json_object"},"max_tokens":50}'
```
Expect a JSON response whose `choices[0].message.content` contains `{"ok":true}`.

**Cloudflare embeddings:**
```bash
curl -s https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/embeddings \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"@cf/baai/bge-base-en-v1.5","input":["well lit road at night"]}'
```
Expect `data[0].embedding` to be an array of 768 numbers **and** `data[0].index` to be present (our provider requires `data[].index`; if Cloudflare's response differs, see Troubleshooting).

(Windows PowerShell users: either use `curl.exe` instead of `curl`, or use `Invoke-RestMethod`.)

---

## 6. Required and recommended code/config changes for production

### 6.1 Required for any public URL
| # | change | why / how |
|---|---|---|
| 1 | `NODE_ENV=production` | disables dev endpoints (`/api/v1/evaluation/run` returns 404) and blocks the test-only embedding provider |
| 2 | `HOST=0.0.0.0` | inside a container the default `127.0.0.1` is unreachable from outside (the Dockerfile already sets it) |
| 3 | `PORT` | Render injects `PORT`; the app reads it (Dockerfile default 3000) |
| 4 | Use the **pooled** Neon string as the app's `DATABASE_URL` | avoids exhausting Postgres connections |
| 5 | Secrets only in the host's environment settings | never in git (`.env` is git-ignored) |
| 6 | Re-tune the semantic threshold for the new embedding model | see §7 — the default `0.5` was tuned for GloVe, **not** for bge |

### 6.2 Authentication and data settings (done in code; you must set them correctly)
| # | setting | why |
|---|---|---|
| 7 | `TRUST_PROXY=true` | Render/Fly/Caddy terminate TLS and forward requests; without it every user shares the proxy's IP in rate limits and `X-Forwarded-Host` is ignored |
| 8 | Leave `AUTH_COOKIE_SECURE` empty (auto = true in production) | the session cookie becomes `__Host-sos_session; Secure; HttpOnly; SameSite=Lax`, which needs HTTPS (Render provides it). To test the production image over plain `http://localhost`, set `AUTH_COOKIE_SECURE=false` temporarily |
| 9 | **`SEED_DEMO_LOGINS=false`** when you run `npm run db:seed` against the production DB | otherwise three synthetic demo accounts with a known password exist on your public site |
| 10 | Decide `AUTH_ALLOW_REGISTRATION` | `true` = anyone can create an account (there is **no email verification**); `false` = invite-only: create users with `USER_PASSWORD='…' npm run user:admin -- create someone@example.com "Name"` |
| 11 | Keep `DATASET_ALLOW_RESTRICTED` empty | in production, data sources flagged `publicDisplayAllowed=false` (e.g. Inside Airbnb) stay hidden. Set `true` only if you hold the right to show them |
| 12 | Non-commercial datasets (e.g. TripAdvisor Dyadic, CC BY-NC) | allowed only for non-commercial use with attribution; do not import them into a commercial deployment |
| 13 | Rate limiting is **per instance** (in memory) | run a single instance, or add an edge/shared limiter before scaling out |
| 14 | `PUBLIC_ORIGIN` (optional) | set to `https://your-app.example.com` if the CSRF origin check ever blocks legitimate calls behind an unusual proxy |
| 15 | Password recovery | no email is sent. Operator path: `USER_PASSWORD='new' npm run user:admin -- set-password user@example.com` against the production DB |
| 16 | Treat stored query text as personal data | `search_runs` keeps each user's query text; define retention |

### 6.3 Still not done (be honest with users)
Email verification, password reset by email, MFA, a shared (Redis) rate limiter, moderation of user posts, and an audit log. The demo `x-user-id` header and `/api/v1/users` directory no longer exist.

### 6.4 Scale-related (later)
* Add an ANN index for pgvector (HNSW expression index per model) — see LIMITATIONS.
* The local GloVe provider is **not** suitable for small free hosts (the model file is 41 MB, excluded from the Docker image on purpose); use Cloudflare/other API embeddings in the cloud.

---

## 6b. Optional: import a public dataset (do this locally, then point at Neon)
Follow `docs/DATASETS.md`: download the file yourself from its official site, check its licence, then (with `DATABASE_URL` set to the Neon **direct** URL) run `npm run dataset:import -- --dataset <id> --file … --accept-license <ID> --limit 5000`. Run `npm run embeddings:index` afterwards (Section 7) so the new rows are searchable semantically. **Respect each source's terms** — non-commercial data does not belong on a commercial deployment, and "do not republish" data must stay hidden (the production default).

## 7. Create the embeddings and re-tune (do this once, locally)

1. With `.env` pointing at Neon (direct URL) and the Cloudflare settings above:
   ```bash
   npm run embeddings:index
   ```
   Expected: `Indexed 108 new, 0 failed. Now 108/108 opinions have openai-compat:@cf/baai/bge-base-en-v1.5 vectors.`
   Vectors are stored under that model key. Changing model later = run this command again (old vectors stay, unused).
2. Run the evaluation with the *new* embeddings: `npm run eval`. Compare with `docs/results/latest.md` (the GloVe numbers).
3. Re-tune the thresholds: `npm run tune`. Look at "Experiment 1/2": pick the smallest `semanticMin` for which the *dev* expected-empty query abstains without false abstentions. Edit `semanticMin` in `src/modules/ranking/config.ts` (field `relevanceGate`). BGE cosine values are usually higher/lower than GloVe's — do not assume 0.5 is right.
4. Re-run `npm run eval` and keep the new `reports/latest.md` numbers — **update the results table in README/EVALUATION.md with your measured values**; the committed numbers describe GloVe.

---

## 8. Deploy the app on Render

### 8.1 Push the code to GitHub
```bash
git init
git add .
git commit -m "Social Opinion Search"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
(Check `git status` shows no `.env` — it must be ignored. If you ever commit a secret, rotate it immediately.)

### 8.2 Create the web service
1. Render dashboard → **New → Web Service** → connect your GitHub repo.
2. **Runtime/Language: Docker** (Render finds the `Dockerfile` at the repo root).
3. Instance type: Free (or a paid one for always-on).
4. **Health Check Path:** `/health`.
5. **Environment variables** (Add each; *never* commit them):
   ```
   NODE_ENV=production
   DATABASE_URL=<Neon POOLED string, ending ?sslmode=require>
   EMBEDDING_PROVIDER=openai
   EMBEDDING_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
   EMBEDDING_API_KEY=<Cloudflare token>
   EMBEDDING_MODEL=@cf/baai/bge-base-en-v1.5
   LLM_PROVIDER=openai
   LLM_BASE_URL=https://api.groq.com/openai/v1
   LLM_API_KEY=<Groq key>
   LLM_MODEL=<Groq model id>
   LLM_QUERY_UNDERSTANDING=false
   ENABLE_DEV_ENDPOINTS=false
   TRUST_PROXY=true
   AUTH_ALLOW_REGISTRATION=true     # or false for invite-only
   REFERENCE_DATE=            # leave empty in production = real clock
   ```
   (`HOST` and `PORT` are set by the Dockerfile/Render.) You do **not** need `TEST_DATABASE_URL`.
6. **Create Web Service.** Render builds the image (several minutes the first time), then starts it.

### 8.3 Verify
```bash
curl https://<your-service>.onrender.com/health
```
Expect `"status":"ok"`, `"pgvector":true`, and `providers.embedding.semanticAvailable: true`. Then open the URL in a browser and run the default query. The free instance sleeps after inactivity and takes a while to wake (first request slow) — that is the free-tier trade-off.

### 8.4 Alternative: without GitHub (Docker Hub image)
Needs Docker installed locally: `docker build -t <dockerhub-user>/sos:1 .` → `docker login` → `docker push <dockerhub-user>/sos:1` → on Render choose **New → Web Service → Existing image** and enter the image path; set the same environment variables.

---

## 9. Updating later
* **Code change:** push to `main`; Render rebuilds automatically.
* **Schema change:** create a new migration folder under `prisma/migrations/<timestamp>_name/migration.sql` (or use `npx prisma migrate dev` locally against a dev DB), then run `npm run db:migrate` against the Neon **direct** URL *before* deploying code that needs it.
* **New/changed opinions:** run `npm run embeddings:index` for the new rows (it only embeds rows missing a vector for the configured model).
* **Changing embedding model:** set the new env vars, run `npm run embeddings:index`, re-run `npm run tune`, update `semanticMin`, redeploy.
* **Rotate secrets:** change them in Groq/Cloudflare/Neon, then update Render environment variables.

---

## 10. Option B — your own server (VPS) with Docker Compose (untested sketch)

Use any Linux VPS with Docker installed. Create `docker-compose.prod.yml` next to the Dockerfile:

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: sos
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: social_opinion
    volumes: [pgdata:/var/lib/postgresql/data]
  app:
    build: .
    restart: unless-stopped
    depends_on: [db]
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://sos:${POSTGRES_PASSWORD}@db:5432/social_opinion
      EMBEDDING_PROVIDER: openai
      EMBEDDING_BASE_URL: ${EMBEDDING_BASE_URL}
      EMBEDDING_API_KEY: ${EMBEDDING_API_KEY}
      EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5"
      LLM_PROVIDER: openai
      LLM_BASE_URL: https://api.groq.com/openai/v1
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_MODEL: ${LLM_MODEL}
    ports: ["127.0.0.1:3000:3000"]
  caddy:                      # automatic HTTPS
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddydata:/data"]
volumes: { pgdata: {}, caddydata: {} }
```
`Caddyfile`: `your-domain.com { reverse_proxy app:3000 }`. Then `docker compose -f docker-compose.prod.yml up -d --build`, run migrations/seed/indexing once from your laptop (or `docker compose run` a Node image) pointing `DATABASE_URL` at the server's Postgres (temporarily publish its port to your IP only, or run the commands in a container on the same compose network).

---

## 11. Troubleshooting

| symptom | likely cause | fix |
|---|---|---|
| `Cannot reach the database or schema is missing` at startup | wrong `DATABASE_URL`, no `?sslmode=require`, or migrations not applied | check the string; run `npm run db:migrate` against the direct URL |
| `pgvector extension is not installed` warning | extension missing | run `CREATE EXTENSION vector;` in Neon's SQL editor |
| `EMBEDDING_PROVIDER=openai requires EMBEDDING_API_KEY` | missing env var | set it (startup deliberately fails instead of falling back silently) |
| `503 SEMANTIC_RETRIEVAL_UNAVAILABLE` | no vectors for the configured model | run `npm run embeddings:index` with the same embedding env vars |
| `unexpected response shape (data length mismatch)` or `empty embedding` from the embeddings provider | Cloudflare's response differs from OpenAI's shape | print the raw response with the curl in §5 and adapt `src/modules/embeddings/openai.ts` (it expects `data[].embedding` and `data[].index`) |
| Everything abstains / nothing is returned in semantic mode | `semanticMin` (0.5) too high for the new model | re-run `npm run tune`, lower it |
| Too many weak results returned | `semanticMin` too low | raise it, re-tune |
| `LLM answer generation failed (HTTP 429)` | Groq free-tier rate limit | warnings show it; retry later, set `LLM_QUERY_UNDERSTANDING=false`, or pick a smaller model |
| `LLM answer generation failed (HTTP 400)` | model doesn't support `response_format: json_object` or wrong model id | choose an instruct model; check the id |
| Render shows "Application failed to respond" | server bound to `127.0.0.1` | ensure `HOST=0.0.0.0` (Dockerfile sets it) |
| Build fails on `prisma generate` | blocked network for Prisma's engine download | allow `binaries.prisma.sh` during build |
| Sign-in works but the next request is 401 right away | `Secure` cookie over plain http, or a proxy stripping `Set-Cookie` | use HTTPS; for local http tests set `AUTH_COOKIE_SECURE=false` |
| `429 RATE_LIMITED` for everyone behind the proxy | `TRUST_PROXY` not set, so all users share one IP | set `TRUST_PROXY=true` |
| `403 CSRF_BLOCKED` on every write | `Origin` host differs from the `Host` the app sees | set `TRUST_PROXY=true` and/or `PUBLIC_ORIGIN=https://your-domain` |
| Imported dataset rows never appear | source is `publicDisplayAllowed=false` and the app runs in production | intended; see `docs/DATASETS.md` §5 |
| First request after idle is very slow | free instance (Render) and/or Neon compute waking up | expected on free tiers |
