-- 20260426 — Bounded arXiv backfill (Spec A)
-- Apply via Supabase SQL Editor AFTER deploying the process-queue Edge Function
-- with the source-type-aware prompt header. Re-queues arXiv rows that were
-- previously rejected as INSUFFICIENT_CONTENT so they get a second pass with
-- the new prompt.
--
-- Why bounded:
--   Groq TPD is a 100K daily quota with no quiet window. An unbounded backfill
--   floods the day's normal pipeline. The 3-day window keeps the wave small;
--   for older rows, re-run with the LIMIT 15 batched form below on subsequent
--   days (after that day's normal traffic has settled) until caught up.
--
-- Run order:
--   1. Deploy process-queue (with arXiv header in buildOpenRouterRequest +
--      callGroqFallback).
--   2. Run the 3-day re-queue below.
--   3. (Optional) For older rows, run the LIMIT-15 form on subsequent days.

-- ── 3-day window re-queue (recent rejections) ────────────────────────────────
update raw_ingestion ri
set status = 'pending', last_error = null, retry_count = 0
from sources s
where ri.source_id = s.id
  and s.source_type = 'arxiv'
  and ri.last_error = 'INSUFFICIENT_CONTENT'
  and ri.fetched_at > now() - interval '3 days'
  and not exists (select 1 from daily_news dn where dn.raw_ingestion_id = ri.id);

-- ── LIMIT-15 form for older rows (run on subsequent days as needed) ──────────
-- update raw_ingestion ri
-- set status = 'pending', last_error = null, retry_count = 0
-- where ri.id in (
--   select ri2.id
--   from raw_ingestion ri2
--   join sources s2 on s2.id = ri2.source_id
--   where s2.source_type = 'arxiv'
--     and ri2.last_error = 'INSUFFICIENT_CONTENT'
--     and not exists (select 1 from daily_news dn where dn.raw_ingestion_id = ri2.id)
--   order by ri2.fetched_at desc
--   limit 15
-- );

-- Verification (run after the re-queue):
--   select count(*) from raw_ingestion ri
--   join sources s on s.id = ri.source_id
--   where s.source_type = 'arxiv' and ri.status = 'pending';
-- Expected: increment matching the count returned by the UPDATE.
