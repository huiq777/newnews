-- 20260426 — Verification queries (run after Specs A/B/C deploy)
-- These are read-only checks. Run individually in the Supabase SQL Editor.

-- ── Spec A: arXiv articles flowing through to daily_news ──────────────────────
-- Expected: nonzero counts for both 'arXiv cs.AI' and 'arXiv cs.LG' once the
-- arXiv backfill (20260426_arxiv_backfill.sql) has had time to drain.
select s.name, count(*) as arxiv_in_daily_news
from daily_news dn
join sources s on s.id = dn.source_id
where s.source_type = 'arxiv' and dn.created_at > now() - interval '24 hours'
group by s.name;

-- ── Spec B: Reddit/Nowcoder substantive content vs title-only ────────────────
-- Expected: substantive count dominates after fix. Pre-fix all rows were
-- title_only because raw_content held only the post title.
select s.name,
       count(*) filter (where length(ri.raw_content) > 500) as substantive,
       count(*) filter (where length(ri.raw_content) <= 200) as title_only
from raw_ingestion ri
join sources s on s.id = ri.source_id
where (s.name like 'Reddit%' or s.name = 'Nowcoder Hot')
  and ri.fetched_at > now() - interval '24 hours'
group by s.name;

-- ── Spec C: daily_news.category invariant ────────────────────────────────────
-- Expected: 0. NOT NULL constraint should have caught any violations at write
-- time, but verify the invariant holds.
select count(*) as null_category_rows from daily_news where category is null;

-- ── Spec C: LLM-emitted category vs sources.category fallback ────────────────
-- Compare to confirm the override (LLM picked a different category from the
-- source default) and the fallback (LLM omitted/invalid → sources.category)
-- are both working. Spot-check the rows in each bucket.
select dn.category as llm_category,
       s.category as source_category,
       count(*) as rows,
       (dn.category = s.category) as matches_source_default
from daily_news dn
join sources s on s.id = dn.source_id
where dn.created_at > now() - interval '24 hours'
group by dn.category, s.category
order by rows desc;
