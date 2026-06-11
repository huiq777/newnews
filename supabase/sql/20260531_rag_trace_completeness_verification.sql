-- 20260531 — RAG Trace Completeness verification queries.
-- Read-only checks to run in Supabase SQL Editor after deploying the migration
-- and Edge Function instrumentation.

-- 1. Latest Q&A trace linked back to qa_logs.
select
  q.id as qa_log_id,
  q.request_id,
  q.article_id,
  q.question,
  q.related_article_ids,
  q.rag_retrieval_run_id,
  r.surface,
  r.query_text,
  r.query_embedding_model,
  r.embedding_input_type,
  r.retrieval_strategy,
  r.retrieval_version,
  r.retriever_name,
  r.match_count,
  r.candidate_count,
  r.injected_count,
  r.context_total_chars,
  r.latency_ms,
  q.model_used,
  q.total_tokens,
  q.ttft_ms,
  q.total_ms,
  q.feedback
from public.qa_logs q
join public.rag_retrieval_runs r
  on r.id = q.rag_retrieval_run_id
where r.surface = 'answer_question_related_articles'
order by q.asked_at desc
limit 5;

-- 2. Candidate ranks, scores, injected flags, and drop reasons for one Q&A.
select
  r.request_id,
  c.rank,
  c.candidate_type,
  c.article_id,
  c.title,
  c.score_dense,
  c.score_final,
  c.embedding_source,
  c.injected,
  c.drop_reason
from public.rag_retrieval_runs r
join public.rag_retrieval_candidates c
  on c.retrieval_run_id = r.id
where r.surface = 'answer_question_related_articles'
order by r.created_at desc, c.rank asc
limit 20;

-- 3. Injected context snapshots for the latest traced Q&A.
select
  r.request_id,
  ctx.ordinal,
  ctx.context_role,
  ctx.article_id,
  ctx.context_chars,
  ctx.context_hash,
  left(ctx.context_text, 500) as context_preview
from public.rag_retrieval_runs r
join public.rag_injected_contexts ctx
  on ctx.retrieval_run_id = r.id
where r.surface = 'answer_question_related_articles'
order by r.created_at desc, ctx.ordinal asc
limit 10;

-- 4. Latest trend brief historical enrichment trace.
select
  r.id as retrieval_run_id,
  r.trend_brief_key,
  r.trend_brief_anchor_date,
  r.trend_brief_step_days,
  r.trend_brief_category,
  r.query_input,
  r.retrieval_strategy,
  r.retrieval_version,
  r.retriever_name,
  r.match_count,
  r.candidate_count,
  r.injected_count,
  r.context_total_chars,
  r.latency_ms
from public.rag_retrieval_runs r
where r.surface = 'trend_brief_historical_enrichment'
order by r.created_at desc
limit 5;

-- 5. Trend brief candidate audit: selected historical ids versus dropped ids.
select
  r.trend_brief_key,
  c.rank,
  c.article_id,
  c.title,
  c.score_dense,
  c.score_final,
  c.injected,
  c.drop_reason
from public.rag_retrieval_runs r
join public.rag_retrieval_candidates c
  on c.retrieval_run_id = r.id
where r.surface = 'trend_brief_historical_enrichment'
order by r.created_at desc, c.rank asc
limit 30;

-- 6. Trace integrity summary by surface.
select
  r.surface,
  count(*) as runs,
  count(*) filter (where r.qa_log_id is not null) as linked_qa_logs,
  count(*) filter (where r.trend_brief_key is not null) as linked_trend_briefs,
  sum(r.candidate_count) as candidates_recorded,
  sum(r.injected_count) as injected_contexts_recorded,
  round(avg(r.latency_ms)) as avg_retrieval_latency_ms
from public.rag_retrieval_runs r
where r.created_at > now() - interval '7 days'
group by r.surface
order by runs desc;
