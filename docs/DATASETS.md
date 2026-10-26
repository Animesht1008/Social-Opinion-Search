# Public datasets: what is supported, what was verified, how to import

> **Read this first.** No third-party dataset is bundled with this project, and — importantly — **no real dataset file could be
> downloaded or tested in the authoring environment** (it could only reach GitHub, PyPI, npm and a few package hosts; Zenodo,
> Inside Airbnb, Kaggle, UCI and Hugging Face were all unreachable). The import subsystem is therefore verified against
> **synthetic fixtures that imitate the documented file layouts** (`tests/fixtures/`), not against the real files. The first
> real import happens on your machine, and `npm run dataset:verify` exists to let you check it quickly.

## 1. Why this is built as an importer rather than a bundled dataset
* A *social-opinion* corpus that is also **location-aware** and **legally redistributable** is rare. The realistic candidates all carry restrictions:

| candidate | what the terms say (as read while building this) | consequence |
|---|---|---|
| **TripAdvisor Dataset for Dyadic Context Analysis** (Zenodo 6583422) | Creative Commons **CC BY-NC 4.0**: attribution required, **non-commercial only** | importable and displayable for non-commercial use, with attribution; flagged `commercialUseAllowed=false` |
| **Inside Airbnb** (insideairbnb.com) | The data-policies page asks users to attribute and cite, not to scrape the site, and **not to republish the data**; licence wording has differed between snapshots (older CC0, newer CC BY 4.0) | importable **for private analysis only**; flagged `publicDisplayAllowed=false` and hidden from other users in production by default; we never redistribute it |
| Yelp Open Dataset | academic/non-commercial terms, no redistribution | not supported |
| Kaggle/third-party scrapes of Booking.com, TripAdvisor, Google | scraped from restricted sources | deliberately **not** supported |
| Other TripAdvisor research dumps on Zenodo | mixed licences / pickled pandas files | not supported (a Python converter would be needed) |

* Shipping any of these inside the zip would require redistribution rights this project does not have. So the data stays at its
  official source and **you** download it, accept its terms (`--accept-license`), and import it.

## 2. What was verified, what was not

| claim | status |
|---|---|
| TripAdvisor Dyadic dataset is on Zenodo record 6583422, CC BY-NC 4.0, restaurant reviews, one CSV per city, English | read from the record description/search snippets; **not re-verified against the files** |
| Exact column names of its CSV files | **unknown to me.** The adapter looks for aliases (`review_full`, `review_text`, `text`…; `date`; `city`; `rating_review`; `title_review`; `restaurant_name`) case-insensitively and **fails with the list of detected headers** if it cannot find a column. Override with `--map text=<column>,date=<column>,city=<column>`. |
| Inside Airbnb `reviews.csv` columns (`listing_id,id,date,reviewer_id,reviewer_name,comments`) and `listings.csv` (`id`, `neighbourhood_cleansed`) | well-known public layout; adapter verified on a fixture of that layout |
| The importer logic (CSV quoting, cleaning, language filter, dedupe, pseudonymisation, idempotency, restricted-source hiding, benchmark isolation) | ✅ 12 integration tests + 11 unit tests on fixtures |
| Quality of retrieval on real reviews | ❌ **not measured**: there are no relevance judgments for imported data, so no accuracy metric is reported. `dataset:verify` prints probe-query results for you to read. |

## 3. Commands

```bash
npm run dataset:list                                   # known sources, their terms, and import status
npm run dataset:download -- --url https://… --out data/datasets/raw/file.csv   # optional helper (https only, size cap, prints SHA-256)

# TripAdvisor dyadic (you download the per-city CSV files from the Zenodo record yourself)
npm run dataset:import -- --dataset tripadvisor-dyadic-2022 \
    --file data/datasets/raw/<city-file>.csv [--file …] \
    --accept-license CC-BY-NC-4.0 --limit 5000 --embed

# Inside Airbnb (private analysis only)
npm run dataset:import -- --dataset inside-airbnb \
    --file data/datasets/raw/reviews.csv --listings data/datasets/raw/listings.csv \
    --city "Lisbon" --accept-license INSIDE-AIRBNB-POLICY --sample 0.2 --embed

# Any other CSV you are licensed to use
npm run dataset:import -- --dataset generic --meta my-source.json --file data.csv \
    --map text=Review,date=Date,city=City,category=const:restaurant --accept-license <licenseId in your meta file>

npm run dataset:verify [-- --dataset <id>]             # health report + spot-check queries
npm run dataset:remove -- --dataset <id>               # delete a source and its pseudonymous authors
```
Flags: `--limit N` (stop after N kept rows) · `--sample 0.1` (deterministic per-record sampling) · `--only-cities "London,Delhi"` · `--dry-run` (read and filter, write nothing) · `--append` (keep earlier rows; default replaces the source) · `--embed` (embed after import with the configured provider; otherwise run `npm run embeddings:index`).
A `meta` file for `generic` must contain: `id`, `shortCode`, `name`, `url`, `license`, `licenseId`, `attribution`, `commercialUseAllowed`, `publicDisplayAllowed`, `limitations` (validated by Zod).

