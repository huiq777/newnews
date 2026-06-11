# Generation Grouping And Answer Question Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the selected `chunk_dense @cf/baai/bge-m3` generation benchmark to one complete 21-case retrieval run, then prepare a feature-flagged `answer-question` rollout that can fall back to the current `match_articles_prefer_analysis` path.

**Architecture:** Phase 1 makes generation eval run-level precise by binding corpus generation to a single source retrieval `rag_eval_runs.id`, then reporting generation quality by generation eval run instead of aggregate mode/strategy. Phase 2 introduces a production retrieval switch in `answer-question` with default-off flags, stable canary selection, production chunk RPC isolation, trace comparison, and immediate rollback to the current article-level dense retriever.

**Tech Stack:** Node eval CLIs, Supabase/Postgres SQL, PostgREST service-role writes, Supabase Edge Function TypeScript/Deno, Cloudflare Workers AI BGE-M3 embeddings via OpenAI-compatible endpoint, existing `rag_retrieval_runs` and `rag_generation_eval_results` trace tables.

---

## Current Anchors

- Selected retrieval eval run: `8ba5bdac-88a7-4f7b-8058-1648c734cc33`
- Passing corpus-health run: `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`
- Eval set: `qa-v1-2026-06`
- Chunking version: `paragraph-window-v1-2026-06-02`
- Embedding model: `@cf/baai/bge-m3`
- Selected retrieval strategy label in results: `chunk_dense_dense_query_embedding_article_similarity`
- Current generation aggregate ambiguity: `corpus_retrieval_generation_eval` + `chunk_dense` has `24` judged rows, while the selected retrieval run has `21` cases.
- Production fallback retriever: `match_articles_prefer_analysis`

## File Responsibility Map

- `supabase/sql/20260610_rag_generation_eval_grouping.sql`: Read-only run-level generation diagnostics. Identifies latest complete 21-case generation run, verifies it is bound to the selected retrieval eval run, and exposes incomplete/mixed runs.
- `scripts/rag-eval-generate-answers.mjs`: Adds `--source-eval-run-id` so corpus generation uses retrieval runs from `rag_eval_case_results` for one selected retrieval eval run.
- `scripts/rag-eval-judge-answers.mjs`: Adds `--eval-run-id` so judging targets one generation eval run instead of every unjudged row matching mode/strategy.
- `tests/rag-generation-eval.test.mjs`: Adds regex and import-level tests for source-run binding, run-scoped judging, and run-level diagnostic SQL.
- `supabase/sql/20260610_answer_question_chunk_retrieval.sql`: Production-safe chunk retrieval RPC for `answer-question`; separate from eval-named RPC even if it shares the same ranking semantics.
- `supabase/functions/answer-question/index.ts`: Adds feature flag selection, chunk-dense BGE retrieval path, article-dense fallback, trace metadata, and rollback-safe defaults.
- `tests/answer-question-rollout.test.mjs`: Verifies default-off behavior, fallback RPC preservation, chunk RPC branch, trace metadata, and canary flags.
- `supabase/sql/20260610_answer_question_rollout_diagnostics.sql`: Production canary diagnostics comparing article-dense vs chunk-dense traces by latency, errors, empty results, fallback rate, feedback, and context size.
- `docs/superpowers/rag-retrieval-refinement-progress.md`: Records the locked generation run and rollout gate status.
- `docs/current-state.md`: Updates the handoff once the generation run is locked and again after production rollout, with production behavior explicitly named.
- `docs/project-interview-resume-brief.md`: Updates metrics only after the 21-case generation run is locked.
- `docs/instructions.md`: Adds operational commands for generation grouping, canary monitoring, and rollback.
- `supabase/sql/results.md`: Records the final generation-run ledger and canary ledger.

## Phase 1: Lock Generation Eval To One Retrieval Run

### Task 1: Add Run-Level Generation Diagnostics SQL

**Files:**
- Create: `supabase/sql/20260610_rag_generation_eval_grouping.sql`
- Modify: `tests/rag-generation-eval.test.mjs`

- [ ] **Step 1: Write the failing SQL coverage test**

Append this test to `tests/rag-generation-eval.test.mjs`:

```js
test('generation grouping SQL finds complete source-bound 21-case runs', () => {
  const sql = readFileSync('supabase/sql/20260610_rag_generation_eval_grouping.sql', 'utf8')

  assert.match(sql, /selected_retrieval_eval_run/)
  assert.match(sql, /8ba5bdac-88a7-4f7b-8058-1648c734cc33/)
  assert.match(sql, /selected_retrieval_bound_rows/)
  assert.match(sql, /latest_complete_generation_run/)
  assert.match(sql, /complete_selected_retrieval_bound/)
  assert.match(sql, /mixed_or_unbound_generation_run/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test
```

Expected: this new test fails because `supabase/sql/20260610_rag_generation_eval_grouping.sql` does not exist.

- [ ] **Step 3: Create the diagnostic SQL**

Create `supabase/sql/20260610_rag_generation_eval_grouping.sql` with this content:

