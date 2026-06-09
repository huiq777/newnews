-- 20260608 — Agentic RAG eval trace table.
--
-- Eval-only trace of planner, retrieval, critique, retry, stop reason, and
-- latency fields. Production answer-question is unchanged.

create extension if not exists pgcrypto;

create table if not exists public.agentic_rag_eval_traces (
  id                    uuid primary key default gen_random_uuid(),
  eval_case_id           uuid references public.rag_eval_cases(id) on delete cascade,
  plan_id                text not null,
  intent                 text not null,
  subquery               jsonb not null default '{}'::jsonb,
  retrieval_round        integer not null check (retrieval_round between 1 and 2),
  strategy               text not null,
  candidate_count        integer not null default 0,
  critique_sufficient    boolean not null default false,
  critique_answerable    boolean not null default false,
  retry_reason           text,
  stop_reason            text not null,
  latency_ms             integer not null default 0,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);

create index if not exists agentic_rag_eval_traces_case_idx
  on public.agentic_rag_eval_traces(eval_case_id, created_at desc);

create index if not exists agentic_rag_eval_traces_plan_idx
  on public.agentic_rag_eval_traces(plan_id, retrieval_round);

alter table public.agentic_rag_eval_traces enable row level security;

revoke all on public.agentic_rag_eval_traces from anon, authenticated;
grant all on public.agentic_rag_eval_traces to service_role;

-- Read-only loop-safety and slice diagnostic. Slices with n < 5 are directional
-- only and must not use pass/fail language.
select
  intent,
  count(distinct eval_case_id) as slice_n,
  max(retrieval_round) as max_retrieval_round,
  count(*) filter (where retrieval_round > 2) as loop_safety_violations,
  avg(latency_ms) as avg_latency_ms
from public.agentic_rag_eval_traces
group by intent
order by intent;