## 4. What the importer does to every row (`src/modules/datasets/`)
1. **Stream** the CSV (RFC 4180: quoted fields, embedded newlines/quotes, BOM) — large files are never loaded whole.
2. **Pre-flight**: validate the first row's headers *before* anything destructive. A wrong file or wrong `--map` leaves earlier data untouched (tested; this was a real bug found by the tests).
3. **Map** to the project's fields (adapter): text, date, city (canonicalised: `New_Delhi`→`Delhi`), neighbourhood, category, rating (1–5 from 1–5 / 10–50 / 0–10 scales), reviewer key.
4. **Clean**: strip HTML tags/entities, collapse whitespace, remove control characters. **Mask** emails, URLs, phone-like numbers (≥ 9 digits) and `@handles`.
5. **Filter**: 30–2500 characters; English-looking (ASCII ratio + English function-word share — a heuristic, not a language-ID model); drop automated postings; unparseable dates; unknown listings.
6. **Deduplicate** by normalised text within the source (`duplicate_text`) and by id.
7. **Pseudonymise authors**: `pub_<code>_<12 hex>` = HMAC-SHA256 of the reviewer key with a **random key generated per import run and discarded** → irreversible and unlinkable across imports. Datasets with no reviewer id give every review its own pseudonym. **Reviewer names are never read.**
8. **Store** in batches: opinion (`sourceType=PUBLIC_REVIEW`, `visibility=PUBLIC`, `firsthand` per the source's assumption, `externalId`, a provenance note that states the licence and the cleaning applied), derived aspects (`lexicon-v1`), and update the `data_sources` row (counts, date range, cities, import time).

## 5. Provenance and governance in the product
Every opinion has a **data source** (`data_sources` table) holding: name, URL, licence + link, attribution, geography, date range, `isSynthetic`, `commercialUseAllowed`, `publicDisplayAllowed`, adapter, limitations, row count.
* `GET /api/v1/data-sources` and the **Data sources** tab show all of it.
* Each evidence item in a search response carries `dataSource { id, name, license, url, attribution, commercialUseAllowed, isSynthetic }`; the UI shows a "non-commercial licence" chip and an attribution line.
* **`publicDisplayAllowed=false` sources are hidden** from search, `/opinions`, evidence and answers when the deployment policy forbids it: automatically in `NODE_ENV=production`, overridable with `DATASET_ALLOW_RESTRICTED=true` (only if you hold the rights). The rule is enforced in the same SQL predicate as visibility and is tested against the pure TypeScript predicate and the independent evaluation oracle.
* Search can be restricted to chosen corpora (`filters.dataSources`, UI checkboxes).
* **Benchmark isolation:** the evaluation runs on the synthetic corpus only (`filters.dataSources=["synthetic-seed-v1"]`), because imported data has no judgments and would otherwise be counted as "irrelevant". A test proves the benchmark numbers are unchanged with imported data present; I also re-ran the full evaluation with fixtures imported and all metrics were identical.

## 6. Known limitations of imported data
* **Names in free text are not detected** (only emails, links, phone-like numbers, handles are masked). Airbnb reviews, for instance, often contain the host's first name. Do not claim these rows are fully anonymised.
* `firsthand = true` is an assumption (these platforms only allow reviews after a visit/stay); it is configurable per source (`assumeFirsthand`).
* TripAdvisor restaurant reviews fit our *aspects* (hygiene, vegetarian, price, service, noise) but not the headline "late-night safety of hotel areas" scenario; Airbnb reviews do, but are short, mostly positive and partly multilingual.
* Language detection is a heuristic; some English text is dropped and some non-English text may pass.
* The aspect lexicon recognises ~20 concepts; review text is far more varied than the synthetic corpus, so expect lower aspect coverage and noisier polarity than reported for the benchmark.
* GloVe averaging is a weak encoder for noisy real text; a contextual embedding model is recommended before judging retrieval quality on real data.
* Cities in imported data and in the synthetic corpus overlap only by name (e.g. "Delhi"); mixing corpora in one search is allowed but they have different writing styles.

## 7. Suggested first run on your machine
1. Download one per-city CSV from the Zenodo record (check its licence on that page), save under `data/datasets/raw/`.
2. `npm run dataset:import -- --dataset tripadvisor-dyadic-2022 --file … --accept-license CC-BY-NC-4.0 --limit 2000 --dry-run` — if it reports missing columns, add `--map` entries from the printed header list.
3. Run it without `--dry-run`, then `npm run embeddings:index` (or add `--embed`).
4. `npm run dataset:verify -- --dataset tripadvisor-dyadic-2022` — check: PII-pattern hits = 0, aspect coverage, embedding coverage, and read the probe results.
5. In the UI: **Data sources** tab (provenance), then **Search** with only that corpus ticked.