```sql
-- 20260610 - Generation eval run grouping and source retrieval binding.
--
-- Purpose:
-- 1. Find whether a complete 21-case corpus generation eval exists for the
--    selected chunk_dense retrieval eval run.
-- 2. Prevent aggregate 24-row generation summaries from being quoted as a
--    locked benchmark.

with selected_retrieval_eval_run as (
  select
    r.id,
    r.eval_set_id,
    r.retrieval_strategy,
    r.created_at,
    m.total_cases
  from public.rag_eval_runs r
  join public.rag_eval_retrieval_metrics m on m.eval_run_id = r.id
  where r.id = '8ba5bdac-88a7-4f7b-8058-1648c734cc33'::uuid
),
selected_retrieval_cases as (
  select
    cr.case_id,
    cr.retrieval_run_id
  from public.rag_eval_case_results cr
  join selected_retrieval_eval_run sr on sr.id = cr.eval_run_id
),
generation_by_run as (
  select
    g.eval_run_id as generation_eval_run_id,
    er.created_at as generation_created_at,
    er.runner_version,
    er.retrieval_strategy as generation_runner_strategy,
    count(*) as result_rows,
    count(distinct g.case_id) as distinct_cases,
    count(*) filter (
      where g.faithfulness_score is not null
        and g.answer_relevancy_score is not null
        and g.context_precision_score is not null
        and g.context_recall_score is not null
    ) as judged_rows,
    count(*) filter (where g.generation_eval_mode = 'corpus_retrieval_generation_eval') as corpus_mode_rows,
    count(*) filter (where g.metadata->>'retrieval_strategy' = 'chunk_dense') as chunk_dense_metadata_rows,
    count(*) filter (where g.retrieval_run_id is not null) as rows_with_retrieval_run_id,
    count(*) filter (
      where src.case_id is not null
        and src.retrieval_run_id = g.retrieval_run_id
    ) as selected_retrieval_bound_rows,
    min(g.created_at) as first_result_at,
    max(g.created_at) as last_result_at,
    avg(g.faithfulness_score) as avg_faithfulness,
    avg(g.answer_relevancy_score) as avg_answer_relevancy,
    avg(g.context_precision_score) as avg_context_precision,
    avg(g.context_recall_score) as avg_context_recall
  from public.rag_generation_eval_results g
  join public.rag_eval_runs er on er.id = g.eval_run_id
  left join selected_retrieval_cases src on src.case_id = g.case_id
  where g.generation_eval_mode = 'corpus_retrieval_generation_eval'
    and g.context_pack_version = 'answer-question-v1-prefer-analysis'
    and coalesce(g.metadata->>'retrieval_strategy', '') in ('chunk_dense', 'chunk_dense_dense_query_embedding_article_similarity')
  group by g.eval_run_id, er.created_at, er.runner_version, er.retrieval_strategy
),
classified_generation_runs as (
  select
    generation_eval_run_id,
    generation_created_at,
    runner_version,
    generation_runner_strategy,
    result_rows,
    distinct_cases,
    judged_rows,
    corpus_mode_rows,
    chunk_dense_metadata_rows,
    rows_with_retrieval_run_id,
    selected_retrieval_bound_rows,
    first_result_at,
    last_result_at,
    avg_faithfulness,
    avg_answer_relevancy,
    avg_context_precision,
    avg_context_recall,
    case
      when distinct_cases = 21
        and judged_rows = 21
        and result_rows = 21
        and selected_retrieval_bound_rows = 21
        then 'complete_selected_retrieval_bound'
      when distinct_cases = 21
        and judged_rows = 21
        and result_rows = 21
        and selected_retrieval_bound_rows < 21
        then 'complete_but_not_selected_retrieval_bound'
      when result_rows > 21
        then 'mixed_or_unbound_generation_run'
      when judged_rows < distinct_cases
        then 'incomplete_judging'
      else 'incomplete_generation_run'
    end as generation_run_status
  from generation_by_run
),
latest_complete_generation_run as (
  select *
  from classified_generation_runs
  where generation_run_status = 'complete_selected_retrieval_bound'
  order by generation_created_at desc
  limit 1
)
select
  'all_generation_runs' as report_section,
  generation_eval_run_id,
  generation_created_at,
  runner_version,
  generation_runner_strategy,
  result_rows,
  distinct_cases,
  judged_rows,
  corpus_mode_rows,
  chunk_dense_metadata_rows,
  rows_with_retrieval_run_id,
  selected_retrieval_bound_rows,
  avg_faithfulness,
  avg_answer_relevancy,
  avg_context_precision,
  avg_context_recall,
  generation_run_status
from classified_generation_runs
order by generation_created_at desc;

select
  'latest_complete_generation_run' as report_section,
  generation_eval_run_id,
  generation_created_at,
  result_rows,
  distinct_cases,
  judged_rows,
  selected_retrieval_bound_rows,
  avg_faithfulness,
  avg_answer_relevancy,
  avg_context_precision,
  avg_context_recall,
  generation_run_status
from latest_complete_generation_run;
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Run the SQL in Supabase**

Run:

```sql
\i supabase/sql/20260610_rag_generation_eval_grouping.sql
```

Expected:

- If a row appears in `latest_complete_generation_run`, record that `generation_eval_run_id` in `supabase/sql/results.md`.
- If no row appears in `latest_complete_generation_run`, continue to Task 2 and rerun generation bound to the selected retrieval eval run.

- [ ] **Step 6: Commit**

```bash
git add supabase/sql/20260610_rag_generation_eval_grouping.sql tests/rag-generation-eval.test.mjs
git commit -m "test: add generation eval grouping diagnostics"
```

### Task 2: Bind Corpus Generation To The Selected Retrieval Eval Run

**Files:**
- Modify: `scripts/rag-eval-generate-answers.mjs`
- Modify: `tests/rag-generation-eval.test.mjs`

- [ ] **Step 1: Write failing tests for source-run binding**

Append these assertions to the existing `generation eval scripts expose capped budget-aware generation and judging modes` test in `tests/rag-generation-eval.test.mjs`:

```js
  assert.match(generate, /--source-eval-run-id/)
  assert.match(generate, /sourceEvalRunId/)
  assert.match(generate, /loadSourceRetrievalBindings/)
  assert.match(generate, /rag_eval_case_results\?eval_run_id=eq/)
  assert.match(generate, /source_retrieval_eval_run_id/)
  assert.match(generate, /source_retrieval_binding: 'rag_eval_case_results'/)
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test
```

Expected: the generation eval test fails because the generator does not yet support `--source-eval-run-id`.

- [ ] **Step 3: Add the CLI argument and notes metadata**

In `scripts/rag-eval-generate-answers.mjs`, update the CLI comment:

```js
// CLI flags: --max-cases, --dry-run-budget, --mode, --context-pack-version, --retrieval-strategy, --source-eval-run-id, --chunking-version, --corpus-health-run-id, --valid-for-strategy-selection, --invalid-reason.
```

Add this after `retrievalStrategy`:

```js
  const sourceEvalRunId = args['source-eval-run-id'] ? String(args['source-eval-run-id']) : null
```

Update `buildEvalRunNotes({ existing })`:

```js
    existing: {
      generation_eval_mode: generationEvalMode,
      context_pack_version: contextPackVersion,
      retrieval_strategy: retrievalStrategy,
      source_retrieval_eval_run_id: sourceEvalRunId,
      source_retrieval_binding: sourceEvalRunId ? 'rag_eval_case_results' : 'latest_retrieval_trace_by_case',
      chunking_version: chunkingVersion,
    },
```

Add this validation after generation mode validation:

```js
  if (generationEvalMode === 'corpus_retrieval_generation_eval' && validForStrategySelection && !sourceEvalRunId) {
    throw new Error('--source-eval-run-id is required for valid corpus_retrieval_generation_eval runs')
  }
```

- [ ] **Step 4: Load source retrieval bindings before selecting cases**

Replace the current eval-case fetch section:

```js
  const cases = await restSelect(env, `rag_eval_cases?eval_set_id=eq.${evalSet.id}&select=*&order=created_at.asc&limit=${maxCases}`)
```

with:

```js
  const sourceBindings = sourceEvalRunId
    ? await loadSourceRetrievalBindings(env, sourceEvalRunId)
    : null
  const sourceCaseIds = sourceBindings ? [...sourceBindings.keys()] : []
  const casePath = sourceBindings
    ? `rag_eval_cases?id=in.(${sourceCaseIds.join(',')})&select=*`
    : `rag_eval_cases?eval_set_id=eq.${evalSet.id}&select=*&order=created_at.asc&limit=${maxCases}`
  const rawCases = await restSelect(env, casePath)
  const casesById = new Map(rawCases.map(row => [row.id, row]))
  const cases = sourceBindings
    ? sourceCaseIds.map(id => casesById.get(id)).filter(Boolean).slice(0, maxCases)
    : rawCases
