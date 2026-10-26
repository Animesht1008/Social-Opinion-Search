-- Social Opinion Search — initial schema.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "RelationshipType" AS ENUM ('FRIEND', 'FAMILY', 'COLLEAGUE', 'ACQUAINTANCE');
CREATE TYPE "RelationshipStatus" AS ENUM ('ACCEPTED', 'PENDING', 'BLOCKED');
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'CONNECTIONS', 'INNER_CIRCLE', 'PRIVATE');
CREATE TYPE "SourceType" AS ENUM ('SOCIAL_USER', 'PUBLIC_REVIEW');
CREATE TYPE "Polarity" AS ENUM ('POSITIVE', 'NEGATIVE', 'MIXED', 'NEUTRAL');
CREATE TYPE "RetrievalMode" AS ENUM ('LEXICAL', 'SEMANTIC', 'HYBRID');
CREATE TYPE "RankingMode" AS ENUM ('RELEVANCE_FIRST', 'SOCIAL_AWARE');

CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "is_synthetic" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "relationships" (
  "id" TEXT NOT NULL,
  "requester_id" TEXT NOT NULL,
  "addressee_id" TEXT NOT NULL,
  "type" "RelationshipType" NOT NULL,
  "status" "RelationshipStatus" NOT NULL,
  "closeness" INTEGER NOT NULL DEFAULT 3,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accepted_at" TIMESTAMP(3),
  CONSTRAINT "relationships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "relationships_closeness_range" CHECK ("closeness" BETWEEN 1 AND 5),
  CONSTRAINT "relationships_no_self" CHECK ("requester_id" <> "addressee_id")
);

CREATE TABLE "places" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "neighborhood" TEXT,
  "country" TEXT NOT NULL DEFAULT 'IN',
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "external_id" TEXT,
  "is_synthetic" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "opinions" (
  "id" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "place_id" TEXT,
  "text" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "neighborhood" TEXT,
  "category" TEXT NOT NULL,
  "written_at" TIMESTAMP(3) NOT NULL,
  "source_type" "SourceType" NOT NULL,
  "firsthand" BOOLEAN NOT NULL,
  "visibility" "Visibility" NOT NULL,
  "rating" INTEGER,
  "provenance_source" TEXT NOT NULL,
  "provenance_note" TEXT,
  "repost_of_id" TEXT,
  "is_synthetic" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
  CONSTRAINT "opinions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "opinions_rating_range" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
);

CREATE TABLE "opinion_aspects" (
  "opinion_id" TEXT NOT NULL,
  "aspect" TEXT NOT NULL,
  "polarity" "Polarity" NOT NULL,
  "matched_terms" TEXT[],
  "extractor" TEXT NOT NULL,
  CONSTRAINT "opinion_aspects_pkey" PRIMARY KEY ("opinion_id", "aspect", "extractor")
);

CREATE TABLE "opinion_embeddings" (
  "opinion_id" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "dim" INTEGER NOT NULL,
  "embedding" vector NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "opinion_embeddings_pkey" PRIMARY KEY ("opinion_id", "model"),
  CONSTRAINT "opinion_embeddings_dim_matches" CHECK (vector_dims("embedding") = "dim")
);

CREATE TABLE "search_runs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "intent" JSONB NOT NULL,
  "retrieval_mode" "RetrievalMode" NOT NULL,
  "ranking_mode" "RankingMode" NOT NULL,
  "effective_mode" TEXT NOT NULL,
  "candidates" JSONB NOT NULL,
  "selected_ids" JSONB NOT NULL,
  "provider_status" JSONB NOT NULL,
  "warnings" JSONB NOT NULL,
  "latency_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "search_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "eval_queries" (
  "id" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "requester_id" TEXT NOT NULL,
  "tags" TEXT[],
  "hard_constraints" JSONB NOT NULL,
  "expected_aspects" TEXT[],
  "expect_insufficient" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  CONSTRAINT "eval_queries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "eval_judgments" (
  "eval_query_id" TEXT NOT NULL,
  "opinion_id" TEXT NOT NULL,
  "grade" INTEGER NOT NULL,
  "aspects" TEXT[],
  "note" TEXT,
  CONSTRAINT "eval_judgments_pkey" PRIMARY KEY ("eval_query_id", "opinion_id"),
  CONSTRAINT "eval_judgments_grade_range" CHECK ("grade" BETWEEN 0 AND 3)
);

CREATE TABLE "evaluation_runs" (
  "id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "config" JSONB NOT NULL,
  "summary" JSONB NOT NULL,
  "per_query" JSONB NOT NULL,
  CONSTRAINT "evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "relationships_requester_id_addressee_id_key" ON "relationships"("requester_id", "addressee_id");
CREATE INDEX "relationships_addressee_id_status_idx" ON "relationships"("addressee_id", "status");
CREATE INDEX "relationships_requester_id_status_idx" ON "relationships"("requester_id", "status");
CREATE INDEX "places_city_type_idx" ON "places"("city", "type");
CREATE INDEX "opinions_city_category_idx" ON "opinions"("city", "category");
CREATE INDEX "opinions_author_id_visibility_idx" ON "opinions"("author_id", "visibility");
CREATE INDEX "opinions_written_at_idx" ON "opinions"("written_at");
CREATE INDEX "opinions_visibility_source_type_idx" ON "opinions"("visibility", "source_type");
CREATE INDEX "opinions_search_vector_gin" ON "opinions" USING GIN ("search_vector");
CREATE INDEX "opinion_aspects_aspect_idx" ON "opinion_aspects"("aspect");
CREATE INDEX "opinion_embeddings_model_idx" ON "opinion_embeddings"("model");
CREATE INDEX "search_runs_user_id_created_at_idx" ON "search_runs"("user_id", "created_at");

-- Foreign keys
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "opinions" ADD CONSTRAINT "opinions_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "opinions" ADD CONSTRAINT "opinions_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "opinions" ADD CONSTRAINT "opinions_repost_of_id_fkey" FOREIGN KEY ("repost_of_id") REFERENCES "opinions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "opinion_aspects" ADD CONSTRAINT "opinion_aspects_opinion_id_fkey" FOREIGN KEY ("opinion_id") REFERENCES "opinions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "opinion_embeddings" ADD CONSTRAINT "opinion_embeddings_opinion_id_fkey" FOREIGN KEY ("opinion_id") REFERENCES "opinions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_queries" ADD CONSTRAINT "eval_queries_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_judgments" ADD CONSTRAINT "eval_judgments_eval_query_id_fkey" FOREIGN KEY ("eval_query_id") REFERENCES "eval_queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_judgments" ADD CONSTRAINT "eval_judgments_opinion_id_fkey" FOREIGN KEY ("opinion_id") REFERENCES "opinions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
