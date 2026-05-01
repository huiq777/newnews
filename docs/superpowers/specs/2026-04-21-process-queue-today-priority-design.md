# Design Spec: Prioritize Today's Articles in `claim_pending_batch`

**Date:** 2026-04-21  
**Status:** Approved  
**Author:** Architect role  
**Scope:** SQL only — no Edge Function code change

---

## Context

`claim_pending_batch` currently selects the next 5 pending rows ordered by `fetched_at ASC` (pure FIFO). When the queue has a backlog of unprocessed articles from previous days, today's newly ingested articles queue behind them and may not reach users until hours later — or not at all if the backlog exceeds daily throughput.

The fix is a three-tier `ORDER BY`:
- **Tier 0:** `published_at` = today (ET) — article explicitly published today
- **Tier 1:** `published_at` IS NULL AND `fetched_at` = today (ET) — no pub date but freshly ingested today (typical for tweets, and RSS feeds that omit `<pubDate>`)
- **Tier 2:** everything else — backlog, FIFO

---

## Change

**Only `claim_pending_batch` changes.** The Edge Function at `supabase/functions/process-queue/index.ts` is unchanged — it calls the RPC and processes all returned rows in parallel via `Promise.all()`; it does not depend on row order.

### Updated SQL

Run in Supabase SQL editor. `CREATE OR REPLACE` is idempotent — safe to apply to production.

```sql
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
  -- The subquery evaluates without locking rows — two concurrent Edge Function
  -- invocations can both read the same pending IDs. Adding AND status='pending'
  -- to the outer UPDATE forces Postgres to re-read the live row state (MVCC)
  -- after acquiring the lock. If Worker A already committed status='processing',
  -- Worker B's predicate fails and it returns 0 rows cleanly — no duplicate
  -- LLM calls, no token waste.
  AND status = 'pending'
  RETURNING *;
END;
$$;
REVOKE EXECUTE ON FUNCTION claim_pending_batch(int) FROM PUBLIC;
```

---

## Design Decisions

### Why three tiers, not two

Tweets and some RSS feeds never populate `raw_ingestion.published_at` — it stays NULL at ingest time. Under the original two-tier design these rows always fell to the backlog tier, even when freshly ingested minutes ago. The three-tier design uses `fetched_at` as a proxy for freshness when `published_at` is absent: if a row was fetched today, it is by definition today's content and deserves priority over yesterday's unprocessed backlog.

Tier 0 (explicit `published_at`) ranks above Tier 1 (null `published_at`, today `fetched_at`) because `published_at` is the authoritative content date — a tweet with an explicit publish timestamp is confirmed today's content, while a null-date row could theoretically be a re-ingestion of older content.

### Why `'America/New_York'` not `'EST'`

`'EST'` is a fixed UTC-5 offset with no DST awareness. From March to November the US East Coast runs on EDT (UTC-4). Using `'EST'` year-round would misclassify articles published in the 8–9 PM EST window as "tomorrow" during summer. `'America/New_York'` uses the IANA timezone database and shifts automatically.

### Why `AND status = 'pending'` on the outer UPDATE

The subquery (`SELECT id FROM raw_ingestion WHERE status = 'pending'`) evaluates at snapshot isolation without locking the rows it reads. Under concurrent invocations:

1. Worker A and Worker B both execute the subquery — they read the same 5 IDs.
2. Worker A acquires row locks and commits `status = 'processing'`.
3. Worker B acquires the same row locks. Without the outer guard, it executes `SET status = 'processing'` again and returns the same 5 rows — both workers process the same articles, burning ~12,550 tokens per overlap with no data protection (only `ON CONFLICT DO NOTHING` in `daily_news` prevents duplicates there).
4. With `AND status = 'pending'`, Worker B re-reads the live row state after acquiring the lock, finds `status = 'processing'`, fails the predicate, and returns 0 rows.

This replaces `FOR UPDATE SKIP LOCKED`, which caused "Lock was stolen by another request" errors via PostgREST in production.

### Why no index change

The existing partial index `idx_raw_ingestion_pending ON raw_ingestion (status) WHERE status = 'pending'` already filters the pending set. The `ORDER BY CASE...` sort runs over that filtered set — typically <200 rows — with no performance concern.

---

## Verification

**Before applying — preview the new sort order:**
```sql
SELECT id, published_at, fetched_at, status,
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
  END AS priority_tier
FROM raw_ingestion
WHERE status = 'pending'
ORDER BY priority_tier ASC, fetched_at ASC
LIMIT 10;
-- Tier 0 rows (published today) → Tier 1 rows (fetched today, no pub date) → Tier 2 (backlog).
```

**After applying — confirm function updated:**
```sql
SELECT prosrc FROM pg_proc WHERE proname = 'claim_pending_batch';
-- Should contain 'America/New_York' and 'AND status'
```

**End-to-end — trigger the Edge Function manually and confirm today's articles are claimed first:**
```sql
-- Trigger: curl -X POST <SUPABASE_URL>/functions/v1/process-queue \
--   -H "Authorization: Bearer <SERVICE_ROLE_KEY>"

-- Then check:
SELECT id, published_at, status
FROM raw_ingestion
WHERE status = 'processing'
ORDER BY fetched_at DESC
LIMIT 5;
-- Today's articles should appear here before older backlog items.
```