```

- [ ] **Step 5: Pass source bindings into corpus context packing**

Replace:

```js
      : await buildCorpusRetrievalContextPack(env, evalCase, { retrievalStrategy })
```

with:

```js
      : await buildCorpusRetrievalContextPack(env, evalCase, { retrievalStrategy, sourceBindings, sourceEvalRunId })
```

Update result metadata:

```js
        source_retrieval_eval_run_id: sourceEvalRunId,
        source_retrieval_binding: sourceEvalRunId ? 'rag_eval_case_results' : 'latest_retrieval_trace_by_case',
```

- [ ] **Step 6: Add source binding helpers**

Add these functions above `buildInlineArticleContextPack`:

```js
async function loadSourceRetrievalBindings(env, sourceEvalRunId) {
  const rows = await restSelect(
    env,
    `rag_eval_case_results?eval_run_id=eq.${encodeURIComponent(sourceEvalRunId)}&select=case_id,retrieval_run_id,created_at&order=created_at.asc`
  )
  if (rows.length === 0) {
    throw new Error(`No rag_eval_case_results rows found for --source-eval-run-id ${sourceEvalRunId}`)
  }
  return new Map(rows.map(row => [row.case_id, row.retrieval_run_id]))
}

function requireSourceRetrievalRunId(evalCase, sourceBindings, sourceEvalRunId) {
  if (!sourceBindings) return null
  const retrievalRunId = sourceBindings.get(evalCase.id)
  if (!retrievalRunId) {
    throw new Error(`Case ${evalCase.id} is missing retrieval_run_id for source eval run ${sourceEvalRunId}`)
  }
  return retrievalRunId
}
```

- [ ] **Step 7: Bind corpus context to the source retrieval run**

Replace `buildCorpusRetrievalContextPack` with:

```js
async function buildCorpusRetrievalContextPack(env, evalCase, options = {}) {
  const { retrievalStrategy = null, sourceBindings = null, sourceEvalRunId = null } = options
  const sourceRetrievalRunId = requireSourceRetrievalRunId(evalCase, sourceBindings, sourceEvalRunId)
  const latestRetrieval = sourceRetrievalRunId
    ? { id: sourceRetrievalRunId }
    : (await restSelect(
        env,
        `rag_retrieval_runs?query_input->>eval_case_id=eq.${evalCase.id}${retrievalStrategy ? `&retrieval_strategy=ilike.*${encodeURIComponent(retrievalStrategy)}*` : ''}&select=id&order=created_at.desc&limit=1`
      ))[0]
  const candidates = latestRetrieval
    ? await restSelect(env, `rag_retrieval_candidates?retrieval_run_id=eq.${latestRetrieval.id}&select=article_id,chunk_id,title,summary_excerpt&order=rank.asc&limit=10`)
    : []
  return buildContextPack(candidates.map(row => [row.title, row.summary_excerpt].filter(Boolean).join('\n')).join('\n\n'), {
    article_ids: candidates.map(row => row.article_id).filter(Boolean),
    chunk_ids: candidates.map(row => row.chunk_id).filter(Boolean),
    retrieval_run_id: latestRetrieval?.id || null,
  })
}
```

- [ ] **Step 8: Print the generation eval run id**

After creating `evalRun`, add:

```js
  console.log(JSON.stringify({
    event: 'generation_eval_run_created',
    eval_run_id: evalRun.id,
    generation_eval_mode: generationEvalMode,
    retrieval_strategy: retrievalStrategy,
    source_retrieval_eval_run_id: sourceEvalRunId,
    max_cases: maxCases,
    valid_for_strategy_selection: validForStrategySelection,
  }))
```

- [ ] **Step 9: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add scripts/rag-eval-generate-answers.mjs tests/rag-generation-eval.test.mjs
git commit -m "feat: bind generation eval to source retrieval runs"
```

### Task 3: Scope Judging To One Generation Eval Run

**Files:**
- Modify: `scripts/rag-eval-judge-answers.mjs`
- Modify: `tests/rag-generation-eval.test.mjs`

- [ ] **Step 1: Write failing test assertions**

Append these assertions to the generation script test:

```js
  assert.match(judge, /--eval-run-id/)
  assert.match(judge, /evalRunId/)
  assert.match(judge, /eval_run_id=eq/)
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test
```

Expected: tests fail because `--eval-run-id` is not implemented in the judge script.

- [ ] **Step 3: Add `--eval-run-id` to the judge script**

In `scripts/rag-eval-judge-answers.mjs`, update the CLI comment:

```js
// CLI flags: --max-cases, --dry-run-budget, --mode, --retrieval-strategy, --eval-run-id.
```

Add this after `retrievalStrategy`:

```js
  const evalRunId = args['eval-run-id'] ? String(args['eval-run-id']) : null
```

Add this filter before the mode filter:

```js
  if (evalRunId) resultFilters.unshift(`eval_run_id=eq.${encodeURIComponent(evalRunId)}`)
```

Update the budget notes `existing` object:

```js
    existing: {
      generation_eval_run_id: evalRunId,
      generation_eval_mode: generationEvalMode,
      retrieval_strategy: retrievalStrategy,
    },
```

- [ ] **Step 4: Print judged row count**

After `const rows = await restSelect(...)`, add:

```js
  console.log(JSON.stringify({
    event: 'generation_eval_judge_rows_selected',
    eval_run_id: evalRunId,
    generation_eval_mode: generationEvalMode,
    retrieval_strategy: retrievalStrategy,
    row_count: rows.length,
  }))
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/rag-eval-judge-answers.mjs tests/rag-generation-eval.test.mjs
git commit -m "feat: scope generation judging by eval run"
```

### Task 4: Lock Or Re-run The 21-Case Generation Benchmark

**Files:**
- Modify: `supabase/sql/results.md`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`
- Modify: `docs/current-state.md`
- Modify: `docs/project-interview-resume-brief.md`

- [ ] **Step 1: Run grouping SQL**

Run:

```sql
\i supabase/sql/20260610_rag_generation_eval_grouping.sql
```

If `latest_complete_generation_run` returns a row with `generation_run_status = 'complete_selected_retrieval_bound'`, skip to Step 5.

- [ ] **Step 2: Generate answers bound to the selected retrieval run if no complete row exists**

Run:

```bash
npm run eval:generate-answers -- \
  --set qa-v1-2026-06 \
  --mode corpus_retrieval_generation_eval \
  --retrieval-strategy chunk_dense \
  --source-eval-run-id 8ba5bdac-88a7-4f7b-8058-1648c734cc33 \
  --max-cases 21 \
  --chunking-version paragraph-window-v1-2026-06-02 \
  --context-pack-version answer-question-v1-prefer-analysis \
  --corpus-health-run-id 54dcd974-2fa2-4fb7-bb62-6eae9f3880c0 \
  --valid-for-strategy-selection true
