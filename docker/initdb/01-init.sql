-- Runs once on first container start. Creates the extension and a separate test database.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE social_opinion_test;
\connect social_opinion_test
CREATE EXTENSION IF NOT EXISTS vector;
