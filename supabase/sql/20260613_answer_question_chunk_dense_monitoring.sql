-- 20260613 - answer-question chunk dense production monitoring.

with recent_runs as (
  select
    rr.id,
    rr.created_at,
    rr.request_id,
    rr.retrieval_strategy,
    rr.retriever_name,
    rr.latency_ms,
    rr.candidate_count,
    rr.injected_count,
    rr.query_input,
    q.id as qa_log_id,
    q.error_message,
    q.feedback
  from public.rag_retrieval_runs rr
  left join public.qa_logs q on q.rag_retrieval_run_id = rr.id
  where rr.surface = 'answer_question_related_articles'
    and rr.created_at >= now() - interval '24 hours'
),
by_strategy as (
  select
    retrieval_strategy,
    retriever_name,
    count(*) as requests,
    percentile_cont(0.5) within group (order by latency_ms) as p50_latency_ms,
    percentile_cont(0.95) within group (order by latency_ms) as p95_latency_ms,
    avg(case when injected_count = 0 then 1 else 0 end) as empty_candidate_rate,
    avg(case when error_message is not null then 1 else 0 end) as qa_error_rate,
    avg(case when feedback < 0 then 1 else 0 end) filter (where feedback is not null) as negative_feedback_rate,
    avg(case when query_input->>'fallback_reason' = 'chunk_dense_failed_fell_back_to_article_dense' then 1 else 0 end) as fallback_rate
  from recent_runs
  group by retrieval_strategy, retriever_name
)
select
  retrieval_strategy,
  retriever_name,
  requests,
  round(p50_latency_ms::numeric, 0) as p50_latency_ms,
  round(p95_latency_ms::numeric, 0) as p95_latency_ms,
  round(empty_candidate_rate::numeric, 4) as empty_candidate_rate,
  round(qa_error_rate::numeric, 4) as qa_error_rate,
  round(coalesce(negative_feedback_rate, 0)::numeric, 4) as negative_feedback_rate,
  round(fallback_rate::numeric, 4) as fallback_rate,
  case
    when retrieval_strategy = 'chunk_dense_bge_m3'
      and requests >= 20
      and p50_latency_ms <= 2500
      and p95_latency_ms <= 8000
      and fallback_rate <= 0.05
      and qa_error_rate <= 0.02
      and empty_candidate_rate <= 0.02
      then 'canary_gate_pass'
    when retrieval_strategy = 'chunk_dense_bge_m3'
      then 'canary_gate_watch'
    when retrieval_strategy = 'dense_article_similarity_prefer_deep_analysis'
      then 'rollback_or_fallback_path'
    else 'unknown_strategy'
  end as production_gate_status
from by_strategy
order by retrieval_strategy, retriever_name;
