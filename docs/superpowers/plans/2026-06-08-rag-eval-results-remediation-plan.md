# RAG Eval Results Remediation Plan

> **For Hui:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan step-by-step.

**Goal:** Convert the 2026-06-08 SQL result set into an implementable remediation sequence that fixes misleading retrieval metrics, clears corpus-health replay blockers, improves hard-negative quality, and then runs the gated query rewrite, rerank, generation, and agentic eval paths.

**Current result source:** `supabase/sql/results.md`

**2026-06-09 remediation outcome:**

- Passing corpus-health run: `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`
- `ready_for_replay = true`
- `zero_chunk_gold_articles = 0`
- `missing_bge_embedding_gold_articles = 0`
- `stale_source_count = 0`
- Valid-only metric-bound SQL returns no rows after metric repair.
- Selected practical retrieval candidate: `chunk_dense @cf/baai/bge-m3`, Recall@5 `0.895`, Recall@10 `0.943`, MRR `0.739`, NDCG@10 `0.764`, Hit@5 `0.952`, p50/p95 as low as `1179/3425ms`.
- Quality ceiling: `rerank_hybrid`, Recall@10 `1.000`, NDCG@10 `0.935`, but p95 `68056ms`, so it remains eval-only.
- Generation eval aggregate for `chunk_dense`: faithfulness `0.994`, answer relevancy `0.950`, context precision `0.785`, context recall `0.819` across 24 judged rows. Group by `eval_run_id` before treating this as a locked benchmark.

**Primary SQL artifacts already installed:**

- `supabase/sql/20260608_rag_eval_corpus_health.sql`
- `supabase/sql/20260608_rag_eval_case_taxonomy.sql`
- `supabase/sql/20260608_rag_eval_hard_negatives.sql`
- `supabase/sql/20260608_rag_query_rewrite_diagnostics.sql`
- `supabase/sql/20260608_rag_eval_rerank_cache.sql`
- `supabase/sql/20260608_rag_generation_eval.sql`
- `supabase/sql/20260608_agentic_rag_eval_trace.sql`

**Known result facts to preserve:**

- Latest corpus-health run id: `6c926d4e-0a42-4163-8196-bcdcdd8edec1`
- Eval set id: `bb090d0b-6df2-4002-aa00-4d84e0002821`
- Chunking version: `paragraph-window-v1-2026-06-02`
- Embedding model: `@cf/baai/bge-m3`
- Corpus health says:
  - `ready_for_taxonomy = true`
  - `ready_for_hard_negatives = true`
  - `ready_for_replay = false`
  - `zero_chunk_gold_articles = 7`
  - `stale_source_count = 4`
  - `missing_bge_embedding_gold_articles = 0`
  - `deep_analysis_pending = 371`
  - `deep_analysis_processing_stale = 291`
- Several taxonomy slices have `ndcg_at_10 > 1.0`, which is impossible for valid NDCG and indicates article-level metric overcounting.
- Hard-negative proposals exist, all with `metadata->>'evidence_role' = 'hard_negative'` and `relevance_grade = 0`, but all are still `review_status = 'pending'`.
- Query rewrite, rerank cache, generation eval, and agentic trace diagnostics currently return no rows, so those runtime paths are installed but not yet exercised.

## Implementation Overview

Fix the result interpretation in this order:

1. Correct article-level retrieval metric computation before trusting any existing taxonomy slice numbers.
2. Add diagnostics for the 7 zero-chunk approved gold articles and the 4 stale active sources.
3. Repair corpus health until `ready_for_replay = true`, or explicitly mark replays invalid for strategy selection.
4. Refine hard-negative candidate quality and add a review path.
5. Re-run taxonomy and strategy replays only after metrics and corpus health are sane.
6. Exercise query rewrite, rerank, generation, and agentic eval paths in smoke mode first, then in gated mode.
7. Update progress and resume docs to separate historical baselines from release-grade strategy truth.

## Task 1: Fix Article-Level Metric Overcounting

**Problem:** Taxonomy output contains impossible `ndcg_at_10 > 1.0` values. The current retrieval metric code computes article-level gold relevance, but chunk retrieval can return multiple chunks for the same relevant article. If those duplicate chunks are all counted, Recall and NDCG can exceed their intended article-level semantics.

**Files:**

