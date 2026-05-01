-- 20260426 — Move Reddit sources from ingest-rss to ingest-builders (Spec B.1)
-- Apply via Supabase SQL Editor AFTER deploying:
--   • workers/ingest-builders (Reddit JSON branch + UA fix + selftext)
--   • workers/ingest-rss (filter tightened to drop 'reddit' from the IN list)
--
-- Why this migration exists:
--   The Reddit JSON branch in ingest-builders was dead code — gated on
--   source_type='reddit', but every Reddit row had source_type='rss'. Flipping
--   the source_type activates the correct path. We do NOT null out rss_url:
--   keeping the URL preserves a fast rollback path if Reddit later rate-limits
--   or 403s our UA — a one-line UPDATE flips back to source_type='rss' without
--   re-discovering the feed URLs. ingest-builders ignores rss_url, so the
--   stale value is harmless.

update sources
set source_type = 'reddit'
where name like 'Reddit r/%'
  and source_type = 'rss';

-- Verification (run separately after the UPDATE):
--   select name, source_type, rss_url from sources where name like 'Reddit r/%';
-- Expected: every Reddit row has source_type='reddit', rss_url preserved.
