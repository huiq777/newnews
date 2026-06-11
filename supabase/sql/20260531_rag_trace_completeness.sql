-- 20260531 — RAG Trace Completeness, Phase 1.
--
-- Observability-only migration. It does not change any retriever, ranking,
-- prompt, or model behavior. The Edge Functions write these tables with the
-- service role so production RAG requests can be replayed and evaluated later.

create extension if not exists pgcrypto;

create table if not exists public.rag_retrieval_runs (
  id                       uuid primary key default gen_random_uuid(),
  surface                  text not null,
  request_id               uuid,

  -- Back-links into the production surfaces that caused this retrieval.
  qa_log_id                uuid references public.qa_logs(id) on delete set null,
  trend_brief_key          text,
  trend_brief_anchor_date  date,
  trend_brief_step_days    integer,
  trend_brief_category     text,
  analysis_id              uuid,

  -- Retriever inputs and versioning.
  query_text               text,
  query_input              jsonb not null default '{}'::jsonb,
  query_embedding_model    text,
  embedding_input_type     text,
  retrieval_strategy       text not null,
  retrieval_version        text not null,
  retriever_name           text not null,
  match_count              integer,

  -- Observed result shape and packed context.
  candidate_count          integer not null default 0,
  injected_count           integer not null default 0,
  context_total_chars      integer,
  prompt_context_hash      text,
  latency_ms               integer,

  created_at               timestamptz not null default now()
);

create table if not exists public.rag_retrieval_candidates (
  id                       uuid primary key default gen_random_uuid(),
  retrieval_run_id         uuid not null references public.rag_retrieval_runs(id) on delete cascade,
  rank                     integer not null,

  candidate_type           text not null check (candidate_type in ('article', 'chunk', 'deep_analysis')),
  article_id               uuid references public.daily_news(id) on delete set null,
  chunk_id                 uuid,
  analysis_id              uuid,

  title                    text,
  summary_excerpt          text,
  score_dense              double precision,
  score_lexical            double precision,
  score_rerank             double precision,
  score_final              double precision,
  embedding_source         text,

  injected                 boolean not null default false,
  drop_reason              text,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),

  unique (retrieval_run_id, rank)
);

create table if not exists public.rag_injected_contexts (
  id                       uuid primary key default gen_random_uuid(),
  retrieval_run_id         uuid not null references public.rag_retrieval_runs(id) on delete cascade,
  ordinal                  integer not null,

  context_role             text not null,
  candidate_id             uuid references public.rag_retrieval_candidates(id) on delete set null,
  article_id               uuid references public.daily_news(id) on delete set null,
  chunk_id                 uuid,
  analysis_id              uuid,

  context_text             text,
  context_hash             text not null,
  context_chars            integer not null,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),

  unique (retrieval_run_id, ordinal)
);

alter table public.qa_logs
  add column if not exists rag_retrieval_run_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'qa_logs_rag_retrieval_run_id_fkey'
      and conrelid = 'public.qa_logs'::regclass
  ) then
    alter table public.qa_logs
      add constraint qa_logs_rag_retrieval_run_id_fkey
      foreign key (rag_retrieval_run_id)
      references public.rag_retrieval_runs(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists rag_retrieval_runs_surface_created_idx
  on public.rag_retrieval_runs(surface, created_at desc);

create index if not exists rag_retrieval_runs_request_id_idx
  on public.rag_retrieval_runs(request_id)
  where request_id is not null;

create index if not exists rag_retrieval_runs_qa_log_id_idx
  on public.rag_retrieval_runs(qa_log_id)
  where qa_log_id is not null;

create index if not exists rag_retrieval_runs_trend_brief_key_idx
  on public.rag_retrieval_runs(trend_brief_key, created_at desc)
  where trend_brief_key is not null;

create index if not exists rag_retrieval_candidates_run_rank_idx
  on public.rag_retrieval_candidates(retrieval_run_id, rank);

create index if not exists rag_retrieval_candidates_article_idx
  on public.rag_retrieval_candidates(article_id)
  where article_id is not null;

create index if not exists rag_retrieval_candidates_injected_idx
  on public.rag_retrieval_candidates(retrieval_run_id, injected)
  where injected = true;

create index if not exists rag_injected_contexts_run_ordinal_idx
  on public.rag_injected_contexts(retrieval_run_id, ordinal);

create index if not exists qa_logs_rag_retrieval_run_id_idx
  on public.qa_logs(rag_retrieval_run_id)
  where rag_retrieval_run_id is not null;

alter table public.rag_retrieval_runs enable row level security;
alter table public.rag_retrieval_candidates enable row level security;
alter table public.rag_injected_contexts enable row level security;

-- No anon/authenticated policies by design. Trace rows may contain internal
-- prompt context and are for service-role/admin analysis only.
revoke all on public.rag_retrieval_runs from anon, authenticated;
revoke all on public.rag_retrieval_candidates from anon, authenticated;
revoke all on public.rag_injected_contexts from anon, authenticated;

grant all on public.rag_retrieval_runs to service_role;
grant all on public.rag_retrieval_candidates to service_role;
grant all on public.rag_injected_contexts to service_role;
