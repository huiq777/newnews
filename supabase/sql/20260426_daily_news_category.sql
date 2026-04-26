-- 20260426 — Per-article category materialization (Spec C from pipeline-fixes-and-categorization-design.md)
-- Apply via Supabase SQL Editor. Idempotent (uses IF NOT EXISTS guards).
--
-- Why this migration exists:
--   PostgREST cannot OR across foreign-table joins, so daily_news.category must be
--   materialized at write time (in process-queue) rather than read-time-derived from
--   sources.category. This file adds the column with a NOT NULL CHECK constraint and
--   backfills existing rows from sources before dropping the transient default.
--
-- After this runs:
--   • daily_news.category is NOT NULL, CHECK-constrained to the 3-value enum
--   • Every existing row has category copied from its source
--   • idx_daily_news_category supports the frontend's eq('category', X) filter
--
-- The transient DEFAULT is required so the NOT NULL constraint can apply against
-- an existing populated table (Postgres enforces NOT NULL on every existing row at
-- ADD COLUMN time). After backfill we drop the default so future inserts must
-- supply category explicitly — daily_news writes flow through process-queue, which
-- always emits a category (LLM output validated, fallback to sources.category).

-- ── Add column (idempotent) ──────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'daily_news' and column_name = 'category'
  ) then
    alter table daily_news
      add column category text not null default 'industry'
      check (category in ('industry','technical_frontier','career_community'));
  end if;
end $$;

-- ── Backfill from sources (idempotent — overwrites only NULLs are not possible
--    since column is NOT NULL with default; this UPDATE is safe to re-run because
--    sources.category does not change).
--
--    The `sources.category is not null` guard is required: if any sources row
--    has a NULL category (data-quality artifact predating this migration), the
--    UPDATE would try to write NULL and trip the NOT NULL constraint we just
--    added. Rows whose source has a NULL category keep the transient 'industry'
--    default, and can be re-mapped later by fixing the sources row and re-running
--    this UPDATE — it is idempotent.
update daily_news
set category = sources.category
from sources
where daily_news.source_id = sources.id
  and sources.category is not null
  and daily_news.category is distinct from sources.category;

-- ── Drop transient default (idempotent — DROP DEFAULT is a no-op if no default) ─
alter table daily_news alter column category drop default;

-- ── Index for the frontend's eq('category', X) filter (idempotent) ────────────
create index if not exists idx_daily_news_category on daily_news (category);
