-- 20260608 — RAG eval hard-negative evidence.
--
-- Hard negatives are same-topic but wrong-event distractors. They live in
-- rag_eval_gold_evidence with metadata->>'evidence_role' = 'hard_negative'
-- and relevance_grade = 0. They are diagnostics/stress inputs, never relevant
-- gold and never positive NDCG gain.

alter table public.rag_eval_gold_evidence
  drop constraint if exists rag_eval_gold_hard_negative_zero_grade;

alter table public.rag_eval_gold_evidence
  add constraint rag_eval_gold_hard_negative_zero_grade
  check (
    (metadata->>'evidence_role' is distinct from 'hard_negative')
    or relevance_grade = 0
  );

-- Read-only candidate proposals: 5-10 same-topic distractors per approved case.
-- Review manually before setting review_status = 'approved'.
with approved_cases as (
  select
    c.id as case_id,
    c.question,
    c.primary_article_id,
    c.metadata as case_metadata,
    dn.source_id,
    dn.category,
    dn.published_at,
    s.source_type,
    coalesce(dn.title_en, dn.title_zh, dn.title, '') as title,
    coalesce(dn.summary_en, dn.summary_zh, '') as summary
  from public.rag_eval_cases c
  join public.daily_news dn on dn.id = c.primary_article_id
  left join public.sources s on s.id = dn.source_id
  where exists (
    select 1
    from public.rag_eval_gold_evidence g
    where g.case_id = c.id
      and g.review_status = 'approved'
      and g.relevance_grade >= 2
  )
),
existing_gold as (
  select case_id, article_id
  from public.rag_eval_gold_evidence
),
question_terms as (
  select distinct
    ac.case_id,
    regexp_replace(term, '[^[:alnum:]]+', '', 'g') as term
  from approved_cases ac
  cross join lateral regexp_split_to_table(lower(ac.question), '\s+') as term
  where length(regexp_replace(term, '[^[:alnum:]]+', '', 'g')) >= 3
),
primary_gold_terms as (
  select distinct
    g.case_id,
    regexp_replace(term, '[^[:alnum:]]+', '', 'g') as term
  from public.rag_eval_gold_evidence g
  join public.daily_news dn on dn.id = g.article_id
  cross join lateral regexp_split_to_table(
    lower(coalesce(dn.title_en, dn.title_zh, dn.title, '') || ' ' || coalesce(dn.summary_en, dn.summary_zh, '')),
    '\s+'
  ) as term
  where g.review_status = 'approved'
    and g.relevance_grade >= 2
    and g.metadata->>'evidence_role' is distinct from 'hard_negative'
    and length(regexp_replace(term, '[^[:alnum:]]+', '', 'g')) >= 3
),
top_k_retrieval_candidates as (
  select distinct
    cr.case_id,
    rc.article_id
  from public.rag_eval_case_results cr
  join public.rag_retrieval_candidates rc on rc.retrieval_run_id = cr.retrieval_run_id
  where rc.rank <= 20
),
hard_negative_candidate_pool as (
  select
    ac.case_id,
    dn.id as article_id,
    case
      when dn.source_id = ac.source_id and dn.id <> ac.primary_article_id then 'same_source_wrong_article'
      when dn.published_at::date is distinct from ac.published_at::date then 'same_entity_wrong_time'
      when dn.category = ac.category then 'same_topic_wrong_event'
      else 'semantically_similar_not_answer_supporting'
    end as hard_negative_type,
    coalesce(dn.title_en, dn.title_zh, dn.title, '') as candidate_title,
    coalesce(dn.summary_en, dn.summary_zh, '') as candidate_summary,
    lower(coalesce(dn.title_en, dn.title_zh, dn.title, '') || ' ' || coalesce(dn.summary_en, dn.summary_zh, '')) as candidate_text,
    dn.source_id = ac.source_id as same_source,
    dn.category = ac.category as same_category,
    exists (
      select 1
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(ac.case_metadata->'entity_tags') = 'array' then ac.case_metadata->'entity_tags'
          else '[]'::jsonb
        end
      ) entity_tag
      where length(entity_tag.value) >= 3
        and lower(coalesce(dn.title_en, dn.title_zh, dn.title, '') || ' ' || coalesce(dn.summary_en, dn.summary_zh, '')) ilike '%' || lower(entity_tag.value) || '%'
    ) as strong_entity_tag_shared,
    exists (
      select 1
      from top_k_retrieval_candidates top_k
      where top_k.case_id = ac.case_id
        and top_k.article_id = dn.id
    ) as appeared_in_top_k,
    case
      when dn.published_at is null or ac.published_at is null then null
      else abs(extract(epoch from (dn.published_at - ac.published_at)))
    end as seconds_from_primary_event,
    dn.created_at
  from approved_cases ac
  join public.daily_news dn on dn.id <> ac.primary_article_id
  where not exists (
    select 1
    from existing_gold eg
    where eg.case_id = ac.case_id
      and eg.article_id = dn.id
    )
    and (
      dn.source_id = ac.source_id
      or dn.category = ac.category
      or coalesce(dn.title_en, dn.title_zh, dn.title, '') ilike '%' || split_part(ac.title, ' ', 1) || '%'
      or exists (
        select 1
        from top_k_retrieval_candidates top_k
        where top_k.case_id = ac.case_id
          and top_k.article_id = dn.id
      )
    )
),
candidate_overlap as (
  select
    pool.case_id,
    pool.article_id,
    count(distinct qt.term) filter (where qt.term is not null and position(qt.term in pool.candidate_text) > 0) as question_overlap_terms,
    count(distinct pgt.term) filter (where pgt.term is not null and position(pgt.term in pool.candidate_text) > 0) as gold_title_overlap_terms,
    pool.appeared_in_top_k,
    pool.strong_entity_tag_shared
  from hard_negative_candidate_pool pool
  left join question_terms qt on qt.case_id = pool.case_id
  left join primary_gold_terms pgt on pgt.case_id = pool.case_id
  group by
    pool.case_id,
    pool.article_id,
    pool.appeared_in_top_k,
    pool.strong_entity_tag_shared
),
hard_negative_candidate_proposals as (
  select
    pool.case_id,
    pool.article_id,
    pool.hard_negative_type,
    pool.candidate_title,
    pool.candidate_summary,
    co.question_overlap_terms,
    co.gold_title_overlap_terms,
    co.appeared_in_top_k,
    co.strong_entity_tag_shared,
    row_number() over (
      partition by pool.case_id
      order by
        co.appeared_in_top_k desc,
        co.strong_entity_tag_shared desc,
        co.question_overlap_terms desc,
        co.gold_title_overlap_terms desc,
        pool.same_source desc,
        pool.same_category desc,
        pool.seconds_from_primary_event nulls last,
        pool.created_at desc
    ) as proposal_rank
  from hard_negative_candidate_pool pool
  join candidate_overlap co on co.case_id = pool.case_id and co.article_id = pool.article_id
  where co.question_overlap_terms >= 1
    or co.gold_title_overlap_terms >= 1
    or co.appeared_in_top_k
    or co.strong_entity_tag_shared
)
select
  case_id,
  article_id,
  0 as relevance_grade,
  'pending' as review_status,
  jsonb_build_object(
    'evidence_role', 'hard_negative',
    'hard_negative_type', hard_negative_type,
    'proposal_rank', proposal_rank,
    'question_overlap_terms', question_overlap_terms,
    'gold_title_overlap_terms', gold_title_overlap_terms,
    'appeared_in_top_k', appeared_in_top_k,
    'strong_entity_tag_shared', strong_entity_tag_shared,
    'review_rule', 'same-topic wrong event / same entity wrong time / same source wrong article / semantically similar but not answer-supporting'
  ) as metadata,
  hard_negative_type,
  candidate_title,
  candidate_summary,
  question_overlap_terms,
  gold_title_overlap_terms,
  appeared_in_top_k,
  strong_entity_tag_shared
