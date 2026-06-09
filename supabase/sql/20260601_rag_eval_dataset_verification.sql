-- 20260601 — RAG Golden Dataset v1 verification and HITL review queries.
-- Run after applying 20260601_rag_eval_dataset.sql and executing the eval CLIs.

-- 1. Eval set/case/gold summary.
select
  s.name,
  count(distinct c.id) as cases,
  count(g.id) as gold_rows,
  count(g.id) filter (where g.review_status = 'pending') as pending_gold,
  count(g.id) filter (where g.review_status = 'approved') as approved_gold,
  count(g.id) filter (where g.relevance_grade >= 2) as relevant_gold
from public.rag_eval_sets s
left join public.rag_eval_cases c
  on c.eval_set_id = s.id
left join public.rag_eval_gold_evidence g
  on g.case_id = c.id
group by s.name
order by s.name;

-- 2. Spot-check pending high-grade labels before approval.
select
  c.id as case_id,
  g.article_id,
  c.question,
  c.lang,
  c.cohort,
  a.title as article_title,
  g.relevance_grade,
  g.evidence_note,
  g.review_status,
  g.metadata
from public.rag_eval_gold_evidence g
join public.rag_eval_cases c
  on c.id = g.case_id
join public.daily_news a
  on a.id = g.article_id
where g.review_status = 'pending'
order by g.relevance_grade desc, c.created_at desc
limit 20;

-- 3. Approve all perfect/highly relevant labels after human spot-check.
-- update public.rag_eval_gold_evidence
-- set review_status = 'approved',
--     reviewed_by = 'human_admin',
--     reviewed_at = now()
-- where relevance_grade >= 2
--   and review_status = 'pending';

-- 4. Correct and approve one borderline label.
-- update public.rag_eval_gold_evidence
-- set relevance_grade = 2,
--     review_status = 'approved',
--     reviewed_by = 'human_admin',
--     reviewed_at = now(),
--     evidence_note = 'Corrected relevance grade after human verification.'
-- where case_id = '<CASE_UUID>'
--   and article_id = '<ARTICLE_UUID>';

-- 5. Latest replay aggregate metrics.
select
  s.name,
  r.id as eval_run_id,
  r.runner_version,
  r.retrieval_strategy,
  r.retrieval_version,
  m.total_cases,
  m.approved_gold_count,
  round(m.avg_recall_at_3::numeric, 3) as avg_recall_at_3,
  round(m.avg_recall_at_5::numeric, 3) as avg_recall_at_5,
  round(m.avg_recall_at_10::numeric, 3) as avg_recall_at_10,
  round(m.avg_mrr::numeric, 3) as avg_mrr,
  round(m.avg_ndcg_at_10::numeric, 3) as avg_ndcg_at_10,
  round(m.avg_hit_rate_at_5::numeric, 3) as avg_hit_rate_at_5,
  m.latency_p50_ms,
  m.latency_p95_ms,
  r.created_at
from public.rag_eval_retrieval_metrics m
join public.rag_eval_runs r
  on r.id = m.eval_run_id
join public.rag_eval_sets s
  on s.id = r.eval_set_id
order by r.created_at desc
limit 10;

-- 6. Worst replay cases for inspection.
select
  s.name,
  r.id as eval_run_id,
  c.question,
  c.primary_article_id,
  cr.recall_at_10,
  cr.mrr,
  cr.ndcg_at_10,
  cr.hit_at_5,
  rr.latency_ms,
  rr.candidate_count
from public.rag_eval_case_results cr
join public.rag_eval_runs r
  on r.id = cr.eval_run_id
join public.rag_eval_sets s
  on s.id = r.eval_set_id
join public.rag_eval_cases c
  on c.id = cr.case_id
join public.rag_retrieval_runs rr
  on rr.id = cr.retrieval_run_id
order by r.created_at desc, cr.recall_at_10 asc, cr.mrr asc
limit 20;

-- 7. Candidate audit for latest eval replay run.
with latest_run as (
  select id
  from public.rag_eval_runs
  order by created_at desc
  limit 1
)
select
  c.question,
  rc.rank,
  rc.article_id,
  rc.title,
  rc.score_dense,
  ge.relevance_grade,
  ge.review_status
from latest_run lr
join public.rag_eval_case_results cr
  on cr.eval_run_id = lr.id
join public.rag_eval_cases c
  on c.id = cr.case_id
join public.rag_retrieval_candidates rc
  on rc.retrieval_run_id = cr.retrieval_run_id
left join public.rag_eval_gold_evidence ge
  on ge.case_id = c.id
 and ge.article_id = rc.article_id
order by c.created_at desc, rc.rank asc
limit 50;
