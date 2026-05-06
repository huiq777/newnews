-- 20260503 — fetch_grouped_feed: server-side feed grouping + keyset pagination.
-- Replaces client-side Twitter thread grouping (useMemo in App.tsx) and
-- offset-based pagination (currentOffset state). Returns thread_group field
-- for render-only grouping and next_cursor UUID for stateless pagination.
--
-- Returns all four language columns (title_en/zh, summary_en/zh) so the client
-- can switch language without re-fetching, preserving scroll position.

CREATE OR REPLACE FUNCTION public.fetch_grouped_feed(
  p_date_start  DATE,
  p_date_end    DATE,
  p_category    TEXT    DEFAULT NULL,
  p_limit       INT     DEFAULT 10,
  p_cursor      UUID    DEFAULT NULL
)
RETURNS TABLE (
  id            UUID,
  title_en      TEXT,
  title_zh      TEXT,
  summary_en    TEXT,
  summary_zh    TEXT,
  source_type   TEXT,
  source_id     UUID,
  thread_group  TEXT,
  url           TEXT,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ,
  questions     JSONB,
  engagement    JSONB,
  next_cursor   UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH ranked AS (
    SELECT
      dn.id,
      COALESCE(dn.title_en,   dn.title)   AS title_en,
      COALESCE(dn.title_zh,   dn.title)   AS title_zh,
      COALESCE(dn.summary_en, dn.summary) AS summary_en,
      COALESCE(dn.summary_zh, dn.summary) AS summary_zh,
      s.source_type,
      dn.source_id,
      CASE WHEN s.source_type IN ('x_api', 'apify_tweet') THEN s.metadata->>'handle' ELSE NULL END AS thread_group,
      dn.url,
      dn.published_at,
      dn.created_at,
      dn.questions,
      dn.engagement
    FROM daily_news dn
    JOIN sources s ON s.id = dn.source_id
    WHERE
      (
        (dn.published_at::date >= p_date_start AND dn.published_at::date < p_date_end)
        OR
        (dn.published_at IS NULL AND dn.created_at::date >= p_date_start AND dn.created_at::date < p_date_end)
      )
      AND (p_category IS NULL OR dn.category = p_category)
      AND (p_cursor IS NULL OR dn.created_at < (SELECT created_at FROM daily_news WHERE id = p_cursor))
    ORDER BY dn.created_at DESC
    LIMIT p_limit
  )
  SELECT
    r.id,
    r.title_en,
    r.title_zh,
    r.summary_en,
    r.summary_zh,
    r.source_type,
    r.source_id,
    r.thread_group,
    r.url,
    r.published_at,
    r.created_at,
    r.questions,
    r.engagement,
    (SELECT id FROM ranked ORDER BY created_at ASC LIMIT 1) AS next_cursor
  FROM ranked r
  ORDER BY r.created_at DESC;
$$;

-- Drop the old p_lang overload if it exists (signature changed)
DROP FUNCTION IF EXISTS public.fetch_grouped_feed(DATE, DATE, TEXT, TEXT, INT, UUID);

GRANT EXECUTE ON FUNCTION public.fetch_grouped_feed(DATE, DATE, TEXT, INT, UUID) TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_grouped_feed(DATE, DATE, TEXT, INT, UUID) TO authenticated;
