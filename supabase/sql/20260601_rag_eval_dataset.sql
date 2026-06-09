-- 20260601 — RAG Golden Dataset v1 & Replay Runner.
--
-- Evaluation-only schema. This migration does not change production retrieval,
-- prompt construction, model routing, cron schedules, or frontend behavior.
-- CLI scripts write these tables with the service role.

create extension if not exists pgcrypto;

create table if not exists public.rag_eval_sets (
  id           uuid primary key default gen_random_uuid(),
  name         text unique not null,
  description  text,
  created_at   timestamptz not null default now()
);

create table if not exists public.rag_eval_cases (
  id                  uuid primary key default gen_random_uuid(),
  eval_set_id         uuid not null references public.rag_eval_sets(id) on delete cascade,
  surface             text not null,

  question            text not null,
  lang                text not null default 'zh' check (lang in ('zh', 'en')),

  case_type           text not null check (case_type in ('factual', 'synthesis', 'comparison', 'temporal', 'adversarial')),
  cohort              text not null default 'mid' check (cohort in ('mid', 'long', 'adversarial')),

  primary_article_id  uuid references public.daily_news(id) on delete set null,
  source_trace_id     uuid references public.rag_retrieval_runs(id) on delete set null,
  case_source         text not null check (case_source in ('eval_json', 'production_badcase', 'manual')),

  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),

  unique (eval_set_id, primary_article_id, question)
);

create table if not exists public.rag_eval_gold_evidence (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null references public.rag_eval_cases(id) on delete cascade,
  article_id          uuid not null references public.daily_news(id) on delete cascade,

  relevance_grade     integer not null check (relevance_grade between 0 and 3),
  review_status       text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  reviewed_by         text,
  reviewed_at         timestamptz,
  evidence_note       text,

  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),

  unique (case_id, article_id)
);

create table if not exists public.rag_eval_runs (
  id                  uuid primary key default gen_random_uuid(),
  eval_set_id         uuid not null references public.rag_eval_sets(id) on delete cascade,
  runner_version      text not null,
  retrieval_strategy  text not null,
  retrieval_version   text not null,
  notes               text,
  created_at          timestamptz not null default now()
);

create table if not exists public.rag_eval_case_results (
  id                  uuid primary key default gen_random_uuid(),
  eval_run_id         uuid not null references public.rag_eval_runs(id) on delete cascade,
  case_id             uuid not null references public.rag_eval_cases(id) on delete cascade,
  retrieval_run_id    uuid not null references public.rag_retrieval_runs(id) on delete cascade,

  recall_at_3         double precision not null,
  recall_at_5         double precision not null,
  recall_at_10        double precision not null,
  mrr                 double precision not null,
  ndcg_at_10          double precision not null,
  hit_at_5            boolean not null,

  created_at          timestamptz not null default now(),

  unique (eval_run_id, case_id)
);

create table if not exists public.rag_eval_retrieval_metrics (
  id                  uuid primary key default gen_random_uuid(),
  eval_run_id         uuid not null references public.rag_eval_runs(id) on delete cascade,

  avg_recall_at_3     double precision not null,
  avg_recall_at_5     double precision not null,
  avg_recall_at_10    double precision not null,
  avg_mrr             double precision not null,
  avg_ndcg_at_10      double precision not null,
  avg_hit_rate_at_5   double precision not null,

  total_cases         integer not null,
  approved_gold_count integer not null,
  latency_p50_ms      integer not null,
  latency_p95_ms      integer not null,

  created_at          timestamptz not null default now()
);

create index if not exists rag_eval_cases_set_idx
  on public.rag_eval_cases(eval_set_id);

create index if not exists rag_eval_cases_primary_article_idx
  on public.rag_eval_cases(primary_article_id)
  where primary_article_id is not null;

create index if not exists rag_eval_gold_evidence_case_idx
  on public.rag_eval_gold_evidence(case_id);

create index if not exists rag_eval_gold_evidence_status_idx
  on public.rag_eval_gold_evidence(review_status);

create index if not exists rag_eval_gold_evidence_article_idx
  on public.rag_eval_gold_evidence(article_id);

create index if not exists rag_eval_runs_set_created_idx
  on public.rag_eval_runs(eval_set_id, created_at desc);

create index if not exists rag_eval_case_results_run_idx
  on public.rag_eval_case_results(eval_run_id);

create index if not exists rag_eval_retrieval_metrics_run_idx
  on public.rag_eval_retrieval_metrics(eval_run_id);

alter table public.rag_eval_sets enable row level security;
alter table public.rag_eval_cases enable row level security;
alter table public.rag_eval_gold_evidence enable row level security;
alter table public.rag_eval_runs enable row level security;
alter table public.rag_eval_case_results enable row level security;
alter table public.rag_eval_retrieval_metrics enable row level security;

revoke all on public.rag_eval_sets from anon, authenticated;
revoke all on public.rag_eval_cases from anon, authenticated;
revoke all on public.rag_eval_gold_evidence from anon, authenticated;
revoke all on public.rag_eval_runs from anon, authenticated;
revoke all on public.rag_eval_case_results from anon, authenticated;
revoke all on public.rag_eval_retrieval_metrics from anon, authenticated;

grant all on public.rag_eval_sets to service_role;
grant all on public.rag_eval_cases to service_role;
grant all on public.rag_eval_gold_evidence to service_role;
grant all on public.rag_eval_runs to service_role;
grant all on public.rag_eval_case_results to service_role;
grant all on public.rag_eval_retrieval_metrics to service_role;
