-- 20260603 — Human-curated RAG eval coverage candidate selection.
-- Read-only. Use these queries to choose eval candidates; do not auto-insert cases.

-- 1. Current coverage status.
select
  count(*) as total_cases,
  count(*) filter (where approved_relevant_gold > 0) as runnable_cases,
  count(*) filter (where approved_relevant_gold = 0) as cases_without_relevant_gold
from (
  select
    c.id,
    count(*) filter (
      where g.review_status = 'approved'
        and g.relevance_grade >= 2
    ) as approved_relevant_gold
  from public.rag_eval_cases c
  left join public.rag_eval_gold_evidence g on g.case_id = c.id
  group by c.id
) x;

-- 2. Production Q&A cases with weak retrieval traces or negative feedback.
select
  q.id as qa_log_id,
  q.article_id,
  dn.title,
  q.question,
  q.feedback,
  q.related_article_ids,
  r.candidate_count,
  r.injected_count,
  r.latency_ms,
  q.asked_at
from public.qa_logs q
join public.daily_news dn on dn.id = q.article_id
left join public.rag_retrieval_runs r on r.id = q.rag_retrieval_run_id
where q.asked_at > now() - interval '30 days'
  and (
    q.feedback = -1
    or coalesce(r.candidate_count, 0) = 0
    or coalesce(array_length(q.related_article_ids, 1), 0) = 0
  )
order by q.asked_at desc
limit 50;

-- 3. Recent source-diverse article candidates not already in eval cases.
select
  dn.id as article_id,
  dn.title,
  s.name as source_name,
  s.source_type,
  dn.created_at,
  left(coalesce(dn.summary_zh, dn.summary, dn.summary_en, dn.article_content, ''), 800) as evidence_preview
from public.daily_news dn
join public.sources s on s.id = dn.source_id
where dn.created_at > now() - interval '21 days'
  and not exists (
    select 1
    from public.rag_eval_cases c
    where c.primary_article_id = dn.id
  )
order by s.source_type, dn.created_at desc
limit 100;

-- 4. Social-source eval candidates with processing diagnostics.
-- Use rows with candidate_status = 'ready_for_eval_json' for new
-- docs/superpowers/eval-questions.json cases. Rows with no daily article yet
-- show whether the source is blocked at raw ingestion or process-queue.
with raw_recent as (
  select
    ri.source_id,
    count(*) filter (where ri.fetched_at > now() - interval '24 hours') as raw_24h,
    count(*) filter (where ri.status = 'done' and ri.fetched_at > now() - interval '24 hours') as raw_done_24h,
    count(*) filter (where ri.status = 'error' and ri.fetched_at > now() - interval '24 hours') as raw_error_24h,
    max(ri.fetched_at) as newest_raw,
    string_agg(
      distinct left(ri.last_error, 180),
      ' | '
    ) filter (
      where ri.last_error is not null
        and ri.fetched_at > now() - interval '24 hours'
    ) as recent_errors
  from public.raw_ingestion ri
  group by ri.source_id
),
ranked_articles as (
  select
    dn.id as article_id,
    dn.source_id,
    dn.title,
    dn.created_at,
    length(coalesce(dn.article_content, '')) as article_chars,
    left(coalesce(dn.article_content, dn.summary_zh, dn.summary, dn.summary_en, ''), 800) as evidence_preview,
    coalesce(dn.article_content, dn.summary_zh, dn.summary, dn.summary_en, '') ~
      '(环境异常|当前环境异常|完成验证后即可继续访问|去验证)' as has_verification_wall,
    row_number() over (
      partition by dn.source_id
      order by length(coalesce(dn.article_content, '')) desc, dn.created_at desc
    ) as rn
  from public.daily_news dn
  where dn.created_at > now() - interval '14 days'
    and not exists (
      select 1
      from public.rag_eval_cases c
      where c.primary_article_id = dn.id
    )
)
select
  s.name as source_name,
  s.source_type,
  coalesce(rr.raw_24h, 0) as raw_24h,
  coalesce(rr.raw_done_24h, 0) as raw_done_24h,
  coalesce(rr.raw_error_24h, 0) as raw_error_24h,
  rr.newest_raw,
  rr.recent_errors,
  ra.article_id,
  ra.title,
  ra.article_chars,
  ra.created_at as article_created_at,
  ra.evidence_preview,
  case
    when coalesce(ra.has_verification_wall, false) then 'blocked_verification_wall'
    when ra.article_id is not null and ra.article_chars >= 800 then 'ready_for_eval_json'
    when coalesce(rr.raw_24h, 0) = 0 then 'no_recent_raw_ingestion'
    when coalesce(rr.raw_done_24h, 0) = 0 then 'raw_not_processed_to_done'
    when ra.article_id is null then 'no_recent_daily_news_article'
    else 'article_too_short'
  end as candidate_status
from public.sources s
left join raw_recent rr on rr.source_id = s.id
left join ranked_articles ra on ra.source_id = s.id and ra.rn <= 5
where s.source_type in ('wechat', 'youtube', 'reddit')
  and s.is_active = true
order by
  s.source_type,
  candidate_status,
  s.name,
  ra.article_chars desc nulls last;

-- 5. Existing cases that still need relevant approved evidence.
select
  c.id as case_id,
  c.primary_article_id,
  dn.title as primary_title,
  c.question,
  max(g.relevance_grade) filter (where g.review_status = 'approved') as max_approved_grade,
  count(g.id) as labels
from public.rag_eval_cases c
join public.daily_news dn on dn.id = c.primary_article_id
left join public.rag_eval_gold_evidence g on g.case_id = c.id
group by c.id, c.primary_article_id, dn.title, c.question
having coalesce(max(g.relevance_grade) filter (where g.review_status = 'approved'), 0) < 2
order by c.created_at asc;
