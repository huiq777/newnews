# Database Schema

> **Note:** This document reflects the schema as of 2026-03-22 and is current. Verify against deployed Supabase DB if in doubt — migrations may have been applied after this was last updated.

## Overview

The schema is organized into two layers:

- **Ingestion layer** (`sources`, `raw_ingestion`) — managed exclusively by Cloudflare Workers. Never written to by the frontend client.
- **Product layer** (`daily_news`) — read by the frontend, written by Cloudflare Workers and Supabase Edge Functions via the service role.

All tables have Row Level Security enabled. Client access is granted only where explicitly needed.

---

## Table Descriptions

### `sources`
Registry of content feeds. Adding a new feed means inserting a row here — no pipeline changes required. The `is_active` flag lets you pause a feed without deleting its history. The `source_type` column distinguishes RSS, WeChat, X API, and GitHub-hosted feeds. The `metadata` JSONB column stores feed-specific data (e.g. `bio_map` for `github_feed` sources).

### `raw_ingestion`
The ingestion queue. Cloudflare Workers write raw article content here and track processing state. Acts as a buffer between fetching and summarization — the two operations are decoupled intentionally (see [architecture.md](architecture.md)). The `status` column is a state machine: `pending → processing → done` or `pending → processing → error`. `retry_count` tracks failed attempts; after 3 failures the row is permanently set to `error` and excluded from future runs. The `metadata` JSONB column stores source-specific per-row data (e.g. `{likes, retweets}` for builder tweets written by `ingest-builders`).

### `daily_news`
The clean, production-ready article store. Contains AI-generated bilingual summaries, pre-generated questions, scraped full article content, and Cohere vector embeddings. This is what the frontend reads and what the RAG chatbot searches. Linked back to `raw_ingestion` via `raw_ingestion_id` for audit traceability. The `engagement` JSONB column stores platform engagement data: `{likes, retweets}` for tweets (propagated from `raw_ingestion.metadata`), or `{hn_score, hn_comments}` for RSS articles enriched via the HN Algolia API.

---

## Migration SQL

Run this in the Supabase SQL editor to initialize the database from scratch.

```sql
-- ============================================================
-- EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================================
-- INGESTION LAYER
-- ============================================================

CREATE TABLE sources (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    rss_url     TEXT        UNIQUE NOT NULL,
    is_active   BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_type TEXT        NOT NULL DEFAULT 'rss',   -- 'rss' | 'wechat' | 'x_api' | 'github_feed' | 'podcast'
    metadata    JSONB                                  -- {bio_map: {handle: "role"}} for github_feed; NULL for others
);

CREATE TABLE raw_ingestion (
    id           UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id    UUID              NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url          TEXT              UNIQUE NOT NULL,
    raw_content  TEXT,
    fetched_at   TIMESTAMPTZ       NOT NULL DEFAULT now(),
    status       TEXT              NOT NULL DEFAULT 'pending',  -- pending | processing | done | error
    retry_count  INTEGER           NOT NULL DEFAULT 0,
    last_error   TEXT,
    processed_at TIMESTAMPTZ,
    metadata     JSONB                              -- {likes, retweets} for github_feed tweets; NULL for RSS/WeChat
);


-- ============================================================
-- PRODUCT LAYER
-- ============================================================

CREATE TABLE daily_news (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id        UUID        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    raw_ingestion_id UUID        NOT NULL REFERENCES raw_ingestion(id) ON DELETE RESTRICT,
    url              TEXT        UNIQUE NOT NULL,
    title            TEXT,                              -- primary language fallback
    summary          TEXT,                              -- primary language fallback
    title_en         TEXT,                              -- English title (Groq-generated)
    summary_en       TEXT,                              -- English 3-bullet summary
    title_zh         TEXT,                              -- Chinese title (Groq-generated)
    summary_zh       TEXT,                              -- Chinese 3-bullet summary
    article_content  TEXT,                              -- scraped full text; NULL for WeChat/tweets (bridge/raw handles)
    questions        JSONB,                             -- {en: string[], zh: string[]} — nullable if generation failed
    published_at     TIMESTAMPTZ,
    embedding        vector(1024),                      -- Cohere embed-english-v3.0; HNSW cosine index
    engagement       JSONB,                             -- {likes, retweets} for tweets | {hn_score, hn_comments} for RSS | NULL for WeChat
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- INDEXES
-- ============================================================

-- Partial index: process-queue polls this constantly to find pending work
CREATE INDEX idx_raw_ingestion_pending
    ON raw_ingestion (status)
    WHERE status = 'pending';

-- Partial index: embed-batch polls for un-embedded articles
CREATE INDEX idx_daily_news_no_embedding
    ON daily_news (id)
    WHERE embedding IS NULL;

-- HNSW vector index for similarity search — built incrementally, no cold-start issue
-- Uses cosine distance to match how Cohere embeddings are compared at query time
CREATE INDEX idx_daily_news_embedding
    ON daily_news
    USING hnsw (embedding vector_cosine_ops);


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- raw_ingestion: locked entirely from client access
-- The service role (used by Cloudflare Workers) bypasses RLS automatically
ALTER TABLE raw_ingestion ENABLE ROW LEVEL SECURITY;
-- No policies defined = no client can SELECT, INSERT, UPDATE, or DELETE

-- sources: clients may read the feed list (used by frontend for source labels), but cannot modify
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_sources"
    ON sources FOR SELECT
    USING (true);

-- daily_news: all users (including anonymous) may read articles
ALTER TABLE daily_news ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_daily_news"
    ON daily_news FOR SELECT
    USING (true);


-- ============================================================
-- match_articles RPC (used by answer-question for RAG)
-- ============================================================

CREATE OR REPLACE FUNCTION match_articles(
  query_embedding vector(1024),
  match_count     int DEFAULT 5
)
RETURNS TABLE (id UUID, title TEXT, summary TEXT, score FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT id, title, summary,
         1 - (embedding <=> query_embedding) AS score
  FROM daily_news
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding   -- raw <=> required for HNSW index
  LIMIT match_count;
$$;
```

