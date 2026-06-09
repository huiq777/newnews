-- 20260608 — RAG generation evaluation results.
--
-- Retrieval metrics and generation quality metrics are intentionally separate.
-- This table stores generated answers, exact context packs, judge scores, and
-- human overrides for eval-only answer quality analysis.

create extension if not exists pgcrypto;

create table if not exists public.rag_generation_eval_results (
  id                         uuid primary key default gen_random_uuid(),
  eval_run_id                uuid not null references public.rag_eval_runs(id) on delete cascade,
  case_id                    uuid not null references public.rag_eval_cases(id) on delete cascade,
  retrieval_run_id           uuid references public.rag_retrieval_runs(id) on delete set null,
  generation_eval_mode       text not null check (generation_eval_mode in ('inline_article_generation_eval', 'corpus_retrieval_generation_eval')),
  context_pack_version       text not null,
  context_hash               text not null,
  context_chars              integer not null,
  context_text               text not null,
  answer_text                text,
  answer_model               text,
  answer_prompt_version      text,
  judge_model                text,
  judge_prompt_version       text,
  faithfulness_score         double precision,
  answer_relevancy_score     double precision,
  context_precision_score    double precision,
  context_recall_score       double precision,
  human_override_score       double precision,
  human_override_notes       text,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),

  unique (eval_run_id, case_id, generation_eval_mode, context_pack_version)
);

create index if not exists rag_generation_eval_results_run_idx
  on public.rag_generation_eval_results(eval_run_id);

create index if not exists rag_generation_eval_results_case_idx
  on public.rag_generation_eval_results(case_id);

alter table public.rag_generation_eval_results enable row level security;

revoke all on public.rag_generation_eval_results from anon, authenticated;
grant all on public.rag_generation_eval_results to service_role;

-- Read-only diagnostic: report generation modes separately.
select
  generation_eval_mode,
  answer_model,
  judge_model,
  count(*) as rows,
  avg(faithfulness_score) as avg_faithfulness_score,
  avg(answer_relevancy_score) as avg_answer_relevancy_score,
  avg(context_precision_score) as avg_context_precision_score,
  avg(context_recall_score) as avg_context_recall_score
from public.rag_generation_eval_results
group by generation_eval_mode, answer_model, judge_model
order by generation_eval_mode, answer_model, judge_model;
