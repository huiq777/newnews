-- 20260602 — RAG retrieval refinement diagnostics.
-- Read-only queries. Run after at least one eval replay.

-- 1. Latest replay summary.
select
  s.name,
  r.id as eval_run_id,
  m.total_cases,
  round(m.avg_recall_at_3::numeric, 3) as avg_recall_at_3,
  round(m.avg_recall_at_5::numeric, 3) as avg_recall_at_5,
  round(m.avg_recall_at_10::numeric, 3) as avg_recall_at_10,
  round(m.avg_mrr::numeric, 3) as avg_mrr,
  round(m.avg_ndcg_at_10::numeric, 3) as avg_ndcg_at_10,
  round(m.avg_hit_rate_at_5::numeric, 3) as avg_hit_rate_at_5,
  m.latency_p50_ms,
  m.latency_p95_ms,
  r.retrieval_strategy,
  r.created_at
from public.rag_eval_retrieval_metrics m
join public.rag_eval_runs r on r.id = m.eval_run_id
join public.rag_eval_sets s on s.id = r.eval_set_id
order by r.created_at desc
limit 10;

-- 2. For the latest run, show whether the primary article appeared in top 10.
with latest_run as (
  select id
  from public.rag_eval_runs
  order by created_at desc
  limit 1
)
select
  c.question,
  c.primary_article_id,
  min(rc.rank) filter (where rc.article_id = c.primary_article_id) as primary_rank,
  cr.recall_at_10,
  cr.mrr,
  cr.ndcg_at_10,
  cr.hit_at_5,
  rr.latency_ms
from latest_run lr
join public.rag_eval_case_results cr on cr.eval_run_id = lr.id
join public.rag_eval_cases c on c.id = cr.case_id
join public.rag_retrieval_runs rr on rr.id = cr.retrieval_run_id
left join public.rag_retrieval_candidates rc on rc.retrieval_run_id = rr.id
group by c.id, c.question, c.primary_article_id, cr.recall_at_10, cr.mrr, cr.ndcg_at_10, cr.hit_at_5, rr.latency_ms
order by primary_rank nulls first, cr.recall_at_10 asc, cr.mrr asc;

-- 3. Latest run candidate audit with gold labels.
with latest_run as (
  select id
  from public.rag_eval_runs
  order by created_at desc
  limit 1
)
select
  c.question,
  c.primary_article_id,
  rc.rank,
  rc.article_id,
  rc.title,
  rc.score_dense,
  rc.score_lexical,
  rc.score_final,
  rc.embedding_source,
  rc.metadata,
  rc.article_id = c.primary_article_id as is_primary_article,
  ge.relevance_grade,
  ge.review_status
from latest_run lr
join public.rag_eval_case_results cr on cr.eval_run_id = lr.id
join public.rag_eval_cases c on c.id = cr.case_id
join public.rag_retrieval_candidates rc on rc.retrieval_run_id = cr.retrieval_run_id
left join public.rag_eval_gold_evidence ge on ge.case_id = c.id and ge.article_id = rc.article_id
order by c.created_at asc, rc.rank asc;

-- 4. Cases with no approved related evidence except the primary baseline.
select
  c.id as case_id,
  c.question,
  c.primary_article_id,
  count(*) filter (
    where g.review_status = 'approved'
      and g.relevance_grade >= 2
      and coalesce(g.metadata->>'source', '') <> 'primary_article_baseline'
  ) as approved_related_targets,
  count(*) filter (
    where g.review_status = 'approved'
      and g.relevance_grade >= 2
      and g.metadata->>'source' = 'primary_article_baseline'
  ) as approved_primary_targets
from public.rag_eval_cases c
left join public.rag_eval_gold_evidence g on g.case_id = c.id
group by c.id, c.question, c.primary_article_id
order by approved_related_targets asc, approved_primary_targets desc, c.created_at asc;

-- 5. Candidate title/source noise by latest run.
with latest_run as (
  select id
  from public.rag_eval_runs
  order by created_at desc
  limit 1
)
select
  rc.rank,
  rc.title,
  count(*) as appearances,
  avg(rc.score_dense) as avg_dense,
  avg(rc.score_lexical) as avg_lexical,
  avg(rc.score_final) as avg_final
from latest_run lr
join public.rag_eval_case_results cr on cr.eval_run_id = lr.id
join public.rag_retrieval_candidates rc on rc.retrieval_run_id = cr.retrieval_run_id
group by rc.rank, rc.title
order by appearances desc, avg_final desc nulls last, avg_dense desc nulls last
limit 50;

-- 6. Approved-gold readiness preflight for official retrieval comparisons.
select
  s.name as eval_set,
  count(*) as total_cases,
  count(*) filter (where approved_relevant_gold > 0) as cases_with_approved_relevant_gold,
  count(*) filter (where approved_relevant_gold = 0 and pending_relevant_gold > 0) as cases_with_only_pending_relevant_gold,
  count(*) filter (where approved_relevant_gold = 0 and pending_relevant_gold = 0) as cases_without_relevant_gold
from public.rag_eval_sets s
join (
  select
    c.eval_set_id,
    c.id as case_id,
    count(*) filter (where g.review_status = 'approved' and g.relevance_grade >= 2) as approved_relevant_gold,
    count(*) filter (where g.review_status = 'pending' and g.relevance_grade >= 2) as pending_relevant_gold
  from public.rag_eval_cases c
  left join public.rag_eval_gold_evidence g on g.case_id = c.id
  group by c.eval_set_id, c.id
) case_gold on case_gold.eval_set_id = s.id
group by s.name
order by s.name;

-- 7. Compare latest dense, lexical, and hybrid runs.
with ranked_runs as (
  select
    r.*,
    row_number() over (
      partition by r.retrieval_strategy
      order by r.created_at desc
    ) as rn
  from public.rag_eval_runs r
)
select
  s.name,
  r.retrieval_strategy,
  r.retrieval_version,
  m.total_cases,
  round(m.avg_recall_at_3::numeric, 3) as avg_recall_at_3,
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
order by s.name, r.retrieval_strategy;
