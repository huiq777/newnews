-- 20260608 — RAG eval corpus-health preflight gate.
--
-- Evaluation-only corpus health. This creates the persisted source of truth for
-- deciding whether retrieval replay results are valid for strategy selection.
-- Production answer-question retrieval is unchanged.

create extension if not exists pgcrypto;

create table if not exists public.rag_eval_corpus_health_runs (
  id                         uuid primary key default gen_random_uuid(),
  eval_set_id                uuid not null references public.rag_eval_sets(id) on delete cascade,
  chunking_version           text not null,
  embedding_model            text not null,
  ready_for_taxonomy         boolean not null default false,
  ready_for_hard_negatives   boolean not null default false,
  ready_for_replay           boolean not null default false,
  summary jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

create index if not exists rag_eval_corpus_health_runs_set_created_idx
  on public.rag_eval_corpus_health_runs(eval_set_id, created_at desc);

alter table public.rag_eval_corpus_health_runs enable row level security;

revoke all on public.rag_eval_corpus_health_runs from anon, authenticated;
grant all on public.rag_eval_corpus_health_runs to service_role;

-- Read-only diagnostic: source freshness by source type.
-- Active WeChat / Reddit / YouTube source rows in the last 24h, newest raw row
-- per active source, and newest processed daily_news row per active source.
with source_freshness_by_type as (
  select
    s.source_type,
    s.id as source_id,
    s.name,
    count(ri.id) filter (where ri.fetched_at >= now() - interval '24 hours') as raw_rows_last_24h,
    max(ri.fetched_at) as newest_raw_row_at,
    max(dn.created_at) as newest_processed_daily_news_at
  from public.sources s
  left join public.raw_ingestion ri on ri.source_id = s.id
  left join public.daily_news dn on dn.source_id = s.id
  where s.is_active = true
    and s.source_type in ('wechat', 'reddit', 'youtube')
  group by s.source_type, s.id, s.name
)
select *
from source_freshness_by_type
order by source_type, name;

-- Read-only diagnostic: Deep Analysis readiness.
with deep_analysis_readiness as (
  select
    count(*) filter (where length(coalesce(dn.article_content, '')) > 500 and ada.status = 'ready') as eligible_ready_count,
    count(*) filter (where ada.status = 'pending') as deep_analysis_pending,
    count(*) filter (where ada.status = 'processing' and ada.updated_at < now() - interval '15 minutes') as deep_analysis_processing_stale,
    count(*) filter (where ada.status = 'error' and coalesce(ada.retry_count, 0) < 3) as deep_analysis_retryable_errors,
    count(*) filter (where ada.status = 'ineligible' and length(coalesce(dn.article_content, '')) <= 500) as short_or_empty_ineligible_articles
  from public.daily_news dn
  left join public.article_deep_analysis ada on ada.article_id = dn.id
)
select *
from deep_analysis_readiness;

-- Read-only diagnostic: approved gold article chunk and BGE embedding coverage.
with params as (
  select
    'qa-v1-2026-06'::text as eval_set_name,
    'paragraph-window-v1-2026-06-02'::text as chunking_version,
    '@cf/baai/bge-m3'::text as embedding_model
),
approved_gold_articles as (
  select distinct g.article_id
  from params p
  join public.rag_eval_sets es on es.name = p.eval_set_name
  join public.rag_eval_cases c on c.eval_set_id = es.id
  join public.rag_eval_gold_evidence g on g.case_id = c.id
  where g.review_status = 'approved'
    and g.relevance_grade >= 2
),
chunk_coverage as (
  select
    aga.article_id,
    count(ac.id) filter (where ac.chunking_version = p.chunking_version) as chunk_count,
    count(ac.id) filter (
      where ac.chunking_version = p.chunking_version
        and ac.embedding_model = '@cf/baai/bge-m3'
        and ac.embedding is not null
    ) as bge_embedding_chunk_count
  from params p
  cross join approved_gold_articles aga
  left join public.article_chunks ac on ac.article_id = aga.article_id
  group by aga.article_id
),
chunk_count_by_version as (
  select ac.chunking_version, count(*) as chunk_count
  from public.article_chunks ac
  group by ac.chunking_version
)
select
  count(*) filter (where coalesce(chunk_count, 0) = 0) as zero_chunk_gold_articles,
  count(*) filter (where coalesce(chunk_count, 0) > 0 and coalesce(bge_embedding_chunk_count, 0) = 0) as missing_bge_embedding_gold_articles,
  (select jsonb_object_agg(chunking_version, chunk_count) from chunk_count_by_version) as chunk_count_by_version
from chunk_coverage;

-- Persist a corpus-health run for the default eval set and chunk baseline.
-- Edit the params CTE before running if the official eval set, chunking version,
-- or embedding model changes.
with params as (
  select
    'qa-v1-2026-06'::text as eval_set_name,
    'paragraph-window-v1-2026-06-02'::text as chunking_version,
    '@cf/baai/bge-m3'::text as embedding_model
),
eval_set as (
  select es.id
  from params p
  join public.rag_eval_sets es on es.name = p.eval_set_name
),
source_freshness_by_type as (
  select
    s.id as source_id,
    count(ri.id) filter (where ri.fetched_at >= now() - interval '24 hours') as raw_rows_last_24h,
    max(ri.fetched_at) as newest_raw_row_at,
    max(dn.created_at) as newest_processed_daily_news_at
  from public.sources s
  left join public.raw_ingestion ri on ri.source_id = s.id
  left join public.daily_news dn on dn.source_id = s.id
  where s.is_active = true
    and s.source_type in ('wechat', 'reddit', 'youtube')
  group by s.id
),
deep_analysis_readiness as (
  select
    count(*) filter (where ada.status = 'pending') as deep_analysis_pending,
    count(*) filter (where ada.status = 'processing' and ada.updated_at < now() - interval '15 minutes') as deep_analysis_processing_stale,
    count(*) filter (where ada.status = 'error' and coalesce(ada.retry_count, 0) < 3) as deep_analysis_retryable_errors,
    count(*) filter (where ada.status = 'ineligible' and length(coalesce(dn.article_content, '')) <= 500) as short_or_empty_ineligible_articles
  from public.daily_news dn
  left join public.article_deep_analysis ada on ada.article_id = dn.id
),
approved_gold_articles as (
  select distinct g.article_id
  from eval_set es
  join public.rag_eval_cases c on c.eval_set_id = es.id
  join public.rag_eval_gold_evidence g on g.case_id = c.id
  where g.review_status = 'approved'
    and g.relevance_grade >= 2
),
chunk_coverage as (
  select
    aga.article_id,
    count(ac.id) filter (where ac.chunking_version = p.chunking_version) as chunk_count,
    count(ac.id) filter (
      where ac.chunking_version = p.chunking_version
        and ac.embedding_model = p.embedding_model
        and ac.embedding is not null
    ) as bge_embedding_chunk_count
  from params p
  cross join approved_gold_articles aga
  left join public.article_chunks ac on ac.article_id = aga.article_id
  group by aga.article_id
),
chunk_count_by_version as (
  select ac.chunking_version, count(*) as chunk_count
  from public.article_chunks ac
  group by ac.chunking_version
),
summary as (
  select
    jsonb_build_object(
      'zero_chunk_gold_articles', count(*) filter (where coalesce(cc.chunk_count, 0) = 0),
      'missing_bge_embedding_gold_articles', count(*) filter (where coalesce(cc.chunk_count, 0) > 0 and coalesce(cc.bge_embedding_chunk_count, 0) = 0),
      'stale_source_count', (
  select count(*)
  from source_freshness_by_type
  where newest_processed_daily_news_at is null
     or (
       newest_raw_row_at is null
       and coalesce(raw_rows_last_24h, 0) = 0
     )
),
      'deep_analysis_pending', (select deep_analysis_pending from deep_analysis_readiness),
      'deep_analysis_processing_stale', (select deep_analysis_processing_stale from deep_analysis_readiness),
      'deep_analysis_retryable_errors', (select deep_analysis_retryable_errors from deep_analysis_readiness),
      'short_or_empty_ineligible_articles', (select short_or_empty_ineligible_articles from deep_analysis_readiness),
      'chunk_count_by_version', (select coalesce(jsonb_object_agg(chunking_version, chunk_count), '{}'::jsonb) from chunk_count_by_version)
    ) as summary
  from chunk_coverage cc
),
readiness as (
  select
    summary,
    true as ready_for_taxonomy,
    true as ready_for_hard_negatives,
    (
      coalesce((summary->>'zero_chunk_gold_articles')::integer, 0) = 0
      and coalesce((summary->>'missing_bge_embedding_gold_articles')::integer, 0) = 0
      and coalesce((summary->>'stale_source_count')::integer, 0) = 0
    ) as ready_for_replay
  from summary
)
insert into public.rag_eval_corpus_health_runs (
  eval_set_id,
  chunking_version,
  embedding_model,
  ready_for_taxonomy,
  ready_for_hard_negatives,
  ready_for_replay,
  summary
)
select
  es.id,
  p.chunking_version,
  p.embedding_model,
  r.ready_for_taxonomy,
  r.ready_for_hard_negatives,
  r.ready_for_replay,
  r.summary
from eval_set es
cross join params p
cross join readiness r
returning *;
