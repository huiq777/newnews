-- 20260426 — qa_logs: production data flywheel for the RAG Q&A path.
-- See docs/superpowers/specs/2026-04-26-qa-logs-and-feedback-design.md.
--
-- Each row captures one answer-question invocation: question text, retrieval
-- truth-set (the article IDs actually injected into the prompt post Spec-A
-- cap), response text, model, prompt/completion/total tokens, TTFT, total
-- latency, abort flag, error message, and (later, async) the user's 👍/👎.
--
-- Two layered defenses apply to client-side writes:
--   1. RLS — restricts which ROWS each user can act on (own rows only).
--   2. Column-level GRANTs — restricts which COLUMNS clients can UPDATE
--      (feedback + feedback_at only). Without (2), a client could PATCH
--      their own row to overwrite operational telemetry (response_text,
--      ttft_ms, model_used, etc.) and corrupt every downstream metric.
--
-- Apply via Supabase SQL Editor. Idempotent — safe to re-run.
-- Depends on docs/superpowers/specs/2026-04-26-beta-auth-gate-design.md
-- (the is_beta_user() helper from beta_invites is referenced in RLS).

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.qa_logs (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,

  -- Request
  article_id               uuid references public.daily_news(id) on delete set null,
  question                 text not null,
  lang                     text not null check (lang in ('en','zh')),
  asked_at                 timestamptz not null default now(),

  -- Retrieval — the truth-set actually injected into the prompt (post Spec-A cap, post filter)
  related_article_ids      uuid[] not null default '{}',
  context_main_chars       int,
  context_related_chars    int,
  context_total_chars      int,

  -- Response
  response_text            text,            -- streamed answer; null if aborted before any byte
  model_used               text,            -- 'qwen/qwen3.6-plus' | OPENROUTER_MODEL | 'llama-3.3-70b-versatile'
  prompt_tokens            int,
  completion_tokens        int,
  total_tokens             int,

  -- Timing (server-measured)
  ttft_ms                  int,             -- request start → first SSE byte
  total_ms                 int,             -- request start → stream close
  aborted                  boolean not null default false,

  -- Failure
  error_message            text,            -- LLM-tier failure; non-null implies response_text is null

  -- Feedback (patched by client after the answer renders)
  feedback                 smallint check (feedback in (-1, 0, 1)),
  feedback_at              timestamptz,

  created_at               timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists qa_logs_user_id_idx     on public.qa_logs(user_id);
create index if not exists qa_logs_asked_at_idx    on public.qa_logs(asked_at desc);
create index if not exists qa_logs_feedback_idx    on public.qa_logs(feedback) where feedback is not null;
create index if not exists qa_logs_article_id_idx  on public.qa_logs(article_id) where article_id is not null;

-- ── RLS (row-level scope) ────────────────────────────────────────────────────
alter table public.qa_logs enable row level security;

drop policy if exists "users_read_own_logs"      on public.qa_logs;
drop policy if exists "users_insert_own_logs"    on public.qa_logs;
drop policy if exists "users_update_own_feedback" on public.qa_logs;

create policy "users_read_own_logs" on public.qa_logs
  for select to authenticated
  using (user_id = auth.uid());

-- The Edge Function uses the service role and bypasses RLS for INSERT.
-- This policy governs any future direct-from-client insert path.
create policy "users_insert_own_logs" on public.qa_logs
  for insert to authenticated
  with check (user_id = auth.uid());

-- Row-scope: each user can update only their own row.
-- Column-scope is enforced separately via GRANT below — without that block,
-- a malicious client could PATCH their own row's response_text or model_used
-- and corrupt operational telemetry. RLS does not restrict columns.
create policy "users_update_own_feedback" on public.qa_logs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── Column-level GRANTs (telemetry integrity — load-bearing) ─────────────────
-- The default GRANT ALL on `authenticated` would let a client UPDATE any
-- column on their own row. We revoke the blanket UPDATE and re-grant ONLY
-- on (feedback, feedback_at). Service role retains full access via RLS bypass.
-- The `anon` role gets nothing — un-redeemed users cannot read or write.
revoke update on public.qa_logs from authenticated;
grant  update (feedback, feedback_at) on public.qa_logs to authenticated;
revoke all    on public.qa_logs from anon;

-- Verification:
--   -- As a beta user (user JWT) — own rows visible:
--   select count(*) from qa_logs;
--   -- As anon (anon key, no user JWT) — must return 0 rows:
--   curl "$URL/rest/v1/qa_logs?select=*" -H "apikey: $ANON_KEY"
--   -- As beta user, attempt operational column write — must FAIL with permission error:
--   update qa_logs set response_text = 'tampered' where id = '<own-row>';
--   -- As beta user, feedback write — must SUCCEED:
--   update qa_logs set feedback = 1, feedback_at = now() where id = '<own-row>';