```

Expected output includes:

```json
{"event":"generation_eval_run_created","source_retrieval_eval_run_id":"8ba5bdac-88a7-4f7b-8058-1648c734cc33","max_cases":21,"valid_for_strategy_selection":true}
```

Record the printed `eval_run_id`.

- [ ] **Step 3: Judge only that generation eval run**

Set `GENERATION_EVAL_RUN_ID` to the `eval_run_id` printed by Step 2, then run:

```bash
test -n "$GENERATION_EVAL_RUN_ID"
npm run eval:judge-answers -- \
  --mode corpus_retrieval_generation_eval \
  --retrieval-strategy chunk_dense \
  --eval-run-id "$GENERATION_EVAL_RUN_ID" \
  --max-cases 21
```

Expected output includes:

```json
{"event":"generation_eval_judge_rows_selected","row_count":21}
```

- [ ] **Step 4: Re-run grouping SQL**

Run:

```sql
\i supabase/sql/20260610_rag_generation_eval_grouping.sql
```

Expected: `latest_complete_generation_run` returns exactly one row with:

- `result_rows = 21`
- `distinct_cases = 21`
- `judged_rows = 21`
- `selected_retrieval_bound_rows = 21`
- `generation_run_status = 'complete_selected_retrieval_bound'`

- [ ] **Step 5: Update result docs with locked generation run**

In `supabase/sql/results.md`, replace the current 24-row aggregate interpretation with a locked generation table copied from the `latest_complete_generation_run` SQL result. Use this exact column order:

```md
Current locked generation eval:

| generation_eval_run_id | source_retrieval_eval_run_id | mode | retrieval_strategy | cases | faithfulness | answer_relevancy | context_precision | context_recall | status |
|---|---|---|---|---:|---:|---:|---:|---:|---|
```

Before committing, confirm the table has one data row and every metric cell contains a numeric value from SQL output.

Remove or demote the 24-row aggregate to a historical note:

```md
Historical aggregate note: an earlier `chunk_dense` generation aggregate had 24 judged rows across mode/strategy grouping. It is retained as a diagnostic but is no longer the quoted benchmark.
```

- [ ] **Step 6: Update progress docs**

In `docs/superpowers/rag-retrieval-refinement-progress.md`, change the generation eval table to quote the locked 21-case run. Keep the current retrieval table unchanged except replace `selected production candidate` with `selected rollout candidate`.

In `docs/current-state.md`, update the 2026-06-09 paragraph so the generation sentence says the run is locked to 21 judged cases and includes the four numeric metric values from `latest_complete_generation_run`: faithfulness, answer relevancy, context precision, and context recall.

In `docs/project-interview-resume-brief.md`, replace the generation bullet with the same 21-case locked values.

- [ ] **Step 7: Verify docs and tests**

Run:

```bash
npm test
rg -n "24 judged rows|selected production candidate" docs supabase/sql/results.md
```

Expected:

- `npm test` passes.
- `rg` only returns historical notes that explicitly say the 24-row aggregate is no longer the quoted benchmark.
- `selected production candidate` no longer appears.

- [ ] **Step 8: Commit**

```bash
git add \
  supabase/sql/results.md \
  docs/superpowers/rag-retrieval-refinement-progress.md \
  docs/current-state.md \
  docs/project-interview-resume-brief.md
git commit -m "docs: lock generation eval to selected retrieval run"
```

## Phase 2: Feature-Flagged `answer-question` Rollout

### Task 5: Create Production Chunk Retrieval RPC

**Files:**
- Create: `supabase/sql/20260610_answer_question_chunk_retrieval.sql`
- Create: `tests/answer-question-rollout.test.mjs`

- [ ] **Step 1: Write failing SQL test**

Create `tests/answer-question-rollout.test.mjs`:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('answer-question chunk retrieval SQL creates production-safe service-role RPC', () => {
  const sql = readFileSync('supabase/sql/20260610_answer_question_chunk_retrieval.sql', 'utf8')

  assert.match(sql, /create or replace function public\.match_answer_question_chunks/)
  assert.match(sql, /embedding_model_filter text default '@cf\/baai\/bge-m3'/)
  assert.match(sql, /article_chunks/)
  assert.match(sql, /chunk_overfetch_multiplier/)
  assert.match(sql, /revoke all on function public\.match_answer_question_chunks/)
  assert.match(sql, /grant execute on function public\.match_answer_question_chunks/)
  assert.doesNotMatch(sql, /grant execute on function public\.match_answer_question_chunks[\s\S]*authenticated/)
})
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test
```

Expected: test fails because the SQL file does not exist.

- [ ] **Step 3: Create the production RPC**

Create `supabase/sql/20260610_answer_question_chunk_retrieval.sql`:

```sql
-- 20260610 - Production-safe chunk retrieval RPC for answer-question.
--
-- This does not enable chunk retrieval by itself. The Edge Function must opt
-- in behind feature flags and can fall back to match_articles_prefer_analysis.

create extension if not exists vector;

create or replace function public.match_answer_question_chunks(
  query_embedding vector(1024),
  match_count integer default 4,
  chunking_version_filter text default 'paragraph-window-v1-2026-06-02',
  chunk_overfetch_multiplier integer default 5,
  embedding_model_filter text default '@cf/baai/bge-m3'
)
returns table (
  chunk_id uuid,
  article_id uuid,
  title text,
  summary text,
  summary_en text,
  summary_zh text,
  article_content text,
  chunk_text text,
  chunk_index integer,
  chunk_rank integer,
  article_rank integer,
  score_dense double precision,
  embedding_source text,
  metadata jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with chunk_matches as (
    select
      c.id as chunk_id,
      c.article_id,
      c.chunk_text,
      c.chunk_index,
      c.chunking_version,
      c.token_estimate,
      c.language,
      1 - (c.embedding <=> query_embedding) as score_dense,
      row_number() over (order by c.embedding <=> query_embedding, c.id) as chunk_rank
    from public.article_chunks c
    where c.embedding is not null
      and c.embedding_model = embedding_model_filter
      and (chunking_version_filter is null or c.chunking_version = chunking_version_filter)
    order by c.embedding <=> query_embedding, c.id
    limit greatest(match_count * greatest(chunk_overfetch_multiplier, 1), match_count, 1)
  ),
  article_best as (
    select
      cm.*,
      row_number() over (
        partition by cm.article_id
        order by cm.score_dense desc, cm.chunk_rank asc
      ) as per_article_rank
    from chunk_matches cm
  ),
  deduped as (
    select
      ab.*,
      row_number() over (order by ab.score_dense desc, ab.chunk_rank asc) as article_rank
    from article_best ab
    where ab.per_article_rank = 1
  )
  select
    d.chunk_id,
    d.article_id,
    coalesce(n.title, n.title_zh, n.title_en, '') as title,
    n.summary,
    n.summary_en,
    n.summary_zh,
    n.article_content,
    d.chunk_text,
    d.chunk_index,
    d.chunk_rank::integer,
    d.article_rank::integer,
    d.score_dense,
    'answer_question_chunk_dense_bge_m3'::text as embedding_source,
    jsonb_build_object(
      'retrieval_path', 'answer_question_chunk_dense_bge_m3',
      'chunking_version', d.chunking_version,
      'embedding_model', embedding_model_filter,
      'token_estimate', d.token_estimate,
      'language', d.language
    ) as metadata
  from deduped d
  join public.daily_news n on n.id = d.article_id
  order by d.article_rank asc
  limit greatest(match_count, 1);
$$;

revoke all on function public.match_answer_question_chunks(vector(1024), integer, text, integer, text) from public;
grant execute on function public.match_answer_question_chunks(vector(1024), integer, text, integer, text) to service_role;
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Apply SQL in Supabase**

Run:

```sql
\i supabase/sql/20260610_answer_question_chunk_retrieval.sql
```

Then run a smoke query with a known 1024-dim BGE vector from eval tooling if available. The function should return rows with `embedding_source = 'answer_question_chunk_dense_bge_m3'`.

- [ ] **Step 6: Commit**

```bash
git add supabase/sql/20260610_answer_question_chunk_retrieval.sql tests/answer-question-rollout.test.mjs
git commit -m "feat: add answer-question chunk retrieval rpc"
```

### Task 6: Add Default-Off Feature Flag Selection

**Files:**
- Modify: `supabase/functions/answer-question/index.ts`
- Modify: `tests/answer-question-rollout.test.mjs`

- [ ] **Step 1: Write failing source assertions**

Append to `tests/answer-question-rollout.test.mjs`:

```js
test('answer-question rollout flags default to article dense retrieval', () => {
  const source = readFileSync('supabase/functions/answer-question/index.ts', 'utf8')

  assert.match(source, /ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED/)
  assert.match(source, /ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT/)
  assert.match(source, /ANSWER_QUESTION_CHUNK_RETRIEVAL_USER_ALLOWLIST/)
  assert.match(source, /selectRetrieverMode/)
  assert.match(source, /article_dense_prefer_analysis/)
  assert.match(source, /chunk_dense_bge_m3/)
  assert.match(source, /match_articles_prefer_analysis/)
})
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test
```

Expected: test fails because the flags and selection helper are not implemented.

- [ ] **Step 3: Add retriever mode types and helpers**

In `supabase/functions/answer-question/index.ts`, add after `type RelatedArticleCandidate`:

```ts
type RetrieverMode = 'article_dense_prefer_analysis' | 'chunk_dense_bge_m3'

