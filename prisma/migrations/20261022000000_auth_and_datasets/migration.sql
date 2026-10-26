-- Migration 2: real authentication (accounts + sessions) and dataset provenance/governance.

-- ---------- accounts ----------
ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" IS NULL OR "email" = lower("email"));
ALTER TABLE "users" ADD CONSTRAINT "users_email_needs_password" CHECK (("email" IS NULL) = ("password_hash" IS NULL));
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- Server-side sessions: only the SHA-256 of the opaque token is stored, so a database leak does not yield usable tokens.
CREATE TABLE "sessions" (
  "token_hash" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "user_agent" TEXT,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- data sources (provenance + governance) ----------
CREATE TABLE "data_sources" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "url" TEXT,
  "license" TEXT NOT NULL,
  "license_url" TEXT,
  "attribution" TEXT,
  "geography" TEXT,
  "date_from" TIMESTAMP(3),
  "date_to" TIMESTAMP(3),
  "is_synthetic" BOOLEAN NOT NULL DEFAULT false,
  "commercial_use_allowed" BOOLEAN NOT NULL DEFAULT false,
  -- false => the text may be stored for private analysis but must not be shown to other users (e.g. "do not republish").
  "public_display_allowed" BOOLEAN NOT NULL DEFAULT false,
  "adapter" TEXT,
  "limitations" TEXT,
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "imported_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

INSERT INTO "data_sources" ("id","name","description","license","attribution","geography","is_synthetic","commercial_use_allowed","public_display_allowed","adapter","limitations") VALUES
 ('synthetic-seed-v1','Synthetic demo corpus','108 illustrative opinions written for this project (not real people, not real reviews).','Synthetic / project-authored','Written for the Social Opinion Search project','Mumbai, Bengaluru, Goa, Jaipur, Delhi (fictional content)',true,true,true,'seed','Authored by the project author; engineered edge cases; not representative of real review text.'),
 ('user-generated','Opinions written by registered users','Opinions posted through the application by its users.','Author retains rights; visibility chosen by the author','Posted by registered users','Wherever users write about',false,false,true,'api','User-submitted and unmoderated.');

ALTER TABLE "opinions" ADD COLUMN "external_id" TEXT;
ALTER TABLE "opinions" ADD CONSTRAINT "opinions_provenance_source_fkey" FOREIGN KEY ("provenance_source") REFERENCES "data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "opinions_provenance_source_idx" ON "opinions"("provenance_source");
-- Idempotent imports: one row per (dataset, original record id).
CREATE UNIQUE INDEX "opinions_source_external_key" ON "opinions"("provenance_source", "external_id") WHERE "external_id" IS NOT NULL;