---

## Key Design Decisions

**Why `raw_ingestion_id` and not `url` as the FK on `daily_news`?**
Foreign keys should reference primary keys. A FK on `raw_ingestion.url` (a business field) would prevent correcting or cleaning up raw ingestion records without cascading deletes into the clean `daily_news` table. Using the UUID primary key keeps the coupling structural, not semantic.

**Why `ON DELETE RESTRICT` on `raw_ingestion_id`?**
A processed article in `daily_news` should never silently disappear because its source queue row was deleted. RESTRICT forces you to explicitly handle this case rather than accidentally losing production data.

**Why HNSW over IVFFlat?**
IVFFlat requires training on an existing dataset to compute centroids — it performs poorly on a cold-start database. HNSW builds its index incrementally with each insert and delivers strong query performance from row one.

**Why `source_type` TEXT not ENUM?**
New source types (e.g. `github_feed`) can be added without a migration. Each worker filters by its own type string; no central type registry needed.

**Why `metadata JSONB` on `sources`?**
Source-specific data (e.g. `bio_map` for follow-builders) doesn't belong in a fixed column. JSONB lets each source type store what it needs without schema changes. Always validate presence before accessing: `sources.metadata?.bio_map`.

**Why `article_content` is NULL for tweets and WeChat?**
Tweets (280 chars) and WeChat articles (bot-blocked scraping) use `raw_content` from `raw_ingestion` directly as Groq input. Scraping is not attempted. `article_content` is only populated when a real article URL is successfully scraped.

**Why `questions` is nullable?**
Question generation is all-or-nothing — if either the EN or ZH Groq call fails (e.g. 429 rate limit), the whole field is null. Articles without questions simply don't show the pill UI. Use the ↻ refresh button next day after rate limits reset.

**Why `metadata JSONB` on `raw_ingestion`?**
Per-row ingestion data (e.g. tweet engagement from feed-x.json) varies by source type. A JSONB column avoids source-specific fixed columns on a shared queue table. `process-queue` reads `raw_ingestion.metadata` to propagate engagement data into `daily_news.engagement` without a second API call.

**Why `engagement JSONB` on `daily_news` instead of separate columns?**
Tweet engagement (`likes`, `retweets`) and HN engagement (`hn_score`, `hn_comments`) are structurally different shapes. A single JSONB column handles both without schema changes when new source types are added. Always check shape before accessing: `engagement?.likes` vs `engagement?.hn_score`.
