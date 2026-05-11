# Database Schema

> **Note:** This document reflects the schema as of 2026-05-11. Verify against deployed Supabase DB if in doubt — migrations may have been applied after this was last updated.

## Overview

The schema is organized into four layers:

- **Ingestion layer** (`sources`, `raw_ingestion`) — managed exclusively by Cloudflare Workers. Never written to by the frontend client.
- **Product layer** (`daily_news`) — read by the frontend, written by Cloudflare Workers and Supabase Edge Functions via the service role.
- **Cache layer** (`trend_briefs`) — written by the `generate-trend-brief` Edge Function; read directly by the frontend via anon key. TTL-based invalidation.
- **Observability layer** (`pipeline_events`, `qa_logs`) — service-role only. `pipeline_events` traces every article through the pipeline; `qa_logs` traces every Q&A request.
- **Auth layer** (`beta_invites` + `is_beta_user()` helper) — service-role only. The `redeem-invite` Edge Function writes; the helper function is referenced indirectly from RLS policies of future user-scoped tables (e.g. `qa_logs`).
- **User feedback layer** (`trend_brief_feedback`) — per-user brief ratings.
- **Email layer** (`email_subscribers`, `email_digest_sent`) — digest opt-in and delivery accounting.

All tables have Row Level Security enabled. Client access is granted only where explicitly needed.

---

## Table Descriptions

### `sources`
Registry of content feeds. Adding a new feed means inserting a row here — no pipeline changes required. The `is_active` flag lets you pause a feed without deleting its history. The `source_type` column distinguishes RSS, WeChat, X API, and GitHub-hosted feeds. The `metadata` JSONB column stores feed-specific data (e.g. `bio_map` for `github_feed` sources).

### `raw_ingestion`
The ingestion queue. Cloudflare Workers write raw article content here and track processing state. Acts as a buffer between fetching and summarization — the two operations are decoupled intentionally (see [architecture.md](architecture.md)). The `status` column is a state machine: `pending → processing → done` or `pending → processing → error`. `retry_count` tracks failed attempts; after 3 failures the row is permanently set to `error` and excluded from future runs. The `metadata` JSONB column stores source-specific per-row data (e.g. `{likes, retweets}` for builder tweets written by `ingest-builders`).

### `daily_news`
The clean, production-ready article store. Contains AI-generated bilingual summaries, pre-generated questions, scraped full article content, and Cohere vector embeddings. This is what the frontend reads and what the RAG chatbot searches. Linked back to `raw_ingestion` via `raw_ingestion_id` for audit traceability. The `engagement` JSONB column stores platform engagement data: `{likes, retweets}` for tweets (propagated from `raw_ingestion.metadata`), or `{hn_score, hn_comments}` for RSS articles enriched via the HN Algolia API. The `metadata` JSONB column (added 2026-05-11) stores source-specific article-level data: for `aihot` rows it holds `{source, title_en, category, aihot_id}` where `source` is the original outlet name (e.g. "Hugging Face"); propagated by `process-queue` from `raw_ingestion.metadata` at insert time.

### `trend_briefs`
Cache table for cross-window trend synthesis. One row per `(anchor_date, step_days)` time window; covers ALL content categories in a single brief. The `generate-trend-brief` Edge Function writes here on successful completion; the frontend reads via anon key and renders the Trend Brief card only when the "All" tab is active. TTL is 6 hours — no automated invalidation beyond that; a Refresh button gives the user manual control. Feishu does NOT read from this table.

### `channel_invites`
Subscription manual routing table. Feishu, Slack, and other channel invite URLs rotate or expire; this table lets the operator update invite URLs without redeploying the frontend bundle. The frontend reads this table lazily when the Subscription Manual modal opens. A channel is hidden from the UI if its `invite_url` is null.
- `channel` (text PK, e.g. `feishu`, `wecom`)
- `language` (text, `'en' | 'zh'`)
- `display_label` (text, e.g. `#daily-brief`)
- `invite_url` (text, URL to join or QR image for WeCom)

### `pipeline_events`
Append-only observability log for the article processing pipeline. One row per pipeline step per article per run. `run_id` is stamped on `raw_ingestion` and `daily_news` rows at claim time, so a single filter on `run_id` reconstructs the full trace for any batch. No RLS policies — service-role only.

Steps: `claim` | `keyword_gate` | `llm` | `insert` | `embed` | `llm_category_mismatch`
Statuses: `ok` | `skip` | `error`

### `qa_logs`
Full Q&A trace per `answer-question` invocation. Written by `orchestrateAnswer()` on completion or abort. `request_id` UUID is generated at entry and appears in every structured log line for that request. User feedback (👍 = 1, 👎 = -1) is written back by the `AnswerFeedback` component.