- `scripts/rag-eval-lib.mjs`
- `tests/rag-retrieval-refinement.test.mjs`

### Step 1.1: Add a failing duplicate-chunk regression test

In `tests/rag-retrieval-refinement.test.mjs`, import `computeRetrievalMetrics` from `scripts/rag-eval-lib.mjs` if it is not already imported.

Add this test near the other retrieval metric tests:

```js
test('article-level retrieval metrics de-duplicate repeated chunks from the same article', () => {
  const metrics = computeRetrievalMetrics(
    [
      { id: 'article-gold', article_id: 'article-gold', chunk_id: 'chunk-1', rank: 1 },
      { id: 'article-gold', article_id: 'article-gold', chunk_id: 'chunk-2', rank: 2 },
      { id: 'article-miss', article_id: 'article-miss', chunk_id: 'chunk-3', rank: 3 },
    ],
    [
      {
        article_id: 'article-gold',
        relevance_grade: 3,
        review_status: 'approved',
        metadata: {},
      },
    ],
  )

  assert.equal(metrics.recall_at_3, 1)
  assert.equal(metrics.recall_at_5, 1)
  assert.equal(metrics.hit_at_5, 1)
  assert.equal(metrics.mrr, 1)
  assert.equal(metrics.ndcg_at_10 <= 1, true)
})
```

Run the test and confirm it fails before implementation:

```sh
npm test
```

### Step 1.2: De-duplicate candidates by article identity

In `scripts/rag-eval-lib.mjs`, add a helper close to `computeRetrievalMetrics`:

```js
export function dedupeCandidatesForArticleMetrics(candidates = []) {
  const seenArticleIds = new Set()
  const deduped = []

  for (const candidate of candidates) {
    const articleId = candidate.id || candidate.article_id
    if (!articleId || seenArticleIds.has(articleId)) continue

    seenArticleIds.add(articleId)
    deduped.push({
      ...candidate,
      rank: deduped.length + 1,
    })
  }

  return deduped
}
```

Update `computeRetrievalMetrics()` so all article-level metric calculations use the de-duplicated candidate list:

```js
export function computeRetrievalMetrics(candidates, goldRows) {
  const articleCandidates = dedupeCandidatesForArticleMetrics(candidates)
  const relevantGold = goldRows.filter(
    (row) => !isHardNegativeEvidence(row) && Number(row.relevance_grade || 0) >= 2,
  )
  const relevantIds = new Set(relevantGold.map((row) => row.article_id))
  const gradeById = new Map(
    goldRows.map((row) => [
      row.article_id,
      isHardNegativeEvidence(row) ? 0 : Number(row.relevance_grade || 0),
    ]),
  )

  const recall = (k) => {
    if (relevantIds.size === 0) return 0
    const hits = articleCandidates
      .slice(0, k)
      .filter((row) => relevantIds.has(row.id || row.article_id)).length
    return roundMetric(hits / relevantIds.size)
  }

  const firstRelevantIndex = articleCandidates.findIndex((row) =>
    relevantIds.has(row.id || row.article_id),
  )

  return {
    recall_at_3: recall(3),
    recall_at_5: recall(5),
    recall_at_10: recall(10),
    mrr: firstRelevantIndex >= 0 ? roundMetric(1 / (firstRelevantIndex + 1)) : 0,
    ndcg_at_10: ndcgAt(articleCandidates, gradeById, relevantGold, 10),
    hit_at_5: articleCandidates.slice(0, 5).some((row) => relevantIds.has(row.id || row.article_id))
      ? 1
      : 0,
  }
}
```

### Step 1.3: Verify metric bounds

Run:

```sh
npm test
```

Then add a local diagnostic check against a fresh replay result after Task 3:

```sql
select
  retrieval_strategy,
  max((metrics->>'ndcg_at_10')::numeric) as max_ndcg_at_10,
  max((metrics->>'recall_at_10')::numeric) as max_recall_at_10
from rag_retrieval_runs rr
join rag_eval_runs er on er.id = rr.eval_run_id
where er.eval_set_id = 'bb090d0b-6df2-4002-aa00-4d84e0002821'
group by retrieval_strategy
having
  max((metrics->>'ndcg_at_10')::numeric) > 1
  or max((metrics->>'recall_at_10')::numeric) > 1;
```

