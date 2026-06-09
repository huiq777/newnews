-- 20260608 — Corpus-health blocker diagnostics.
--
-- Explain approved relevant gold articles and active sources that block
-- chunk-dependent release-grade replay.

-- Approved relevant gold articles with missing required chunks/embeddings.
with default_set as (
  select id
  from public.rag_eval_sets
  where name = 'qa-v1-2026-06'
  order by created_at desc
  limit 1
),
approved_relevant_gold as (
  select
    c.id as case_id,
    c.question,
    g.article_id,
    g.relevance_grade,
    g.metadata
  from public.rag_eval_cases c
  join public.rag_eval_gold_evidence g on g.case_id = c.id
  join default_set s on s.id = c.eval_set_id
  where g.review_status = 'approved'
    and coalesce(g.metadata->>'evidence_role', '') <> 'hard_negative'
    and g.relevance_grade >= 2
),
chunk_counts as (
  select
    article_id,
    chunking_version,
    count(*) as chunk_count,
    count(*) filter (
      where embedding_model = '@cf/baai/bge-m3'
        and embedding is not null
    ) as bge_chunk_count
  from public.article_chunks
  group by article_id, chunking_version
),
gold_with_chunks as (
  select
    g.case_id,
    g.question,
    g.article_id,
    g.relevance_grade,
    dn.title,
    dn.url,
    s.source_type,
    s.name as source_name,
    coalesce(dn.published_at, ri.published_at) as published_at,
    length(coalesce(dn.article_content, '')) as article_content_chars,
    length(coalesce(dn.summary_en, dn.summary_zh, dn.summary, '')) as summary_chars,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'chunking_version', cc.chunking_version,
          'chunk_count', cc.chunk_count,
          'bge_chunk_count', cc.bge_chunk_count
        )
        order by cc.chunking_version
      ) filter (where cc.article_id is not null),
      '[]'::jsonb
    ) as chunk_versions
  from approved_relevant_gold g
  join public.daily_news dn on dn.id = g.article_id
  left join public.raw_ingestion ri on ri.id = dn.raw_ingestion_id
  left join public.sources s on s.id = dn.source_id
  left join chunk_counts cc on cc.article_id = g.article_id
  group by
    g.case_id,
    g.question,
    g.article_id,
    g.relevance_grade,
    dn.title,
    dn.url,
    s.source_type,
    s.name,
    dn.published_at,
    ri.published_at,
    dn.article_content,
    dn.summary_en,
    dn.summary_zh,
    dn.summary
)
select
  *,
  case
    when chunk_versions = '[]'::jsonb and article_content_chars = 0 and summary_chars = 0
      then 'missing_article_text'
    when chunk_versions = '[]'::jsonb and article_content_chars < 200
      then 'below_default_chunk_backfill_min_chars'
    when chunk_versions = '[]'::jsonb
      then 'needs_chunk_backfill'
    when not exists (
      select 1
      from jsonb_array_elements(chunk_versions) entry
      where entry->>'chunking_version' = 'paragraph-window-v1-2026-06-02'
        and (entry->>'bge_chunk_count')::integer > 0
    )
      then 'missing_required_chunking_or_embedding'
    else 'healthy'
  end as invalid_reason
from gold_with_chunks
where not exists (
  select 1
  from jsonb_array_elements(chunk_versions) entry
  where entry->>'chunking_version' = 'paragraph-window-v1-2026-06-02'
    and (entry->>'bge_chunk_count')::integer > 0
)
order by source_type, published_at desc nulls last, article_id;

-- Active sources with stale raw or processed freshness.
with source_freshness as (
  select
    s.id as source_id,
    s.name,
    s.source_type,
    s.rss_url,
    s.is_active,
    max(ri.fetched_at) as newest_raw_row_at,
    max(dn.created_at) as newest_processed_daily_news_at,
    count(ri.id) filter (where ri.fetched_at >= now() - interval '24 hours') as raw_rows_last_24h,
    count(dn.id) filter (where dn.created_at >= now() - interval '48 hours') as processed_rows_last_48h
  from public.sources s
  left join public.raw_ingestion ri on ri.source_id = s.id
  left join public.daily_news dn on dn.source_id = s.id
  where s.is_active = true
    and s.source_type in ('wechat', 'reddit', 'youtube')
  group by s.id, s.name, s.source_type, s.rss_url, s.is_active
)
select
  source_id,
  name,
  source_type,
  rss_url,
  is_active,
  newest_raw_row_at,
  newest_processed_daily_news_at,
  raw_rows_last_24h,
  processed_rows_last_48h,
  case
    when is_active is not true then 'disabled'
    when newest_raw_row_at is null then 'never_succeeded'
    when newest_raw_row_at < now() - interval '48 hours' then 'stale_success'
    when newest_processed_daily_news_at is null then 'no_processed_articles'
    else 'healthy'
  end as freshness_status
from source_freshness
where is_active = true
  and (
    newest_raw_row_at is null
    or newest_raw_row_at < now() - interval '48 hours'
    or newest_processed_daily_news_at is null
  )
order by newest_raw_row_at asc nulls first, name;