Key columns: `request_id UUID`, `user_id`, `article_id`, `question`, `response_text`, `lang`, `deep_think`, `related_article_ids UUID[]`, `context_main_chars`, `total_tokens`, `ttft_ms`, `total_ms`, `aborted`, `feedback` (-1/0/1), `error_message`, `asked_at`.

### `trend_brief_feedback`
Per-user thumbs up/down on trend briefs. Keyed on `(user_id, anchor_date, step_days)` — the time window, not the specific brief row — so a user's vote persists even after a force-refresh generates a new `trend_briefs` row. The `TrendBriefFeedback` component upserts on vote, deletes on toggle-off. RLS: authenticated users read and write only their own rows.

Columns: `user_id` (uuid FK to auth.users, cascade delete), `anchor_date` (date), `step_days` (int), `feedback` (smallint, -1 or 1), `feedback_at` (timestamptz). PK: `(user_id, anchor_date, step_days)`.

### `email_subscribers`
Email digest opt-in list. Collected via the Email tab in the SubscriptionManualModal. `unsubscribed_at` null = active subscriber; set by the `unsubscribe-email` Edge Function when the user visits the unsubscribe link in their email. RLS: anon and authenticated may INSERT (subscribe); only service role can read the list.

Columns: `id` (uuid PK), `email` (text unique), `lang` ('en'|'zh'), `created_at`, `unsubscribed_at`.

### `email_digest_sent`
Per-subscriber per-day delivery accounting for the email channel, mirroring the `digest_sent` pattern. UNIQUE `(subscriber_id, anchor_date, step_days)` provides idempotent claiming. The `send-digest` worker inserts a row per subscriber before sending, then updates status to `sent` or `failed`.

Columns: `id` (uuid PK), `subscriber_id` (uuid FK to email_subscribers, cascade delete), `anchor_date` (date), `step_days` (int), `status` (pending|sent|failed|skipped_empty_brief), `last_error` (text), `created_at`, `updated_at`.

### `beta_invites`
Round 1 closed-beta invite-link redemption table. Operator mints rows via the Supabase SQL Editor and shares `https://<host>/?invite=<code>` over WeChat; the user's first click signs them in anonymously and the `redeem-invite` Edge Function ties the row to their `auth.uid()`.

Columns:
- `code` (text PK) — random URL-safe slug, admin-generated.
- `display_name` (text NOT NULL) — operator-attributed name (e.g. "Wang Lei", "Founder Park 朋友").
- `default_lang` (text NOT NULL, `'en' | 'zh'`) — preselects gate language.
- `email` (text NULL) — reserved for Round 2 magic-link flow; null in Round 1.
- `expires_at` (timestamptz NULL) — null = never expires.
- `used_at` (timestamptz NULL) — set on redemption.
- `user_id` (uuid FK to `auth.users`, `on delete set null`) — the redeeming user.
- `created_at` (timestamptz NOT NULL).

RLS is enabled with **no anon/authenticated policies** — only `redeem-invite` (running as service role) reads or writes. Direct PostgREST `select * from beta_invites` from any logged-in user returns zero rows. This is the access-control invariant: the table never leaks invite codes to client callers.

The companion helper function `public.is_beta_user()` (`security definer`) returns `true` iff the current `auth.uid()` owns a redeemed-and-non-expired row. Future user-scoped tables (e.g. `qa_logs`) use it for one-line RLS: `using (is_beta_user() and user_id = auth.uid())`.

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
    source_type TEXT        NOT NULL DEFAULT 'rss',   -- 'rss' | 'wechat' | 'x_api' | 'apify_tweet' | 'github_feed' | 'github_trending' | 'podcast' | 'reddit' | 'arxiv' | 'producthunt' | 'nowcoder' | 'aihot'
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
    metadata     JSONB,                             -- {likes, retweets} for github_feed tweets; NULL for RSS/WeChat
    published_at TIMESTAMPTZ                        -- article publish date extracted from HTML meta tags by process-queue; NULL for tweets/RSS without a date
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
    metadata         JSONB,                             -- {source, title_en, category, aihot_id} for aihot rows; NULL for others
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
-- match_articles RPC (used by answer-question for RAG AND generate-trend-brief for historical enrichment)
-- ============================================================