Expected result after fresh replay: no rows.

## Task 2: Add Corpus-Health Blocker Diagnostics

**Problem:** Corpus health blocks replay, but `results.md` only gives summary counts. We need exact article/source rows to repair the data.

**Files:**

- `supabase/sql/20260608_rag_eval_zero_chunk_gold_diagnostics.sql`
- `tests/rag-retrieval-refinement.test.mjs`

### Step 2.1: Create zero-chunk gold diagnostic SQL

Create `supabase/sql/20260608_rag_eval_zero_chunk_gold_diagnostics.sql`:

```sql
-- Explain approved relevant gold articles that block chunk-dependent replay.
with default_set as (
  select id
  from rag_eval_sets
  where name = 'qa-v1-2026-06'
  order by created_at desc
  limit 1
),
approved_relevant_gold as (
  select
    c.id as case_id,
    c.question,
    g.article_id,
    g.relevance_grade,
    g.metadata
  from rag_eval_cases c
  join rag_eval_gold_articles g on g.eval_case_id = c.id
  join default_set s on s.id = c.eval_set_id
  where c.status = 'approved'
    and g.review_status = 'approved'
    and coalesce((g.metadata->>'evidence_role') <> 'hard_negative', true)
    and g.relevance_grade >= 2
),
chunk_counts as (
  select
    article_id,
    chunking_version,
    count(*) as chunk_count,
    count(*) filter (where embedding_model = '@cf/baai/bge-m3') as bge_chunk_count
  from article_chunks
  group by article_id, chunking_version
),
gold_with_chunks as (
  select
    g.case_id,
    g.question,
    g.article_id,
    g.relevance_grade,
    a.title,
    a.url,
    a.source_type,
    a.source_name,
    a.published_at,
    length(coalesce(a.article_content, '')) as article_content_chars,
    length(coalesce(a.summary, '')) as summary_chars,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'chunking_version', cc.chunking_version,
          'chunk_count', cc.chunk_count,
          'bge_chunk_count', cc.bge_chunk_count
        )
        order by cc.chunking_version
      ) filter (where cc.article_id is not null),
      '[]'::jsonb
    ) as chunk_versions
  from approved_relevant_gold g
  join articles a on a.id = g.article_id
  left join chunk_counts cc on cc.article_id = g.article_id
  group by
    g.case_id,
    g.question,
    g.article_id,
    g.relevance_grade,
    a.title,
    a.url,
    a.source_type,
    a.source_name,
    a.published_at,
    a.article_content,
    a.summary
)
select
  *,
  case
    when chunk_versions = '[]'::jsonb and article_content_chars = 0 and summary_chars = 0
      then 'missing_article_text'
    when chunk_versions = '[]'::jsonb and article_content_chars < 200
      then 'below_default_chunk_backfill_min_chars'
    when chunk_versions = '[]'::jsonb
      then 'needs_chunk_backfill'
    when not exists (
      select 1
      from jsonb_array_elements(chunk_versions) entry
      where entry->>'chunking_version' = 'paragraph-window-v1-2026-06-02'
        and (entry->>'bge_chunk_count')::integer > 0
    )
      then 'missing_required_chunking_or_embedding'
    else 'healthy'
  end as invalid_reason
from gold_with_chunks
where not exists (
  select 1
  from jsonb_array_elements(chunk_versions) entry
  where entry->>'chunking_version' = 'paragraph-window-v1-2026-06-02'
    and (entry->>'bge_chunk_count')::integer > 0
)
order by source_type, published_at desc nulls last, article_id;
```

### Step 2.2: Add stale-source diagnostic SQL to the same file

Append this query under the zero-chunk query:

```sql
-- Explain active sources that block release-grade replay freshness.
select
  id as source_id,
  name,
  type,
  url,
  enabled,
  last_checked_at,
  last_success_at,
  last_error_at,
  error_count,
  last_error,
  case
    when enabled is not true then 'disabled'
    when last_success_at is null then 'never_succeeded'
    when last_success_at < now() - interval '48 hours' then 'stale_success'
    else 'healthy'
  end as freshness_status
from sources
where enabled is true
  and (
    last_success_at is null
    or last_success_at < now() - interval '48 hours'
  )
order by last_success_at asc nulls first, name;
```

### Step 2.3: Add SQL coverage test

