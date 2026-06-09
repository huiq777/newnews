-- 20260603 — RAG metrics refinement diagnostics.
-- Read-only; use after dense/lexical/hybrid/chunk/entity replays.

-- 1. Latest strategy leaderboard with gate status.
with ranked_runs as (
  select
    r.*,
    row_number() over (
      partition by r.retrieval_strategy
      order by r.created_at desc
    ) as rn
  from public.rag_eval_runs r
),
latest as (
  select
    s.name,
    r.retrieval_strategy,
    r.retrieval_version,
    r.notes,
    m.total_cases,
    round(m.avg_recall_at_5::numeric, 3) as avg_recall_at_5,
    round(m.avg_recall_at_10::numeric, 3) as avg_recall_at_10,
    round(m.avg_mrr::numeric, 3) as avg_mrr,
    round(m.avg_ndcg_at_10::numeric, 3) as avg_ndcg_at_10,
    round(m.avg_hit_rate_at_5::numeric, 3) as avg_hit_rate_at_5,
    m.latency_p50_ms,
    m.latency_p95_ms,
    r.created_at
  from ranked_runs r
  join public.rag_eval_retrieval_metrics m on m.eval_run_id = r.id
  join public.rag_eval_sets s on s.id = r.eval_set_id
  where r.rn = 1
)
select
  *,
  case
    when avg_recall_at_5 >= 0.55
     and avg_recall_at_10 >= 0.70
     and avg_mrr >= 0.35
     and avg_ndcg_at_10 >= 0.55
     and avg_hit_rate_at_5 >= 0.55
     and latency_p50_ms <= 2500
     and latency_p95_ms <= 8000
    then 'passes_minimum_gate'
    else 'below_gate'
  end as strategy_gate_status
from latest
order by strategy_gate_status desc, avg_recall_at_10 desc, avg_mrr desc;

-- 2. Per-case best strategy movement.
with latest_runs as (
  select distinct on (retrieval_strategy)
    id,
    retrieval_strategy,
    created_at
  from public.rag_eval_runs
  order by retrieval_strategy, created_at desc
)
select
  c.question,
  lr.retrieval_strategy,
  cr.recall_at_5,
  cr.recall_at_10,
  cr.mrr,
  cr.ndcg_at_10,
  cr.hit_at_5
from latest_runs lr
join public.rag_eval_case_results cr on cr.eval_run_id = lr.id
join public.rag_eval_cases c on c.id = cr.case_id
order by c.created_at asc, cr.recall_at_10 desc, cr.mrr desc;

-- 3. Chunk-derived candidates that are gold evidence.
select
  r.retrieval_strategy,
  c.question,
  rc.rank,
  rc.candidate_type,
  rc.article_id,
  rc.chunk_id,
  rc.title,
  ge.relevance_grade,
  ge.review_status,
  rc.score_dense,
  rc.score_final,
  rc.metadata
from public.rag_eval_runs r
join public.rag_eval_case_results cr on cr.eval_run_id = r.id
join public.rag_eval_cases c on c.id = cr.case_id
join public.rag_retrieval_candidates rc on rc.retrieval_run_id = cr.retrieval_run_id
left join public.rag_eval_gold_evidence ge on ge.case_id = c.id and ge.article_id = rc.article_id
where r.retrieval_strategy like 'chunk_%'
order by r.created_at desc, c.created_at asc, rc.rank asc
limit 100;

-- 4. Latest chunk_dense miss audit.
-- Candidate and gold arrays are aggregated separately to avoid row multiplication
-- when a case has multiple gold evidence rows and multiple retrieved chunks.
with latest_run as (
  select id
  from public.rag_eval_runs
  where retrieval_strategy = 'chunk_dense_dense_query_embedding_article_similarity'
  order by created_at desc
  limit 1
),
candidate_articles as (
  select
    cr.case_id,
    rc.article_id as candidate_article_id,
    min(rc.rank) as rank,
    max(rc.title) as title,
    max(rc.score_final) as score_final
  from latest_run lr
  join public.rag_eval_case_results cr on cr.eval_run_id = lr.id
  join public.rag_retrieval_candidates rc on rc.retrieval_run_id = cr.retrieval_run_id
  where rc.article_id is not null
  group by cr.case_id, rc.article_id
),
candidate_top10 as (
  select
    case_id,
    array_agg(candidate_article_id order by rank) filter (where rank <= 10) as retrieved_top10,
    jsonb_agg(
      jsonb_build_object(
        'rank', rank,
        'article_id', candidate_article_id,
        'title', title,
        'score_final', score_final
      )
      order by rank
    ) filter (where rank <= 10) as retrieved_top10_detail
  from candidate_articles
  group by case_id
),
gold_targets as (
  select
    g.case_id,
    array_agg(g.article_id order by g.relevance_grade desc, g.created_at asc) as approved_gold,
    jsonb_agg(
      jsonb_build_object(
        'article_id', g.article_id,
        'title', dn.title,
        'relevance_grade', g.relevance_grade,
        'review_status', g.review_status
      )
      order by g.relevance_grade desc, g.created_at asc
    ) as approved_gold_detail
  from public.rag_eval_gold_evidence g
  join public.daily_news dn on dn.id = g.article_id
  where g.review_status = 'approved'
    and g.relevance_grade >= 2
  group by g.case_id
),
gold_rank_summary as (
  select
    gt.case_id,
    min(ca.rank) as best_gold_rank,
    array_agg(gold_article_id order by gold_article_id) filter (
      where ca.candidate_article_id is null
    ) as missing_approved_gold
  from gold_targets gt
  cross join lateral unnest(gt.approved_gold) as gold_article_id
  left join candidate_articles ca
    on ca.case_id = gt.case_id
   and ca.candidate_article_id = gold_article_id
  group by gt.case_id
),
gold_chunk_coverage as (
  select
    gt.case_id,
    jsonb_agg(
      jsonb_build_object(
        'article_id', gold_article_id,
        'chunks', coalesce(chunk_counts.chunks, 0),
        'embedded_chunks', coalesce(chunk_counts.embedded_chunks, 0)
      )
      order by gold_article_id
    ) as gold_chunk_coverage
  from gold_targets gt
  cross join lateral unnest(gt.approved_gold) as gold_article_id
  left join lateral (
    select
      count(*) as chunks,
      count(*) filter (where ace.embedding is not null) as embedded_chunks
    from public.article_chunks ace
    where ace.article_id = gold_article_id
  ) chunk_counts on true
  group by gt.case_id
)
select
  c.id as case_id,
  c.question,
  c.primary_article_id,
  cr.recall_at_5,
  cr.recall_at_10,
  cr.mrr,
  cr.ndcg_at_10,
  coalesce(ct.retrieved_top10, '{}'::uuid[]) as retrieved_top10,
  coalesce(gt.approved_gold, '{}'::uuid[]) as approved_gold,
  grs.best_gold_rank,
  coalesce(grs.missing_approved_gold, '{}'::uuid[]) as missing_approved_gold,
  ct.retrieved_top10_detail,
  gt.approved_gold_detail,
  gcc.gold_chunk_coverage
from latest_run lr
join public.rag_eval_case_results cr on cr.eval_run_id = lr.id
join public.rag_eval_cases c on c.id = cr.case_id
left join candidate_top10 ct on ct.case_id = c.id
left join gold_targets gt on gt.case_id = c.id
left join gold_rank_summary grs on grs.case_id = c.id
left join gold_chunk_coverage gcc on gcc.case_id = c.id
where cr.recall_at_10 < 1
order by cr.recall_at_10 asc, grs.best_gold_rank nulls first, cr.mrr asc;