CREATE OR REPLACE FUNCTION match_articles(
  query_embedding vector(1024),
  match_count     int DEFAULT 5
)
RETURNS TABLE (id UUID, title TEXT, summary TEXT, published_at TIMESTAMPTZ, score FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT id, title, summary, published_at,
         1 - (embedding <=> query_embedding) AS score
  FROM daily_news
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding   -- raw <=> required for HNSW index
  LIMIT match_count;
$$;

-- NOTE: The RPC has no date filter — callers must filter post-query.
-- generate-trend-brief uses this to find historical context: it excludes results
-- whose published_at falls within the current window, then deduplicates across seeds.
-- Similarity threshold (0.82) is also applied post-query in the Edge Function.


-- ============================================================
-- claim_pending_batch RPC (used by process-queue Edge Function)
-- ============================================================

-- Atomic batch claim: atomically marks up to batch_size pending rows as 'processing'
-- and returns them. Uses three-tier priority ordering to surface today's content first.
-- SECURITY DEFINER + REVOKE FROM PUBLIC — callable only by service_role via PostgREST RPC.
CREATE OR REPLACE FUNCTION claim_pending_batch(batch_size int DEFAULT 5)
RETURNS SETOF raw_ingestion
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: service_role required';
  END IF;
  RETURN QUERY
  UPDATE raw_ingestion SET status = 'processing'
  WHERE id IN (
    SELECT id FROM raw_ingestion
    WHERE status = 'pending'
    ORDER BY
      -- Three-tier priority, all dates evaluated in Eastern Time.
      -- 'America/New_York' handles DST automatically (EST in winter, EDT in summer).
      --
      -- Tier 0: published_at = today → explicit today content, highest priority.
      -- Tier 1: published_at IS NULL AND fetched_at = today → fresh but undated
      --         (typical for tweets and RSS feeds without <pubDate>).
      -- Tier 2: everything else → backlog, processed FIFO.
      CASE
        WHEN published_at IS NOT NULL
             AND (published_at AT TIME ZONE 'America/New_York')::date
               = (now() AT TIME ZONE 'America/New_York')::date
        THEN 0
        WHEN published_at IS NULL
             AND (fetched_at AT TIME ZONE 'America/New_York')::date
               = (now() AT TIME ZONE 'America/New_York')::date
        THEN 1
        ELSE 2
      END ASC,
      -- FIFO within each tier
      fetched_at ASC
    LIMIT batch_size
  )
  -- CRITICAL MVCC guard: re-check status after acquiring the row lock.
  -- Two concurrent Edge Function invocations can read the same pending IDs.
  -- AND status='pending' forces Postgres to re-read live row state after locking —
  -- if Worker A already committed 'processing', Worker B returns 0 rows cleanly.
  -- Replaces FOR UPDATE SKIP LOCKED, which caused "Lock was stolen" errors via PostgREST.
  AND status = 'pending'
  RETURNING *;
END;
$$;
REVOKE EXECUTE ON FUNCTION claim_pending_batch(int) FROM PUBLIC;


-- ============================================================
-- CACHE LAYER
-- ============================================================

CREATE TABLE trend_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_date   date        NOT NULL,
  step_days     integer     NOT NULL,
  synthesis_en  text,                  -- EN trend analysis; may be null if that pass failed
  synthesis_zh  text,                  -- ZH trend analysis; may be null if that pass failed
  sources_json  jsonb       NOT NULL,  -- [{index, id, title, url, published_at, is_historical}]
  model         text        NOT NULL,
  tokens_used   integer,               -- null on abort; set on successful completion
  generated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL   -- generated_at + 6h for today; far-future for past dates
);

CREATE INDEX ON trend_briefs (anchor_date, step_days, expires_at);

-- Cache key: (anchor_date, step_days) WHERE expires_at > now()
-- No category column — one brief covers all categories for a given window.
-- RLS: anon key may read; only service role may insert/update.
ALTER TABLE trend_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_trend_briefs"
    ON trend_briefs FOR SELECT
    USING (true);

-- ============================================================
-- DELIVERY ACCOUNTING
-- ============================================================

CREATE TABLE digest_sent (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel      text        NOT NULL,  -- e.g. 'feishu', 'slack', 'discord', 'telegram', 'wecom', 'notion'
  anchor_date  date        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('pending','sent','failed','skipped_empty_brief')),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, anchor_date)  -- enables ON CONFLICT DO NOTHING claim
);

CREATE INDEX ON digest_sent (anchor_date DESC, channel);

-- Claim semantics: INSERT ... ON CONFLICT DO NOTHING RETURNING id — only
-- senders whose row comes back should actually deliver. Retries of the same
-- (channel, anchor_date) get an empty RETURNING and must skip.
-- RLS: no anon policy → anon blocked. Service role bypasses RLS for worker writes.
ALTER TABLE digest_sent ENABLE ROW LEVEL SECURITY;

