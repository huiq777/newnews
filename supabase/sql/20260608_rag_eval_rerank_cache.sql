-- 20260608 — RAG eval rerank cache.
--
-- Service-role-only cache for eval rerank sweeps. Cache key includes normalized
-- query, ordered candidate ids, context hashes, rerank model, chunking version,
-- and strategy variant.

create extension if not exists pgcrypto;

create table if not exists public.rag_eval_rerank_cache (
  id                     uuid primary key default gen_random_uuid(),
  cache_key text not null,
  cache_version text not null,
  normalized_query       text not null,
  rerank_model           text not null,
  chunking_version       text,
  strategy_variant       text not null,
  ordered_candidate_ids  uuid[] not null,
  context_hashes         text[] not null,
  value                  jsonb not null default '{}'::jsonb,
  stale_reason text,
  created_at             timestamptz not null default now(),
  unique(cache_key)
);

create index if not exists rag_eval_rerank_cache_model_idx
  on public.rag_eval_rerank_cache(rerank_model, chunking_version, strategy_variant);

alter table public.rag_eval_rerank_cache enable row level security;

revoke all on public.rag_eval_rerank_cache from anon, authenticated;
grant all on public.rag_eval_rerank_cache to service_role;

-- Read-only p95 latency diagnostic. Interpret p95 separately for cold and warm
-- cache runs; do not mix them when deciding release gates.
select
  rr.retrieval_strategy,
  rr.query_input->>'cache_hit' as cache_hit,
  percentile_cont(0.5) within group (order by (rr.query_input->>'rerank_latency_ms')::integer) as rerank_p50_ms,
  percentile_cont(0.95) within group (order by (rr.query_input->>'rerank_latency_ms')::integer) as rerank_p95_ms,
  percentile_cont(0.95) within group (order by (rr.query_input->>'cold_cache_latency_ms')::integer) as cold_cache_p95_ms,
  percentile_cont(0.95) within group (order by (rr.query_input->>'warm_cache_latency_ms')::integer) as warm_cache_p95_ms
from public.rag_retrieval_runs rr
where rr.query_input ? 'rerank_metadata'
group by rr.retrieval_strategy, rr.query_input->>'cache_hit'
order by rr.retrieval_strategy, cache_hit;
