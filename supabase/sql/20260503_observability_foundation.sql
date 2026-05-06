-- 20260503 — Observability Foundation
-- Adds pipeline_events trace table, run_id to raw_ingestion + daily_news,
-- request_id to qa_logs. All columns nullable/additive — zero downtime.

-- ── pipeline_events ────────────────────────────────────────────────────────
-- Append-only event log for article pipeline steps.
-- No RLS — service-role only. ~288 events/day → ~105K rows/year.
CREATE TABLE IF NOT EXISTS public.pipeline_events (
  id          BIGSERIAL    PRIMARY KEY,
  run_id      UUID         NOT NULL,
  step        TEXT         NOT NULL,  -- 'claim'|'keyword_gate'|'llm'|'insert'|'embed'|'llm_category_mismatch'
  status      TEXT         NOT NULL,  -- 'ok'|'skip'|'error'
  source_id   UUID,
  raw_id      UUID,
  daily_id    UUID,
  duration_ms INT,
  error_text  TEXT,
  created_at  TIMESTAMPTZ  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_events_run_id_idx     ON public.pipeline_events (run_id);
CREATE INDEX IF NOT EXISTS pipeline_events_raw_id_idx     ON public.pipeline_events (raw_id);
CREATE INDEX IF NOT EXISTS pipeline_events_created_at_idx ON public.pipeline_events (created_at DESC);

-- ── run_id columns ──────────────────────────────────────────────────────────
-- Stamped by process-queue at claim time. Allows "show all articles from
-- the run that produced this bad output" → single-column filter.
ALTER TABLE public.raw_ingestion ADD COLUMN IF NOT EXISTS run_id UUID;
ALTER TABLE public.daily_news    ADD COLUMN IF NOT EXISTS run_id UUID;

-- ── request_id on qa_logs ───────────────────────────────────────────────────
-- Generated at answer-question entry. Every log line for that request
-- emits this ID for full trace: route→retrieval→LLM→persistence.
ALTER TABLE public.qa_logs ADD COLUMN IF NOT EXISTS request_id UUID;
