# Database Schema

## Overview

The schema is organized into two layers:

- **Ingestion layer** (`sources`, `raw_ingestion`) — managed exclusively by n8n. Never written to by the frontend client.
- **Product layer** (`daily_news`, `chat_sessions`, `messages`) — read by the frontend, written by n8n and Edge Functions via the service role.

All tables have Row Level Security enabled. Client access is granted only where explicitly needed.

---

## Table Descriptions

### `sources`
Registry of RSS feeds. Adding a new feed means inserting a row here — no pipeline changes required. The `is_active` flag lets you pause a feed temporarily without deleting its history.

### `raw_ingestion`
The ingestion queue. n8n writes raw article content here and tracks processing state. Acts as a buffer between fetching and summarization — the two operations are decoupled intentionally (see [architecture.md](architecture.md)). The `status` column is a state machine: `pending → processing → done` or `pending → processing → error`. `retry_count` tracks failed attempts; after 3 failures the row is permanently set to `error` and excluded from future processing runs.

### `daily_news`
The clean, production-ready article store. Contains AI-generated summaries and Cohere vector embeddings. This is what the frontend reads and what the RAG chatbot searches. Linked back to `raw_ingestion` via `raw_ingestion_id` for audit traceability.

### `chat_sessions`
Metadata for a user's conversation. Created on first message. Title can be auto-generated or user-edited.

### `messages`
Individual turns in a conversation. `role` is constrained to `user`, `assistant`, or `system`. Linked to `chat_sessions` — the RLS policy on this table uses an EXISTS join through the session to verify ownership, so users can only access messages in sessions they own.

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
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE ingestion_status AS ENUM ('pending', 'processing', 'done', 'error');

CREATE TABLE raw_ingestion (
    id           UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id    UUID              NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url          TEXT              UNIQUE NOT NULL,
    raw_content  TEXT,
    fetched_at   TIMESTAMPTZ       NOT NULL DEFAULT now(),
    status       ingestion_status  NOT NULL DEFAULT 'pending',
    retry_count  INTEGER           NOT NULL DEFAULT 0,
    last_error   TEXT,
    processed_at TIMESTAMPTZ
);


-- ============================================================
-- PRODUCT LAYER
-- ============================================================

CREATE TABLE daily_news (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id        UUID        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    raw_ingestion_id UUID        NOT NULL REFERENCES raw_ingestion(id) ON DELETE RESTRICT,
    url              TEXT        UNIQUE NOT NULL,
    title            TEXT        NOT NULL,
    summary          TEXT        NOT NULL,
    published_at     TIMESTAMPTZ,
    embedding        vector(1024),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_sessions (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID        NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content    TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- INDEXES
-- ============================================================

-- Partial index: n8n polls this constantly to find work
CREATE INDEX idx_raw_ingestion_pending
    ON raw_ingestion (status)
    WHERE status = 'pending';

-- Partial index: n8n embedding workflow polls for un-embedded articles
CREATE INDEX idx_daily_news_no_embedding
    ON daily_news (id)
    WHERE embedding IS NULL;

-- The RLS EXISTS join on messages fires on every row access without this
CREATE INDEX idx_messages_session_id
    ON messages (session_id);

-- The RLS policy on chat_sessions filters by this on every query
CREATE INDEX idx_chat_sessions_user_id
    ON chat_sessions (user_id);

-- HNSW vector index for similarity search — built incrementally, no cold-start issue
-- Uses cosine distance to match how Cohere embeddings are compared at query time
CREATE INDEX idx_daily_news_embedding
    ON daily_news
    USING hnsw (embedding vector_cosine_ops);


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- raw_ingestion: locked entirely from client access
-- The service role (used by n8n) bypasses RLS automatically
ALTER TABLE raw_ingestion ENABLE ROW LEVEL SECURITY;
-- No policies defined = no client can SELECT, INSERT, UPDATE, or DELETE

-- sources: clients may read the feed list (useful for UI), but cannot modify
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_sources"
    ON sources FOR SELECT
    USING (true);

-- daily_news: all authenticated (and anonymous) users may read articles
ALTER TABLE daily_news ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_daily_news"
    ON daily_news FOR SELECT
    USING (true);

-- chat_sessions: users can only access their own sessions
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_all_chat_sessions"
    ON chat_sessions FOR ALL
    USING (auth.uid() = user_id);

-- messages: users can only access messages in sessions they own
-- Uses EXISTS join — do NOT simplify to a direct column check without also
-- adding user_id to the messages table, or a user could insert into any session by guessing its UUID
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_all_messages"
    ON messages FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM chat_sessions
            WHERE chat_sessions.id = messages.session_id
            AND chat_sessions.user_id = auth.uid()
        )
    );
```

---

## Key Design Decisions

**Why `raw_ingestion_id` and not `url` as the FK on `daily_news`?**
Foreign keys should reference primary keys. A FK on `raw_ingestion.url` (a business field) would prevent correcting or cleaning up raw ingestion records without cascading deletes into the clean `daily_news` table. Using the UUID primary key keeps the coupling structural, not semantic.

**Why `ON DELETE RESTRICT` on `raw_ingestion_id`?**
A processed article in `daily_news` should never silently disappear because its source queue row was deleted. RESTRICT forces you to explicitly handle this case rather than accidentally losing production data.

**Why HNSW over IVFFlat?**
IVFFlat requires training on an existing dataset to compute centroids — it performs poorly on a cold-start database. HNSW builds its index incrementally with each insert and delivers strong query performance from row one.