In `tests/rag-retrieval-refinement.test.mjs`, add a SQL file assertion:

```js
test('zero chunk diagnostics explain corpus-health replay blockers', () => {
  const sql = readFileSync(
    new URL('../supabase/sql/20260608_rag_eval_zero_chunk_gold_diagnostics.sql', import.meta.url),
    'utf8',
  )

  assert.match(sql, /approved relevant gold articles/i)
  assert.match(sql, /article_content_chars/)
  assert.match(sql, /chunk_versions/)
  assert.match(sql, /missing_article_text/)
  assert.match(sql, /below_default_chunk_backfill_min_chars/)
  assert.match(sql, /needs_chunk_backfill/)
  assert.match(sql, /stale_success/)
})
```

Run:

```sh
npm test
```

## Task 3: Repair Corpus Health Before Release-Grade Replay

**Problem:** `ready_for_replay = false` means chunk-dependent strategy results must not be used as release-grade strategy truth.

**Files:**

- `supabase/sql/results.md`
- `docs/superpowers/rag-retrieval-refinement-progress.md`
- `docs/project-interview-resume-brief.md`

### Step 3.1: Run blocker diagnostics

Run the new diagnostic SQL in Supabase:

```sql
\i supabase/sql/20260608_rag_eval_zero_chunk_gold_diagnostics.sql
```

Record:

- The 7 zero-chunk gold article IDs.
- Each article's `invalid_reason`.
- The 4 stale source IDs and `freshness_status`.

### Step 3.2: Repair zero-chunk gold articles

For rows with `invalid_reason = 'needs_chunk_backfill'` or `missing_required_chunking_or_embedding`, run:

```sh
npm run eval:chunk-backfill -- --eval-set qa-v1-2026-06 --batch-size 8 --min-chars 1
```

For rows with `invalid_reason = 'below_default_chunk_backfill_min_chars'`, use one of these data decisions:

- If the article has enough useful `summary` text, create a small chunk from available article text through the existing chunk backfill path with `--min-chars 1`.
- If the article is too short to support retrieval evaluation, set its gold row `review_status = 'rejected'` with metadata explaining `invalid_reason = 'gold_article_not_chunk_eligible'`, then replace it with an approved article that has chunkable text.

For rows with `invalid_reason = 'missing_article_text'`, use one of these data decisions:

- Re-ingest the article content from the original source if the source still provides it.
- Replace the gold article with a chunkable article.
- Reject the gold row with metadata explaining `invalid_reason = 'missing_article_text'`.

Do not mark a replay valid for strategy selection while any approved relevant gold article has zero required chunks.

### Step 3.3: Repair stale sources

For each stale enabled source:

- If it should still be active, run the ingestion path that updates `last_success_at`.
- If it is intentionally inactive, disable it or document why source freshness should not block eval in a separate corpus-health rule change.

Do not silently ignore stale enabled sources in release-grade eval. Either make them healthy or change the corpus-health SQL with a named, reviewable exclusion rule.

### Step 3.4: Re-run corpus health

Run:

```sql
\i supabase/sql/20260608_rag_eval_corpus_health.sql
```

Expected for release-grade replay:

- `ready_for_replay = true`
- `zero_chunk_gold_articles = 0`
- `stale_source_count = 0`
- `missing_bge_embedding_gold_articles = 0`

If `deep_analysis_pending` or `deep_analysis_processing_stale` remains nonzero, retrieval strategy replay can proceed if the SQL says `ready_for_replay = true`, but production-like inline generation eval should remain marked invalid or smoke-only until deep analysis coverage is acceptable.

## Task 4: Tighten Taxonomy Diagnostics

**Problem:** Current taxonomy rows are useful, but some are misleading because they include tiny `n`, historical eval runs, and pre-fix metric artifacts.

**Files:**

- `supabase/sql/20260608_rag_eval_case_taxonomy.sql`
- `tests/rag-retrieval-refinement.test.mjs`

### Step 4.1: Add latest-run filtering

Update the taxonomy metrics query so the main slice output uses only the latest eval run per retrieval strategy.

Add this CTE before the metrics CTE:

```sql
latest_run_by_strategy as (
  select distinct on (retrieval_strategy)
    id,
    retrieval_strategy,
    created_at,
    notes
  from rag_eval_runs
  where eval_set_id = (select id from default_set)
  order by retrieval_strategy, created_at desc
)
```