CREATE TABLE channel_invites (
  channel       text PRIMARY KEY CHECK (channel IN ('feishu','slack','discord','telegram','wecom','notion')),
  language      text NOT NULL CHECK (language IN ('en','zh')),
  display_label text,
  invite_url    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channel_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_invites" ON channel_invites FOR SELECT USING (true);
```

### Observability Foundation (2026-05-03)

Migration: [supabase/sql/20260503_observability_foundation.sql](../supabase/sql/20260503_observability_foundation.sql)

Creates `pipeline_events` table, adds `run_id UUID` to `raw_ingestion` and `daily_news`, adds `request_id UUID` to `qa_logs`. All columns are nullable/additive — zero downtime.

### AI Keyword Gate RPC (2026-05-03)

Migration: [supabase/sql/20260503_is_ai_relevant.sql](../supabase/sql/20260503_is_ai_relevant.sql)

```sql
CREATE OR REPLACE FUNCTION public.is_ai_relevant(content TEXT, source_type TEXT DEFAULT 'article')
RETURNS BOOLEAN LANGUAGE plpgsql STABLE ...
```

EN word-boundary regex + ZH substring list. Called by `process-queue` and `ingest-apify-tweets`. Mirrored in `workers/ingest-builders/src/keywords.ts` (CF subrequest budget constraint). The SQL function is authoritative — keep `keywords.ts` in sync when keywords change.

### Feed RPC (2026-05-03, updated 2026-05-11)

Migration: [supabase/sql/20260503_fetch_grouped_feed.sql](../supabase/sql/20260503_fetch_grouped_feed.sql)
Updated: [supabase/sql/20260511_fetch_grouped_feed_add_metadata.sql](../supabase/sql/20260511_fetch_grouped_feed_add_metadata.sql)

```sql
CREATE OR REPLACE FUNCTION public.fetch_grouped_feed(
  p_date_start DATE, p_date_end DATE, p_category TEXT DEFAULT NULL,
  p_limit INT DEFAULT 10, p_cursor UUID DEFAULT NULL
) RETURNS TABLE (id UUID, title_en TEXT, title_zh TEXT, summary_en TEXT, summary_zh TEXT,
  source_type TEXT, source_id UUID, thread_group TEXT, url TEXT,
  published_at TIMESTAMPTZ, created_at TIMESTAMPTZ,
  questions JSONB, engagement JSONB, metadata JSONB, next_cursor UUID)
```

`thread_group` = `sources.metadata->>'handle'` for `x_api`/`apify_tweet` sources, NULL otherwise. `next_cursor` = oldest row id in the current page (keyset pagination). Date range uses `>= p_date_start AND < p_date_end` (exclusive end — matches app's `dateRange.end = midnight of next day` convention). `metadata` returns `daily_news.metadata` (AIHot: original outlet name in `metadata->>'source'`; NULL for others).

Note: `p_lang` parameter was removed in the 2026-05-03 version — all four bilingual columns are returned and the client switches language client-side. The 2026-05-11 update added `metadata JSONB` to the return type; because `CREATE OR REPLACE FUNCTION` cannot change return types, the old function was DROPped and recreated.

GRANT EXECUTE to `anon` and `authenticated`.

### `daily_news.metadata` column (2026-05-11)

Migration: [supabase/sql/20260511_add_daily_news_metadata.sql](../supabase/sql/20260511_add_daily_news_metadata.sql)

```sql
ALTER TABLE daily_news ADD COLUMN IF NOT EXISTS metadata JSONB;
```

Stores AIHot original outlet data `{source, title_en, category, aihot_id}` propagated by `process-queue` from `raw_ingestion.metadata` at insert time. NULL for all other source types.

### Round 1 Auth (2026-04-26)

The full migration lives at [supabase/sql/20260426_beta_invites.sql](../supabase/sql/20260426_beta_invites.sql) (idempotent — safe to re-run via the SQL Editor). Headline:

```sql
CREATE TABLE IF NOT EXISTS public.beta_invites (
  code          text PRIMARY KEY,
  display_name  text NOT NULL,
  default_lang  text NOT NULL DEFAULT 'zh' CHECK (default_lang IN ('en','zh')),
  email         text,                                              -- Round 2 reserved
  expires_at    timestamptz,
  used_at       timestamptz,
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS beta_invites_user_id_idx
  ON public.beta_invites(user_id) WHERE user_id IS NOT NULL;

-- RLS: enabled with NO policies — service role only.
ALTER TABLE public.beta_invites ENABLE ROW LEVEL SECURITY;

-- Helper for future user-scoped table RLS.
CREATE OR REPLACE FUNCTION public.is_beta_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.beta_invites
    WHERE user_id = auth.uid()
      AND used_at IS NOT NULL
      AND (expires_at IS NULL OR expires_at > now())
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_beta_user() TO anon, authenticated;
```

Operator workflow (mint an invite — Postgres has no `base64url` so the URL-safe replace chain is required):

```sql
INSERT INTO beta_invites (code, display_name, default_lang)
VALUES (
  replace(replace(replace(
    encode(gen_random_bytes(12), 'base64'),
    '+', '-'), '/', '_'), '=', ''),
  'Wang Lei', 'zh'
)
RETURNING code;
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