type RetrieverSelection = {
  mode: RetrieverMode
  enabled: boolean
  rolloutPercent: number
  reason: string
}

function envBool(value: string | undefined, defaultValue = false): boolean {
  if (value == null || value === '') return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function envNumber(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

function stableBucket(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % 100
}

function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(String(raw || '').split(',').map(value => value.trim()).filter(Boolean))
}

function selectRetrieverMode(params: {
  userId: string | null
  requestId: string
  env: {
    chunkEnabled: string | undefined
    rolloutPercent: string | undefined
    allowlist: string | undefined
  }
}): RetrieverSelection {
  const enabled = envBool(params.env.chunkEnabled, false)
  const rolloutPercent = Math.max(0, Math.min(100, envNumber(params.env.rolloutPercent, 0)))
  const allowlist = parseAllowlist(params.env.allowlist)
  const identity = params.userId || params.requestId

  if (!enabled) {
    return { mode: 'article_dense_prefer_analysis', enabled, rolloutPercent, reason: 'flag_disabled' }
  }
  if (params.userId && allowlist.has(params.userId)) {
    return { mode: 'chunk_dense_bge_m3', enabled, rolloutPercent, reason: 'allowlist' }
  }
  if (rolloutPercent > 0 && stableBucket(identity) < rolloutPercent) {
    return { mode: 'chunk_dense_bge_m3', enabled, rolloutPercent, reason: 'rollout_percent' }
  }
  return { mode: 'article_dense_prefer_analysis', enabled, rolloutPercent, reason: 'not_in_canary' }
}
```

- [ ] **Step 4: Thread selection through `retrieve`**

Update `retrieve` signature:

```ts
  retrieverSelection: RetrieverSelection
```

Update the call in `orchestrateAnswer`:

```ts
  const retrieverSelection = selectRetrieverMode({
    userId: decision.userId,
    requestId,
    env: {
      chunkEnabled: Deno.env.get('ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED'),
      rolloutPercent: Deno.env.get('ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT'),
      allowlist: Deno.env.get('ANSWER_QUESTION_CHUNK_RETRIEVAL_USER_ALLOWLIST'),
    },
  })
```

Pass `retrieverSelection` into `retrieve`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass if only source assertions are present.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/answer-question/index.ts tests/answer-question-rollout.test.mjs
git commit -m "feat: add answer-question retriever rollout flags"
```

### Task 7: Implement Chunk-Dense Retrieval With Fallback

**Files:**
- Modify: `supabase/functions/answer-question/index.ts`
- Modify: `tests/answer-question-rollout.test.mjs`

- [ ] **Step 1: Write failing assertions for chunk path and fallback**

Append to `tests/answer-question-rollout.test.mjs`:

```js
test('answer-question chunk path calls BGE and falls back to article dense', () => {
  const source = readFileSync('supabase/functions/answer-question/index.ts', 'utf8')

  assert.match(source, /embedQueryWithBgeM3/)
  assert.match(source, /match_answer_question_chunks/)
  assert.match(source, /fallback_reason/)
  assert.match(source, /chunk_dense_failed_fell_back_to_article_dense/)
  assert.match(source, /retriever_selection_reason/)
  assert.match(source, /candidate_type: candidate\.candidateType/)
  assert.match(source, /chunk_id: candidate\.chunkId/)
})
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test
```

Expected: test fails because chunk retrieval and fallback are not implemented.

- [ ] **Step 3: Expand candidate and retrieval context types**

Update `RelatedArticleCandidate`:

```ts
type RelatedArticleCandidate = {
  id: string
  title: string
  summary: string
  score?: number | null
  embedding_source?: string | null
  candidateType?: 'article' | 'chunk'
  chunkId?: string | null
  chunkText?: string | null
  metadata?: Record<string, unknown>
}
```

Update `RetrievalContext`:

```ts
type RetrievalContext = {
  mainContext: string
  relatedContext: string
  injectedRelatedIds: string[]
  retrievalRunId: string | null
  ragSuccess: boolean
  retrieverMode: RetrieverMode
  fallbackReason: string | null
}
```

- [ ] **Step 4: Add BGE embed helper**

Add near `sha256Hex`:

```ts
function bgeEmbeddingsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '')
  return normalized.endsWith('/v1') ? `${normalized}/embeddings` : `${normalized}/v1/embeddings`
}

async function embedQueryWithBgeM3(question: string): Promise<number[]> {
  const baseUrl = Deno.env.get('BGE_EMBEDDING_BASE_URL')
  const apiKey = Deno.env.get('BGE_EMBEDDING_API_KEY')
  if (!baseUrl || !apiKey) throw new Error('Missing BGE_EMBEDDING_BASE_URL or BGE_EMBEDDING_API_KEY')

  const res = await fetch(bgeEmbeddingsUrl(baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: '@cf/baai/bge-m3',
      input: question,
    }),
  })
  if (!res.ok) throw new Error(`BGE embed ${res.status}: ${await res.text().catch(() => '')}`)
  const json = await res.json()
  const embedding = json.data?.[0]?.embedding
  if (!Array.isArray(embedding)) throw new Error('BGE embedding response missing data[0].embedding')
  return embedding
}
```

- [ ] **Step 5: Add article dense retrieval helper**

Extract the current Cohere + `match_articles_prefer_analysis` logic into:

```ts
async function retrieveArticleDenseCandidates(params: {
  question: string
  articleId: string
  sbHeaders: Record<string, string>
  env: { supabaseUrl: string; cohereApiKey: string }
  maxRelated: number
  requestId: string
}): Promise<RelatedArticleCandidate[]> {
  const cohereRes = await fetch('https://api.cohere.com/v1/embed', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${params.env.cohereApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'embed-english-v3.0', input_type: 'search_query', texts: [params.question] }),
  })
  if (!cohereRes.ok) throw new Error(`cohere_embed_failed:${cohereRes.status}`)
  const cohereData: { embeddings: number[][] } = await cohereRes.json()
  const queryEmbedding = cohereData.embeddings[0]
  const rpcRes = await fetch(`${params.env.supabaseUrl}/rest/v1/rpc/match_articles_prefer_analysis`, {
    method: 'POST',
    headers: params.sbHeaders,
    body: JSON.stringify({ query_embedding: queryEmbedding, match_count: params.maxRelated + 1 }),
  })
  if (!rpcRes.ok) throw new Error(`match_articles_prefer_analysis_failed:${rpcRes.status}`)
  const rows: RelatedArticleCandidate[] = await rpcRes.json()
  return rows.map(row => ({
    ...row,
    candidateType: 'article',
    metadata: { ...(row.metadata || {}), retrieval_path: 'article_dense_prefer_analysis' },
  }))
}
```

- [ ] **Step 6: Add chunk dense retrieval helper**

Add:

```ts
async function retrieveChunkDenseCandidates(params: {
  question: string
  sbHeaders: Record<string, string>
  env: { supabaseUrl: string }
  maxRelated: number
}): Promise<RelatedArticleCandidate[]> {
  const queryEmbedding = await embedQueryWithBgeM3(params.question)
  const rpcRes = await fetch(`${params.env.supabaseUrl}/rest/v1/rpc/match_answer_question_chunks`, {
    method: 'POST',
    headers: params.sbHeaders,
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: params.maxRelated + 1,
      chunking_version_filter: 'paragraph-window-v1-2026-06-02',
      chunk_overfetch_multiplier: 5,
      embedding_model_filter: '@cf/baai/bge-m3',
    }),
  })
  if (!rpcRes.ok) throw new Error(`match_answer_question_chunks_failed:${rpcRes.status}`)
  const rows = await rpcRes.json()
  return rows.map((row: any) => ({
    id: row.article_id,
    title: row.title || '',
    summary: row.chunk_text || row.summary || '',
    score: row.score_dense ?? null,
    embedding_source: row.embedding_source || 'answer_question_chunk_dense_bge_m3',
    candidateType: 'chunk',
    chunkId: row.chunk_id,
    chunkText: row.chunk_text,
    metadata: row.metadata || {},
  }))
}
```

- [ ] **Step 7: Use selected path with fallback inside `retrieve`**

Replace the current RAG `try` block with:

```ts
  let fallbackReason: string | null = null
  try {
    if (retrieverSelection.mode === 'chunk_dense_bge_m3') {
      try {
        relatedCandidates = await retrieveChunkDenseCandidates({
          question,
          sbHeaders,
          env: { supabaseUrl: env.supabaseUrl },
          maxRelated: caps.maxRelated,
        })
      } catch (chunkError) {
        fallbackReason = 'chunk_dense_failed_fell_back_to_article_dense'
        console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'answer-question', request_id: requestId, event: 'chunk_dense_fallback', error: (chunkError as Error).message }))
        relatedCandidates = await retrieveArticleDenseCandidates({
          question,
          articleId,
          sbHeaders,
          env: { supabaseUrl: env.supabaseUrl, cohereApiKey: env.cohereApiKey },
          maxRelated: caps.maxRelated,
          requestId,
        })
      }
    } else {
      relatedCandidates = await retrieveArticleDenseCandidates({
        question,
        articleId,
        sbHeaders,
        env: { supabaseUrl: env.supabaseUrl, cohereApiKey: env.cohereApiKey },
        maxRelated: caps.maxRelated,
        requestId,
      })
    }

    const filtered = relatedCandidates.filter(r => r.id !== articleId).slice(0, caps.maxRelated)
    injectedRelatedIds = filtered.map(r => r.id)
    if (filtered.length > 0) {
      const label = lang === 'zh' ? '相关文章' : 'Related article'
      relatedContext = '\n\n' + filtered.map((r, i) => {
        const sourceText = r.chunkText || r.summary || ''
        const trimmed = sourceText.slice(0, caps.relatedContextCap)
        return `[${label} ${i + 1}] ${r.title}\n${trimmed}`
      }).join('\n\n')
    }
    ragSuccess = true
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'answer-question', request_id: requestId, event: 'rag_retrieval_failed', error: (e as Error).message }))
  }
```

- [ ] **Step 8: Update trace recording params**

Add these fields to `recordAnswerQuestionTrace` params:

```ts
  retrieverMode: RetrieverMode
  retrieverSelectionReason: string
  fallbackReason: string | null
```

Update inserted run fields:

```ts
        query_embedding_model: params.retrieverMode === 'chunk_dense_bge_m3' && !params.fallbackReason ? '@cf/baai/bge-m3' : 'embed-english-v3.0',
        retrieval_strategy: params.retrieverMode === 'chunk_dense_bge_m3' && !params.fallbackReason ? 'chunk_dense_bge_m3' : 'dense_article_similarity_prefer_deep_analysis',
        retrieval_version: params.retrieverMode === 'chunk_dense_bge_m3' && !params.fallbackReason ? 'answer-question-chunk-dense-bge-m3-v1-2026-06-10' : 'answer-question-related-v1-2026-05-31',
        retriever_name: params.retrieverMode === 'chunk_dense_bge_m3' && !params.fallbackReason ? 'match_answer_question_chunks' : 'match_articles_prefer_analysis',
```

Update `query_input`:

```ts
          retriever_mode_requested: params.retrieverMode,
          retriever_selection_reason: params.retrieverSelectionReason,
          fallback_reason: params.fallbackReason,
          chunking_version: params.retrieverMode === 'chunk_dense_bge_m3' ? 'paragraph-window-v1-2026-06-02' : null,
```

Update candidate insert rows:

```ts
          candidate_type: candidate.candidateType || 'article',
          article_id: candidate.id,
          chunk_id: candidate.chunkId || null,
          metadata: {
            ...(candidate.metadata || {}),
            lang: params.lang,
            retriever_selection_reason: params.retrieverSelectionReason,
            fallback_reason: params.fallbackReason,
          },
```

Pass new params from `retrieve`:

```ts
    retrieverMode: retrieverSelection.mode,
    retrieverSelectionReason: retrieverSelection.reason,
    fallbackReason,
```

- [ ] **Step 9: Return fallback metadata**

Update the return:

```ts
  return {
    mainContext,
    relatedContext,
    injectedRelatedIds,
    retrievalRunId,
    ragSuccess,
    retrieverMode: retrieverSelection.mode,
    fallbackReason,
  }
```

- [ ] **Step 10: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add supabase/functions/answer-question/index.ts tests/answer-question-rollout.test.mjs
git commit -m "feat: add fallback-safe chunk retrieval to answer-question"
```

### Task 8: Add Production Canary Diagnostics

**Files:**
- Create: `supabase/sql/20260610_answer_question_rollout_diagnostics.sql`
- Modify: `tests/answer-question-rollout.test.mjs`

- [ ] **Step 1: Write failing SQL coverage test**

Append:

```js
test('answer-question rollout diagnostics compare latency errors feedback and fallback rate', () => {
  const sql = readFileSync('supabase/sql/20260610_answer_question_rollout_diagnostics.sql', 'utf8')

  assert.match(sql, /chunk_dense_bge_m3/)
  assert.match(sql, /dense_article_similarity_prefer_deep_analysis/)
  assert.match(sql, /fallback_rate/)
  assert.match(sql, /p95_latency_ms/)
  assert.match(sql, /negative_feedback_rate/)
  assert.match(sql, /empty_candidate_rate/)
  assert.match(sql, /trace_comparison/)
})
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test
```

Expected: test fails because the diagnostics SQL file does not exist.

- [ ] **Step 3: Create rollout diagnostics SQL**

Create `supabase/sql/20260610_answer_question_rollout_diagnostics.sql`:

```sql
-- 20260610 - answer-question rollout diagnostics.
--
-- Run during every canary step. The feature flag is safe only while chunk
-- traces stay within latency, error, fallback, and feedback gates.

with recent_traces as (
  select
    rr.id as retrieval_run_id,
    rr.created_at,
    rr.retrieval_strategy,
    rr.retriever_name,
    rr.candidate_count,
    rr.injected_count,
    rr.context_total_chars,
    rr.latency_ms,
    rr.query_input->>'retriever_mode_requested' as retriever_mode_requested,
    rr.query_input->>'retriever_selection_reason' as retriever_selection_reason,
    rr.query_input->>'fallback_reason' as fallback_reason,
    q.id as qa_log_id,
    q.feedback,
    q.error_message,
    q.total_ms
  from public.rag_retrieval_runs rr
  left join public.qa_logs q on q.rag_retrieval_run_id = rr.id
  where rr.surface = 'answer_question_related_articles'
    and rr.created_at >= now() - interval '24 hours'
),
trace_comparison as (
  select
    retrieval_strategy,
    retriever_name,
    count(*) as requests,
    percentile_cont(0.5) within group (order by latency_ms) as p50_latency_ms,
    percentile_cont(0.95) within group (order by latency_ms) as p95_latency_ms,
    avg(case when candidate_count = 0 then 1 else 0 end) as empty_candidate_rate,
    avg(case when injected_count = 0 then 1 else 0 end) as empty_injected_rate,
    avg(case when fallback_reason is not null then 1 else 0 end) as fallback_rate,
    avg(case when error_message is not null then 1 else 0 end) as qa_error_rate,
    avg(case when feedback = -1 then 1 else 0 end) as negative_feedback_rate,
    avg(context_total_chars) as avg_context_chars,
    max(created_at) as latest_trace_at
  from recent_traces
  group by retrieval_strategy, retriever_name
)
select
  'trace_comparison' as report_section,
  *
from trace_comparison
order by retrieval_strategy, retriever_name;

select
  'fallback_reasons' as report_section,
  fallback_reason,
  count(*) as requests
from recent_traces
where fallback_reason is not null
group by fallback_reason
order by requests desc;

select
  'gate_status' as report_section,
  retrieval_strategy,
  requests,
  p50_latency_ms,
  p95_latency_ms,
  fallback_rate,
  qa_error_rate,
  negative_feedback_rate,
  empty_candidate_rate,
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
      and requests < 20
      then 'directional_wait_for_more_traffic'
    when retrieval_strategy = 'chunk_dense_bge_m3'
      then 'canary_gate_fail'
    else 'baseline'
  end as gate_status
from trace_comparison
order by retrieval_strategy;
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/sql/20260610_answer_question_rollout_diagnostics.sql tests/answer-question-rollout.test.mjs
git commit -m "feat: add answer-question rollout diagnostics"
```

### Task 9: Write Operational Rollout And Rollback Notes

**Files:**
- Modify: `docs/instructions.md`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`
- Modify: `docs/current-state.md`

- [ ] **Step 1: Add command reference to `docs/instructions.md`**

Add a section titled `answer-question Chunk Retrieval Canary` with:

```md
### answer-question Chunk Retrieval Canary

Default state:

```bash
ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=false
ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=0
ANSWER_QUESTION_CHUNK_RETRIEVAL_USER_ALLOWLIST=
```

Enable staff allowlist only:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=true
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=0
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_USER_ALLOWLIST="$STAFF_USER_IDS"
supabase functions deploy answer-question
```

Move to 10 percent canary:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=true
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=10
supabase functions deploy answer-question
```

Immediate rollback:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=false
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=0
supabase functions deploy answer-question
```

Monitor:

```sql
\i supabase/sql/20260610_answer_question_rollout_diagnostics.sql
```
```

- [ ] **Step 2: Update progress doc gates**

In `docs/superpowers/rag-retrieval-refinement-progress.md`, add:

```md
## answer-question Rollout Gate

`chunk_dense @cf/baai/bge-m3` is the selected rollout candidate, not yet default production behavior. Production rollout requires:

- Locked 21-case generation eval bound to retrieval eval run `8ba5bdac-88a7-4f7b-8058-1648c734cc33`.
- Feature flag default off.
- Production chunk RPC applied.
- Canary diagnostics p50 <= 2500ms and p95 <= 8000ms.
- Fallback rate <= 5%.
- QA error rate <= 2%.
- Empty candidate rate <= 2%.
- Negative feedback rate not worse than article-dense baseline by more than 2 percentage points.
```

- [ ] **Step 3: Update current-state after implementation**

In `docs/current-state.md`, keep production unchanged until deployment. Add:

```md
The selected chunk retrieval path is implemented behind default-off rollout flags. It is not default production behavior until canary diagnostics pass and the flag is raised.
```

- [ ] **Step 4: Verify docs**

Run:

```bash
rg -n "selected production candidate|production answer accuracy improved" docs supabase/sql/results.md
npm test
```

Expected:

- No uncaveated `selected production candidate` wording remains.
- `npm test` passes.

- [ ] **Step 5: Commit**

```bash
git add docs/instructions.md docs/superpowers/rag-retrieval-refinement-progress.md docs/current-state.md
git commit -m "docs: add answer-question rollout operations"
```

## Phase 3: Canary Execution After Deployment

### Task 10: Deploy With Default-Off Flags

**Files:**
- No code edits.

- [ ] **Step 1: Apply SQL**

Run:

```sql
\i supabase/sql/20260610_answer_question_chunk_retrieval.sql
\i supabase/sql/20260610_answer_question_rollout_diagnostics.sql
```

- [ ] **Step 2: Set default-off secrets**

Run:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=false
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=0
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_USER_ALLOWLIST=
```

- [ ] **Step 3: Deploy `answer-question`**

Run:

```bash
supabase functions deploy answer-question
```

- [ ] **Step 4: Smoke current fallback path**

Ask one known article question from the frontend or API. Then run:

```sql
\i supabase/sql/20260610_answer_question_rollout_diagnostics.sql
```

Expected:

- New traces show `dense_article_similarity_prefer_deep_analysis`.
- No new traces show `chunk_dense_bge_m3`.
- Existing answer behavior remains normal.

### Task 11: Staff Canary

**Files:**
- Modify after run: `supabase/sql/results.md`

- [ ] **Step 1: Enable allowlist only**

Run:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=true
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=0
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_USER_ALLOWLIST="$STAFF_USER_IDS"
supabase functions deploy answer-question
```

- [ ] **Step 2: Run at least 10 staff questions**

Use known eval-like questions from different source types:

- RSS entity-heavy
- YouTube transcript
- Reddit social
- GitHub/Product Hunt entity lookup
- Legal/policy long context

- [ ] **Step 3: Monitor diagnostics**

Run:

```sql
\i supabase/sql/20260610_answer_question_rollout_diagnostics.sql
```

Pass criteria for staff canary:

- `chunk_dense_bge_m3` p50 <= 2500ms.
- `chunk_dense_bge_m3` p95 <= 8000ms.
- fallback rate <= 5%.
- QA error rate <= 2%.
- empty candidate rate <= 2%.
- No obvious answer quality regression in manual review.

- [ ] **Step 4: Record status**

Append to `supabase/sql/results.md`:

```md
## 2026-06-10 answer-question Staff Canary

- rollout mode: allowlist
- requests:
- p50 latency:
- p95 latency:
- fallback rate:
- QA error rate:
- empty candidate rate:
- manual review:
- decision:
```

### Task 12: Percent Rollout

**Files:**
- Modify after each stage: `supabase/sql/results.md`
- Modify after final pass: `docs/current-state.md`

- [ ] **Step 1: Move to 10 percent**

Run:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=true
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=10
supabase functions deploy answer-question
```

- [ ] **Step 2: Monitor for at least 20 chunk requests**

Run diagnostics repeatedly:

```sql
\i supabase/sql/20260610_answer_question_rollout_diagnostics.sql
```

Hold at 10 percent until the chunk path reaches at least 20 requests and returns `canary_gate_pass`.

- [ ] **Step 3: Move to 50 percent only after 10 percent passes**

Run:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=50
supabase functions deploy answer-question
```

Hold at 50 percent until the chunk path reaches at least 50 requests and returns `canary_gate_pass`.

- [ ] **Step 4: Move to 100 percent only after 50 percent passes**

Run:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=100
supabase functions deploy answer-question
```

Hold the fallback code permanently for at least one release cycle.

- [ ] **Step 5: Roll back immediately on gate failure**

Run:

```bash
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=false
supabase secrets set ANSWER_QUESTION_CHUNK_RETRIEVAL_ROLLOUT_PERCENT=0
supabase functions deploy answer-question
```

Record rollback reason in `supabase/sql/results.md`.

## Phase 4: Follow-On Eval Work

### Task 13: Bind Agentic Eval After Generation Is Locked

**Files:**
- Modify: `scripts/rag-agentic-eval-replay.mjs`
- Modify: `tests/rag-agentic-eval.test.mjs`
- Modify: `supabase/sql/results.md`

- [ ] **Step 1: Add `--source-generation-eval-run-id` to agentic eval**

Add a CLI flag that records the locked generation eval run id in agentic trace metadata. Agentic eval must not claim answer-quality pass/fail until it is tied to the same selected retrieval and generation benchmark.

- [ ] **Step 2: Run agentic smoke**

Run:

```bash
npm run eval:agentic -- \
  --set qa-v1-2026-06 \
  --retrieval-strategy chunk_dense \
  --chunking-version paragraph-window-v1-2026-06-02 \
  --source-generation-eval-run-id "$GENERATION_EVAL_RUN_ID" \
  --corpus-health-run-id 54dcd974-2fa2-4fb7-bb62-6eae9f3880c0 \
  --valid-for-strategy-selection false \
  --invalid-reason agentic_smoke_after_generation_lock \
  --max-cases 5
```

- [ ] **Step 3: Promote only after trace stability**

Agentic can become valid only if:

- Retrieval path is selected and stable.
- Generation run is locked to 21 cases.
- Agentic loop diagnostics show no runaway behavior.
- Every decision slice with pass/fail language has `n >= 5`.

## Acceptance Criteria

- `npm test` passes.
- `supabase/sql/20260610_rag_generation_eval_grouping.sql` identifies a latest complete 21-case generation eval run bound to retrieval eval run `8ba5bdac-88a7-4f7b-8058-1648c734cc33`.
- If no complete generation run exists before implementation, `npm run eval:generate-answers` and `npm run eval:judge-answers` can create and judge one using `--source-eval-run-id` and `--eval-run-id`.
- Docs no longer quote the 24-row generation aggregate as the benchmark.
- `answer-question` defaults to `match_articles_prefer_analysis` when flags are absent or disabled.
- Chunk retrieval is only used when `ANSWER_QUESTION_CHUNK_RETRIEVAL_ENABLED=true` and the request is allowlisted or selected by rollout percentage.
- Any chunk retrieval failure falls back to `match_articles_prefer_analysis` and records `fallback_reason`.
- Production traces distinguish `chunk_dense_bge_m3` from `dense_article_similarity_prefer_deep_analysis`.
- Canary SQL reports latency, error rate, fallback rate, empty candidate rate, and feedback rate.
- Rollback is one flag change plus redeploy.

## Curated Commit Plan

Use separate commits in this order:

1. `test: add generation eval grouping diagnostics`
2. `feat: bind generation eval to source retrieval runs`
3. `feat: scope generation judging by eval run`
4. `docs: lock generation eval to selected retrieval run`
5. `feat: add answer-question chunk retrieval rpc`
6. `feat: add answer-question retriever rollout flags`
7. `feat: add fallback-safe chunk retrieval to answer-question`
8. `feat: add answer-question rollout diagnostics`
9. `docs: add answer-question rollout operations`

Never stage:

```bash
workers/embed-batch/.dev.vars
.playwright-mcp/
```

Before pushing:

```bash
git diff --cached --check
npm test
git status --short
```