Then join metrics through `latest_run_by_strategy` instead of all historical `rag_eval_runs`.

### Step 4.2: Add slice status

Add a `slice_status` column:

```sql
case
  when count(*) < 5 then 'directional_n_lt_5'
  else 'reviewable'
end as slice_status
```

Keep tiny slices visible, but do not allow them to drive pass/fail or strategy-selection language.

### Step 4.3: Add metric-bound diagnostic

Append a metric sanity query:

```sql
select
  er.retrieval_strategy,
  max((rr.metrics->>'recall_at_10')::numeric) as max_recall_at_10,
  max((rr.metrics->>'ndcg_at_10')::numeric) as max_ndcg_at_10
from rag_retrieval_runs rr
join rag_eval_runs er on er.id = rr.eval_run_id
where er.eval_set_id = (select id from default_set)
group by er.retrieval_strategy
having
  max((rr.metrics->>'recall_at_10')::numeric) > 1
  or max((rr.metrics->>'ndcg_at_10')::numeric) > 1;
```

Expected result after Task 1 and fresh replay: no rows.

### Step 4.4: Add tests

Add assertions that the taxonomy SQL includes:

- `latest_run_by_strategy`
- `slice_status`
- `directional_n_lt_5`
- `max_ndcg_at_10`

Run:

```sh
npm test
```

## Task 5: Improve Hard-Negative Proposal Quality

**Problem:** The current hard-negative proposals are correctly labeled as pending and grade 0, but several appear too broad. Same-source wrong-article candidates can be easy negatives and may not stress rerank/fusion quality.

**Files:**

- `supabase/sql/20260608_rag_eval_hard_negatives.sql`
- `tests/rag-retrieval-refinement.test.mjs`

### Step 5.1: Preserve the existing safety constraints

Keep these rules unchanged:

- `metadata->>'evidence_role' = 'hard_negative'`
- `relevance_grade = 0`
- DB check constraint requiring hard negatives to be grade 0.
- Proposed hard negatives remain `review_status = 'pending'` until human review.
- Forced hard-negative injection happens before fusion/rerank only, never after final ranking.

### Step 5.2: Add lexical overlap scoring

Refine the proposal query to score candidate article overlap with the case question and primary gold article title.

Use a SQL shape like this inside candidate generation:

```sql
question_terms as (
  select
    c.id as eval_case_id,
    lower(term) as term
  from rag_eval_cases c
  cross join lateral regexp_split_to_table(c.question, '[^A-Za-z0-9]+') as term
  where length(term) >= 4
),
primary_gold_terms as (
  select
    g.eval_case_id,
    lower(term) as term
  from rag_eval_gold_articles g
  join articles a on a.id = g.article_id
  cross join lateral regexp_split_to_table(coalesce(a.title, ''), '[^A-Za-z0-9]+') as term
  where g.review_status = 'approved'
    and g.relevance_grade >= 2
    and coalesce((g.metadata->>'evidence_role') <> 'hard_negative', true)
    and length(term) >= 4
),
candidate_overlap as (
  select
    candidate.eval_case_id,
    candidate.article_id,
    count(distinct qt.term) as question_overlap_terms,
    count(distinct pgt.term) as gold_title_overlap_terms
  from hard_negative_candidates candidate
  join articles a on a.id = candidate.article_id
  left join question_terms qt
    on qt.eval_case_id = candidate.eval_case_id
   and lower(coalesce(a.title, '') || ' ' || coalesce(a.summary, '')) like '%' || qt.term || '%'
  left join primary_gold_terms pgt
    on pgt.eval_case_id = candidate.eval_case_id
   and lower(coalesce(a.title, '') || ' ' || coalesce(a.summary, '')) like '%' || pgt.term || '%'
  group by candidate.eval_case_id, candidate.article_id
)
```

Rank candidates by:

1. Same source type or same source name.
2. Same category if available.
3. More question/title overlap terms.
4. Closer publish date.
5. Higher embedding or retrieval similarity if available from replay candidates.

### Step 5.3: Add quality guardrails

Require at least one of these before proposing a hard negative:

- `question_overlap_terms >= 1`
- `gold_title_overlap_terms >= 1`
- candidate appeared in a top-k retrieval result for that case
- candidate shares a strong structured entity tag once entity extraction is available

