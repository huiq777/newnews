-- 20260608 — Eval-only query rewrite diagnostics.
--
-- Rewrites remain offline replay only. Production answer-question is unchanged.
-- Supported modes: none, entity_expansion, hyde, decomposition, context_completion.

-- Latest rewrite traces, including accepted/rejected drift decisions.
with rewrite_traces as (
  select
    rr.id as retrieval_run_id,
    rr.retrieval_strategy,
    rr.created_at,
    rr.query_input->'rewrite_trace'->>'original_query' as original_query,
    rr.query_input->'rewrite_trace'->>'rewritten_query' as rewritten_query,
    rr.query_input->'rewrite_trace'->>'rewrite_mode' as rewrite_mode,
    (rr.query_input->'rewrite_trace'->>'accepted')::boolean as accepted,
    rr.query_input->'rewrite_trace'->>'reject_reason' as reject_reason,
    (rr.query_input->'rewrite_trace'->>'original_vs_rewrite_similarity')::double precision as original_vs_rewrite_similarity,
    (rr.query_input->'rewrite_trace'->>'drift_threshold')::double precision as drift_threshold,
    rr.query_input->'rewrite_trace'->'top_candidate_divergence' as top_candidate_divergence
  from public.rag_retrieval_runs rr
  where rr.query_input ? 'rewrite_trace'
)
select *
from rewrite_traces
order by created_at desc;

-- Rejected rewrites and top candidate divergence.
with rejected_rewrites as (
  select
    rr.id as retrieval_run_id,
    rr.retrieval_strategy,
    rr.query_input->'rewrite_trace'->>'original_query' as original_query,
    rr.query_input->'rewrite_trace'->>'rewritten_query' as rewritten_query,
    rr.query_input->'rewrite_trace'->>'rewrite_mode' as rewrite_mode,
    rr.query_input->'rewrite_trace'->>'reject_reason' as reject_reason,
    rr.query_input->'rewrite_trace'->'top_candidate_divergence' as top_candidate_divergence,
    array_agg(rc.article_id order by rc.rank) filter (where rc.rank <= 10) as top10_candidate_article_ids
  from public.rag_retrieval_runs rr
  left join public.rag_retrieval_candidates rc on rc.retrieval_run_id = rr.id
  where rr.query_input ? 'rewrite_trace'
    and coalesce((rr.query_input->'rewrite_trace'->>'accepted')::boolean, false) = false
  group by rr.id
)
select *
from rejected_rewrites
order by retrieval_run_id desc;

-- Slice labels expected from replay:
-- chunk_dense_rewrite_none
-- chunk_dense_rewrite_entity_expansion
-- chunk_dense_rewrite_hyde
-- chunk_dense_rewrite_decomposition
-- chunk_dense_rewrite_context_completion
-- agentic_decomposition_eval