from hard_negative_candidate_proposals
where proposal_rank <= 10
order by case_id, proposal_rank
limit 10;

-- Optional insert template after human review. Keep review_status pending until
-- a reviewer confirms the candidate is a true distractor.
--
-- insert into public.rag_eval_gold_evidence (
--   case_id, article_id, relevance_grade, review_status, evidence_note, metadata
-- )
-- select
--   case_id,
--   article_id,
--   0,
--   'pending',
--   'Hard-negative proposal: same-topic distractor, not answer-supporting.',
--   metadata
-- from hard_negative_candidate_proposals
-- where proposal_rank <= 10
-- on conflict (case_id, article_id) do update
-- set relevance_grade = 0,
--     metadata = public.rag_eval_gold_evidence.metadata || excluded.metadata;

-- Passive diagnostic: hard negatives ranked above approved gold in latest runs.
with latest_runs as (
  select distinct on (retrieval_strategy)
    id,
    retrieval_strategy,
    created_at
  from public.rag_eval_runs
  order by retrieval_strategy, created_at desc
),
case_ranks as (
  select
    lr.retrieval_strategy,
    cr.case_id,
    min(rc.rank) filter (where ge.relevance_grade >= 2 and ge.metadata->>'evidence_role' is distinct from 'hard_negative') as best_gold_rank,
    min(rc.rank) filter (where ge.metadata->>'evidence_role' = 'hard_negative') as best_hard_negative_rank,
    array_agg(rc.article_id order by rc.rank) filter (where ge.metadata->>'evidence_role' = 'hard_negative') as ranked_hard_negative_article_ids
  from latest_runs lr
  join public.rag_eval_case_results cr on cr.eval_run_id = lr.id
  join public.rag_retrieval_candidates rc on rc.retrieval_run_id = cr.retrieval_run_id
  left join public.rag_eval_gold_evidence ge on ge.case_id = cr.case_id and ge.article_id = rc.article_id
  group by lr.retrieval_strategy, cr.case_id
)
select *
from case_ranks
where best_hard_negative_rank is not null
  and (best_gold_rank is null or best_hard_negative_rank < best_gold_rank)
order by retrieval_strategy, case_id;