Keep the proposal cap at 5-10 per case.

### Step 5.4: Human review pass

After SQL refinement, run hard-negative proposal SQL and review at least 10 cases.

Approve only candidates that are plausible distractors for the question but clearly not correct evidence.

Approval update template:

```sql
update rag_eval_gold_articles
set
  review_status = 'approved',
  metadata = metadata || jsonb_build_object(
    'reviewed_by', 'hui',
    'reviewed_at', now(),
    'review_note', 'Plausible distractor, not supporting evidence.'
  )
where id = '<gold_row_id>'
  and metadata->>'evidence_role' = 'hard_negative'
  and relevance_grade = 0;
```

Run the passive hard-negative diagnostic after approval. If approved hard negatives are never seen in top-k, the negatives are not hard enough and proposal scoring needs another pass.

## Task 6: Re-run Retrieval Replays With Validity Metadata

**Problem:** Existing June 5 metrics are historical offline baselines. After metric correction and corpus-health repair, fresh runs are needed before choosing a strategy.

**Files:**

- `scripts/rag-eval-replay.mjs`
- `scripts/rag-eval-lib.mjs`
- `supabase/sql/results.md`

### Step 6.1: Get a passing corpus-health run id

Use the latest `rag_eval_corpus_health_runs.id` where:

- `ready_for_replay = true`
- `chunking_version = 'paragraph-window-v1-2026-06-02'`
- `embedding_model = '@cf/baai/bge-m3'`

### Step 6.2: Run core retrieval strategies

Run these commands with the passing health run id:

```sh
npm run eval:replay -- --set qa-v1-2026-06 --strategy article_dense --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
npm run eval:replay -- --set qa-v1-2026-06 --strategy chunk_dense --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
npm run eval:replay -- --set qa-v1-2026-06 --strategy chunk_hybrid --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
npm run eval:replay -- --set qa-v1-2026-06 --strategy entity_expanded_chunk --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
```

If corpus health is still failing and a smoke run is needed, use:

```sh
npm run eval:replay -- --set qa-v1-2026-06 --strategy chunk_hybrid --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason chunk_corpus_health_failed
```

Do not use invalid smoke runs to update resume claims or production strategy recommendations.

### Step 6.3: Re-run taxonomy diagnostics

Run:

```sql
\i supabase/sql/20260608_rag_eval_case_taxonomy.sql
```

Expected:

- No metric-bound diagnostic rows.
- Slices with `total_cases < 5` marked `directional_n_lt_5`.
- YouTube transcript, RSS legal/entity, and long-context slices identified as real weak spots only after fresh runs.

## Task 7: Exercise Query Rewrite Diagnostics

**Problem:** Query rewrite diagnostics currently return no rows, which means rewrite instrumentation exists but has not been exercised.

**Files:**

- `scripts/rag-eval-replay.mjs`
- `scripts/rag-eval-lib.mjs`
- `supabase/sql/20260608_rag_query_rewrite_diagnostics.sql`

### Step 7.1: Run a smoke rewrite replay

Run a small invalid smoke replay first:

```sh
npm run eval:replay -- --set qa-v1-2026-06 --strategy chunk_hybrid --rewrite-mode entity_expansion --max-cases 5 --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason query_rewrite_smoke
```

### Step 7.2: Validate trace shape

Run:

```sql
\i supabase/sql/20260608_rag_query_rewrite_diagnostics.sql
```

Expected:

- Rows appear with `rewrite_trace`.
- Each trace includes original query, rewritten query, extracted entities or expansion terms, and fallback reason when no rewrite is applied.

### Step 7.3: Promote to gated run

Only after corpus health passes and smoke traces are valid:

```sh
npm run eval:replay -- --set qa-v1-2026-06 --strategy chunk_hybrid --rewrite-mode entity_expansion --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
```

Compare rewrite vs non-rewrite on:

- Overall Recall@5, Recall@10, MRR, NDCG@10.
- Entity-heavy slices.
- YouTube transcript slices.
- Long-context slices.

## Task 8: Exercise Rerank Cache and Cloudflare Rerank

**Problem:** Rerank cache diagnostics currently return no rows. The table and adapter contract exist, but no rerank eval has populated cache entries.

**Files:**

