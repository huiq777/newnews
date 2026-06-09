-- 20260608 — RAG eval case taxonomy metadata.
--
-- Taxonomy remains in rag_eval_cases.metadata so the eval schema can evolve
-- without blocking existing replay tables. This is eval-only and does not
-- change production retrieval.

with classified as (
  select
    c.id,
    c.metadata,
    coalesce(s.source_type, 'unknown') as source_type,
    coalesce(c.lang, 'zh') as language,
    length(coalesce(dn.article_content, dn.summary_en, dn.summary_zh, '')) as article_chars,
    case
      when s.source_type in ('youtube', 'podcast') then 'transcript'
      when s.source_type in ('reddit', 'apify_tweet', 'x_api') then 'reddit_social'
      when s.source_type in ('official_rss', 'official_html') then 'official'
      when length(coalesce(dn.article_content, dn.summary_en, dn.summary_zh, '')) > 1500 then 'long_form'
      when length(coalesce(dn.article_content, dn.summary_en, dn.summary_zh, '')) between 1 and 1500 then 'short_news'
      else 'unknown'
    end as format_cohort,
    case
      when length(coalesce(dn.article_content, dn.summary_en, dn.summary_zh, '')) <= 300 then 'short_0_300'
      when length(coalesce(dn.article_content, dn.summary_en, dn.summary_zh, '')) <= 1500 then 'medium_301_1500'
      else 'long_1501_plus'
    end as content_length_bucket,
    case
      when c.case_type = 'comparison' or c.question ~* '(compare|versus| vs |比较|对比)' then 'comparison'
      when c.case_type = 'temporal' or c.question ~* '(timeline|when|date|时间|日期|何时)' then 'timeline'
      when c.question ~* '(these|it|that|上述|这家公司|该公司)' then 'ambiguous_followup'
      when c.question ~* '(and|以及|同时|之间|多方|multi-hop)' then 'multi_hop'
      when c.question ~* '([A-Z][A-Za-z0-9$.-]+|[0-9]+|OpenAI|Anthropic|Google|Microsoft|Okta|xAI)' then 'entity_lookup'
      else 'single_hop'
    end as question_type,
    case
      when c.question ~* '([A-Z][A-Za-z0-9$.-]+.*[A-Z][A-Za-z0-9$.-]+|OpenAI|Anthropic|Google|Microsoft|Okta|xAI|\$[0-9])' then 'high'
      when c.question ~* '([A-Z][A-Za-z0-9$.-]+|[0-9]+)' then 'medium'
      else 'low'
    end as entity_density,
    case
      when c.case_source = 'production_badcase' then 'production_badcase'
      when c.case_source = 'manual' then 'human'
      else 'synthetic_paraphrase'
    end as origin,
    array_remove(array[
      case when c.question ~* '([A-Z][A-Za-z0-9$.-]+.*[A-Z][A-Za-z0-9$.-]+|OpenAI|Anthropic|Google|Microsoft|Okta|xAI|\$[0-9])' then 'entity_heavy' end,
      case when c.question ~* '(timeline|when|date|时间|日期|何时)' then 'temporal_event' end,
      case when c.question ~* '(legal|lawsuit|FedRAMP|合规|司法|法院|监管)' then 'legal_policy' end,
      case when length(coalesce(dn.article_content, dn.summary_en, dn.summary_zh, '')) > 1500 then 'long_context' end,
      case when length(coalesce(dn.article_content, dn.summary_en, dn.summary_zh, '')) <= 300 then 'short_sparse' end
    ], null) as difficulty_tags
  from public.rag_eval_cases c
  left join public.daily_news dn on dn.id = c.primary_article_id
  left join public.sources s on s.id = dn.source_id
)
update public.rag_eval_cases c
set metadata = jsonb_set(
  coalesce(classified.metadata, '{}'::jsonb)
  || jsonb_build_object(
    'format_cohort', classified.format_cohort,
    'content_length_bucket', classified.content_length_bucket,
    'source_type', classified.source_type,
    'language', classified.language,
    'question_type', classified.question_type,
    'entity_density', classified.entity_density,
    'origin', classified.origin
  ),
  '{difficulty_tags}',
  to_jsonb(classified.difficulty_tags),
  true
)
from classified
where c.id = classified.id;

-- Read-only diagnostic: approved cases missing required taxonomy labels.
select
  c.id,
  c.question,
  c.metadata
from public.rag_eval_cases c
where not (
  c.metadata ? 'format_cohort'
  and c.metadata ? 'content_length_bucket'
  and c.metadata ? 'source_type'
  and c.metadata ? 'question_type'
  and c.metadata ? 'entity_density'
  and c.metadata ? 'origin'
)
order by c.created_at;

-- Read-only diagnostic: metrics by taxonomy slice from latest run per strategy.
with default_set as (
  select id
  from public.rag_eval_sets
  where name = 'qa-v1-2026-06'
  order by created_at desc
  limit 1
),
latest_run_by_strategy as (
  select distinct on (retrieval_strategy)
    id,
    retrieval_strategy,
    created_at,
    notes
  from public.rag_eval_runs
  where eval_set_id = (select id from default_set)
  order by retrieval_strategy, created_at desc
),
metrics_by_taxonomy_slice as (
  select
    r.id as eval_run_id,
    r.retrieval_strategy,
    c.metadata->>'format_cohort' as format_cohort,
    c.metadata->>'source_type' as source_type,
    c.metadata->>'question_type' as question_type,
    c.metadata->>'entity_density' as entity_density,
    jsonb_array_elements_text(coalesce(c.metadata->'difficulty_tags', '[]'::jsonb)) as difficulty_tag,
    count(*) as total_cases,
    case
      when count(*) < 5 then 'directional_n_lt_5'
      else 'reviewable'
    end as slice_status,
    avg(cr.recall_at_5) as avg_recall_at_5,
    avg(cr.recall_at_10) as avg_recall_at_10,
    avg(cr.mrr) as avg_mrr,
    avg(cr.ndcg_at_10) as avg_ndcg_at_10,
    avg(case when cr.hit_at_5 then 1 else 0 end) as avg_hit_at_5
  from latest_run_by_strategy r
  join public.rag_eval_case_results cr on cr.eval_run_id = r.id
  join public.rag_eval_cases c on c.id = cr.case_id
  where c.metadata ? 'format_cohort'
  group by
    r.id,
    r.retrieval_strategy,
    c.metadata->>'format_cohort',
    c.metadata->>'source_type',
    c.metadata->>'question_type',
    c.metadata->>'entity_density',
    difficulty_tag
)
select *
from metrics_by_taxonomy_slice
order by retrieval_strategy, format_cohort, question_type, difficulty_tag;

-- Read-only diagnostic: impossible metric bounds after metric-fixed replay.
-- Expected result after fresh replay: no rows.
with default_set as (
  select id
  from public.rag_eval_sets
  where name = 'qa-v1-2026-06'
  order by created_at desc
  limit 1
),
case_metric_bounds as (
  select
    er.retrieval_strategy,
    max(cr.recall_at_10) as max_recall_at_10,
    max(cr.ndcg_at_10) as max_ndcg_at_10
  from public.rag_eval_case_results cr
  join public.rag_eval_runs er on er.id = cr.eval_run_id
  where er.eval_set_id = (select id from default_set)
  group by er.retrieval_strategy
)
select *
from case_metric_bounds
where max_recall_at_10 > 1
   or max_ndcg_at_10 > 1;