- `scripts/rag-eval-lib.mjs`
- `scripts/rag-eval-replay.mjs`
- `supabase/sql/20260608_rag_eval_rerank_cache.sql`

### Step 8.1: Confirm environment

Confirm these are available in the eval environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_AUTH_TOKEN`

The adapter endpoint is:

```text
https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/baai/bge-reranker-base
```

Request shape:

```json
{
  "query": "question text",
  "contexts": [
    { "text": "candidate context text" }
  ]
}
```

Map Cloudflare result indexes back to the original candidate array, preserving candidate metadata.

### Step 8.2: Run rerank smoke

Run:

```sh
npm run eval:rerank -- --set qa-v1-2026-06 --max-cases 5 --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason rerank_cache_smoke
```

Then run the same command again. The second run should have cache hits.

### Step 8.3: Validate cache diagnostics

Run:

```sql
\i supabase/sql/20260608_rag_eval_rerank_cache.sql
```

Expected:

- `rag_eval_rerank_cache` rows exist.
- `cache_key` uniqueness prevents duplicates.
- The second smoke run records cache hit metadata.
- No stale cache entries are used after changing model, chunking version, context hash, or strategy.

### Step 8.4: Promote to gated rerank run

Only after corpus health passes and smoke cache behavior is correct:

```sh
npm run eval:rerank -- --set qa-v1-2026-06 --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
```

Compare rerank against `chunk_hybrid` and `entity_expanded_chunk`.

## Task 9: Run Generation Eval in Two Explicit Modes

**Problem:** Generation eval table exists but has no rows. The plan must prevent primary-article context from hiding retrieval failures.

**Files:**

- `scripts/rag-eval-generate-answers.mjs`
- `scripts/rag-eval-judge-answers.mjs`
- `supabase/sql/20260608_rag_generation_eval.sql`

### Step 9.1: Run inline article generation smoke

This mode evaluates answer generation with production-like primary article context. It does not validate retrieval quality.

```sh
npm run eval:generate-answers -- --set qa-v1-2026-06 --mode inline_article_generation_eval --max-cases 5 --context-pack-version answer-question-v1-prefer-analysis --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason generation_smoke
npm run eval:judge-answers -- --set qa-v1-2026-06 --mode inline_article_generation_eval --max-cases 5
```

### Step 9.2: Run corpus retrieval generation smoke

This mode evaluates retrieval plus generation and can expose retrieval failures.

```sh
npm run eval:generate-answers -- --set qa-v1-2026-06 --mode corpus_retrieval_generation_eval --retrieval-strategy chunk_hybrid --max-cases 5 --chunking-version paragraph-window-v1-2026-06-02 --context-pack-version answer-question-v1-prefer-analysis --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason generation_smoke
npm run eval:judge-answers -- --set qa-v1-2026-06 --mode corpus_retrieval_generation_eval --retrieval-strategy chunk_hybrid --max-cases 5
```

### Step 9.3: Validate generation schema

Run:

```sql
\i supabase/sql/20260608_rag_generation_eval.sql
```

Expected:

- `rag_generation_eval_results` rows exist.
- `context_text` is present for replayability unless a normalized child table is introduced.
- `context_pack_version = 'answer-question-v1-prefer-analysis'`.
- Judge scores include groundedness, answer correctness, citation support, and refusal quality where applicable.

### Step 9.4: Promote after retrieval gate

Only after retrieval strategy selection has a valid run:

```sh
npm run eval:generate-answers -- --set qa-v1-2026-06 --mode corpus_retrieval_generation_eval --retrieval-strategy <selected_strategy> --chunking-version paragraph-window-v1-2026-06-02 --context-pack-version answer-question-v1-prefer-analysis --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
npm run eval:judge-answers -- --set qa-v1-2026-06 --mode corpus_retrieval_generation_eval --retrieval-strategy <selected_strategy>
```

Do not promote inline-only generation scores as retrieval evidence.

## Task 10: Run Agentic Eval Behind Gates

**Problem:** Agentic trace table exists but has no rows. Agentic RAG is designed behind gates, not shipped as a validated production path.

**Files:**

- `scripts/rag-agentic-runtime.mjs`
- `scripts/rag-agentic-eval-replay.mjs`
- `supabase/sql/20260608_agentic_rag_eval_trace.sql`

### Step 10.1: Run a smoke agentic eval

```sh
npm run eval:agentic -- --set qa-v1-2026-06 --max-cases 5 --retrieval-strategy chunk_hybrid --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason agentic_smoke
```

### Step 10.2: Validate trace diagnostics

Run:

```sql
\i supabase/sql/20260608_agentic_rag_eval_trace.sql
```

Expected:

- One trace row per evaluated case.
- Each trace records decision steps, tool calls, loop count, final retrieval strategy, final answer status, and failure reason.
- No pass/fail language for any agentic decision slice with `n < 5`.
- Loop safety diagnostics return no runaway cases.

### Step 10.3: Promote only after prerequisites

Run a valid agentic eval only when all are true:

- Corpus health passes.
- Non-agentic selected retrieval strategy has a valid baseline.
- Query rewrite and rerank behavior are either disabled or separately validated.
- Agentic traces from smoke mode show stable loop behavior.

Then run:

```sh
npm run eval:agentic -- --set qa-v1-2026-06 --retrieval-strategy <selected_strategy> --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection true
```

## Task 11: Documentation Updates After Valid Runs

**Problem:** Docs must avoid implying release-grade validation before corpus health and fresh metric-fixed replay are complete.

**Files:**

- `docs/superpowers/rag-retrieval-refinement-progress.md`
- `docs/project-interview-resume-brief.md`
- `docs/instructions.md`
- `supabase/sql/results.md`

### Step 11.1: Update progress doc

Add a section with:

- Latest corpus-health run id.
- Whether `ready_for_replay` is true.
- Current replay validity status.
- Metric fix note: article-level metrics de-duplicate repeated chunks from the same article.
- Which eval paths are smoke-only vs valid for strategy selection.

### Step 11.2: Update resume brief only after valid replay

Keep wording as historical until valid replay exists:

```text
Leading historical offline baseline, pending metric-fixed replay and corpus-health preflight.
```

After valid replay, replace with:

```text
Metric-fixed, corpus-health-gated offline baseline.
```

Only name a production candidate if:

- Fresh replay is valid for strategy selection.
- Metric-bound diagnostics return no rows.
- Slice support is adequate or caveated.
- Generation eval does not expose severe groundedness/citation regressions.

### Step 11.3: Refresh `supabase/sql/results.md`

After each SQL rerun, append a dated subsection:

```md
## 2026-06-08 Remediation Rerun

- corpus_health_run_id:
- ready_for_replay:
- zero_chunk_gold_articles:
- stale_source_count:
- valid eval_run_ids:
- smoke eval_run_ids:
- metric-bound diagnostic:
- notes:
```

## Acceptance Criteria

The remediation is complete when all of these are true:

- `npm test` passes.
- Article-level metrics cannot produce Recall/NDCG above 1 due to duplicate chunks from the same article.
- Corpus health returns `ready_for_replay = true` for `qa-v1-2026-06`, `paragraph-window-v1-2026-06-02`, and `@cf/baai/bge-m3`.
- Fresh retrieval replay runs are marked `valid_for_strategy_selection = true` with a real `corpus_health_run_id`.
- Taxonomy diagnostics use latest runs and label small slices as directional.
- Hard negatives remain grade 0 and only approved human-reviewed candidates are included in leaderboard eval.
- Query rewrite diagnostics contain real trace rows after smoke replay.
- Rerank cache contains real entries and the second smoke run records cache hits.
- Generation eval rows exist for both `inline_article_generation_eval` and `corpus_retrieval_generation_eval`.
- Agentic trace rows exist from smoke mode and no pass/fail language is used for slices with `n < 5`.
- Docs distinguish historical baseline, smoke runs, and release-grade strategy truth.

## Rollback Plan

If any fresh replay produces worse or invalid results:

1. Keep the run in `rag_eval_runs` with `valid_for_strategy_selection = false`.
2. Set `invalid_reason` in notes to the specific failure, such as `metric_bound_failed`, `chunk_corpus_health_failed`, `rerank_cache_failed`, or `generation_groundedness_regression`.
3. Do not delete historical rows unless they contain sensitive data or corrupt schema.
4. Revert only the code change that caused the failure, not unrelated user edits.
5. Re-run corpus health and metric-bound diagnostics before attempting another valid replay.
