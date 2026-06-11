# Deep Analysis And Trend Brief RAG Eval Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing RAG eval system beyond Q&A retrieval into two production surfaces: Deep Analysis quality and Trend Brief synthesis quality.

**Architecture:** Keep production behavior unchanged while adding eval-only datasets, judges, metrics, traces, and reports. Treat Deep Analysis eval as article-level structured analysis evaluation, and Trend Brief eval as cross-window synthesis evaluation with source selection, clustering, citation, novelty, and temporal-coherence checks. Reuse corpus-health gates, `rag_retrieval_*` traces, `rag_eval_*` conventions, and service-role-only storage.

**Tech Stack:** Supabase Postgres SQL migrations, Node `.mjs` eval scripts, Supabase REST service-role clients, TokenRouter/OpenRouter/Groq judge calls, existing `npm test` Node test suite.

---

## Current Baseline

The existing RAG eval result is primarily for **Q&A retrieval and answer generation**, not for Deep Analysis or Trend Brief quality. It measures whether the retriever can find approved evidence for fixed questions and whether generated answers remain faithful to retrieved context.

Deep Analysis and Trend Brief need separate eval tracks because their failure modes differ:

- **Deep Analysis** is a structured per-article analysis product. It needs evaluation for evidence grounding, claim specificity, bilingual consistency, section completeness, insight usefulness, and hallucination resistance.
- **Trend Brief** is a multi-article synthesis product. It needs evaluation for source selection, cluster coverage, temporal coherence, novelty, citation correctness, contradiction handling, and whether it identifies a real trend rather than summarizing unrelated articles.
- **Agentic RAG** is relevant only for harder multi-hop/comparison/ambiguous questions and for future Trend Brief research workflows. It should remain a bounded orchestration layer above retrieval, not a default path.
- **GraphRAG** is deferred until eval misses prove that entity-relation reasoning is needed beyond chunk/hybrid/rerank retrieval.

---

## File Structure

Create:

- `supabase/sql/20260611_deep_analysis_eval.sql`  
  Service-role-only tables for Deep Analysis eval runs, per-article scores, evidence anchors, and aggregate metrics.

- `supabase/sql/20260611_trend_brief_eval.sql`  
  Service-role-only tables for Trend Brief eval windows, per-window scores, source coverage, citation checks, and aggregate metrics.

- `scripts/deep-analysis-eval.mjs`  
  Eval runner that samples ready `article_deep_analysis` rows, builds judge prompts, scores structure/grounding/specificity/bilingual consistency, and writes results.

- `scripts/trend-brief-eval.mjs`  
  Eval runner that evaluates generated Trend Briefs against the underlying article window, selected sources, historical enrichment, citations, and synthesis quality.

- `scripts/deep-analysis-eval-lib.mjs`  
  Shared Deep Analysis scoring helpers: section extraction, evidence-anchor matching, bilingual consistency checks, and judge result parsing.

- `scripts/trend-brief-eval-lib.mjs`  
  Shared Trend Brief scoring helpers: window article loading, source coverage metrics, citation validation, novelty checks, and judge result parsing.

- `supabase/sql/20260611_deep_analysis_trend_brief_eval_reports.sql`  
  Read-only diagnostic SQL for latest runs, score distributions, failing rows, and pass/fail gates.

Modify:

- `package.json`  
  Add `eval:deep-analysis` and `eval:trend-brief` scripts.

- `tests/rag-eval-refinement.test.mjs` or a new `tests/deep-analysis-trend-brief-eval.test.mjs`  
  Add structural tests for SQL, package scripts, parser helpers, and safety gates.

- `docs/superpowers/rag-retrieval-refinement-progress.md`  
  Add a section distinguishing Q&A RAG eval, Deep Analysis eval, Trend Brief eval, Agentic RAG, and GraphRAG.

- `docs/project-interview-resume-brief.md`  
  Update only after real eval rows exist. Until then, describe this plan as future work.

---

## Task 1: Deep Analysis Eval Schema

**Files:**
- Create: `supabase/sql/20260611_deep_analysis_eval.sql`
- Test: `tests/deep-analysis-trend-brief-eval.test.mjs`

- [ ] **Step 1: Write a failing schema test**

Add this test:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('deep analysis eval schema stores service-role-only article scores', () => {
  const sql = readFileSync('supabase/sql/20260611_deep_analysis_eval.sql', 'utf8')

  assert.match(sql, /create table if not exists public\.deep_analysis_eval_runs/i)
  assert.match(sql, /create table if not exists public\.deep_analysis_eval_results/i)
  assert.match(sql, /article_id\s+uuid\s+not null/i)
  assert.match(sql, /analysis_id\s+uuid/i)
  assert.match(sql, /grounding_score\s+numeric/i)
  assert.match(sql, /specificity_score\s+numeric/i)
  assert.match(sql, /bilingual_consistency_score\s+numeric/i)
  assert.match(sql, /hallucination_risk_score\s+numeric/i)
  assert.match(sql, /revoke all on public\.deep_analysis_eval_runs from anon,\s*authenticated/i)
  assert.match(sql, /revoke all on public\.deep_analysis_eval_results from anon,\s*authenticated/i)
  assert.match(sql, /grant all on public\.deep_analysis_eval_runs to service_role/i)
  assert.match(sql, /grant all on public\.deep_analysis_eval_results to service_role/i)
})
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test
```

Expected: FAIL because `supabase/sql/20260611_deep_analysis_eval.sql` does not exist.

- [ ] **Step 3: Create the schema**

Create `supabase/sql/20260611_deep_analysis_eval.sql`:

```sql
-- 20260611 — Deep Analysis eval schema.
--
-- Eval-only quality store for article_deep_analysis outputs.
-- Production Deep Analysis generation and feed behavior are unchanged.

create extension if not exists pgcrypto;

create table if not exists public.deep_analysis_eval_runs (
  id                         uuid primary key default gen_random_uuid(),
  eval_name                  text not null default 'deep-analysis-v1',
  judge_model                text not null,
  sample_strategy            text not null,
  sample_size                integer not null default 0,
  valid_for_release_notes    boolean not null default false,
  invalid_reason             text,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

create table if not exists public.deep_analysis_eval_results (
  id                               uuid primary key default gen_random_uuid(),
  eval_run_id                       uuid not null references public.deep_analysis_eval_runs(id) on delete cascade,
  article_id                        uuid not null references public.daily_news(id) on delete cascade,
  analysis_id                       uuid references public.article_deep_analysis(id) on delete set null,
  grounding_score                   numeric not null check (grounding_score between 0 and 1),
  specificity_score                 numeric not null check (specificity_score between 0 and 1),
  structure_completeness_score      numeric not null check (structure_completeness_score between 0 and 1),
  bilingual_consistency_score       numeric not null check (bilingual_consistency_score between 0 and 1),
  hallucination_risk_score          numeric not null check (hallucination_risk_score between 0 and 1),
  evidence_anchor_count             integer not null default 0,
  unsupported_claim_count           integer not null default 0,
  judge_rationale                   text,
  metadata                          jsonb not null default '{}'::jsonb,
  created_at                        timestamptz not null default now(),
  unique(eval_run_id, article_id)
);

create index if not exists deep_analysis_eval_results_run_idx
  on public.deep_analysis_eval_results(eval_run_id, grounding_score, hallucination_risk_score);

alter table public.deep_analysis_eval_runs enable row level security;
alter table public.deep_analysis_eval_results enable row level security;

revoke all on public.deep_analysis_eval_runs from anon, authenticated;
revoke all on public.deep_analysis_eval_results from anon, authenticated;
grant all on public.deep_analysis_eval_runs to service_role;
grant all on public.deep_analysis_eval_results to service_role;

-- Latest run summary.
select
  r.id as eval_run_id,
  r.created_at,
  r.valid_for_release_notes,
  count(res.id) as articles,
  round(avg(res.grounding_score), 3) as avg_grounding,
  round(avg(res.specificity_score), 3) as avg_specificity,
  round(avg(res.structure_completeness_score), 3) as avg_structure,
  round(avg(res.bilingual_consistency_score), 3) as avg_bilingual_consistency,
  round(avg(res.hallucination_risk_score), 3) as avg_hallucination_risk
from public.deep_analysis_eval_runs r
left join public.deep_analysis_eval_results res on res.eval_run_id = r.id
where r.id = (
  select id from public.deep_analysis_eval_runs order by created_at desc limit 1
)
group by r.id, r.created_at, r.valid_for_release_notes;
```

- [ ] **Step 4: Run the test**

Run:

```bash
npm test
```

Expected: PASS for the new schema test.

- [ ] **Step 5: Commit**

```bash
git add supabase/sql/20260611_deep_analysis_eval.sql tests/deep-analysis-trend-brief-eval.test.mjs
git commit -m "feat: add deep analysis eval schema"
```

---

## Task 2: Deep Analysis Eval Runner

**Files:**
- Create: `scripts/deep-analysis-eval-lib.mjs`
- Create: `scripts/deep-analysis-eval.mjs`
- Modify: `package.json`
- Test: `tests/deep-analysis-trend-brief-eval.test.mjs`

- [ ] **Step 1: Add structural runner tests**

Append:

```js
test('deep analysis eval runner exposes bounded judge scoring and package command', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const runner = readFileSync('scripts/deep-analysis-eval.mjs', 'utf8')
  const lib = readFileSync('scripts/deep-analysis-eval-lib.mjs', 'utf8')

  assert.equal(pkg.scripts['eval:deep-analysis'], 'node scripts/deep-analysis-eval.mjs')
  assert.match(runner, /--max-articles/)
  assert.match(runner, /deep_analysis_eval_runs/)
  assert.match(runner, /deep_analysis_eval_results/)
  assert.match(runner, /valid_for_release_notes/)
  assert.match(lib, /export function buildDeepAnalysisJudgePrompt/)
  assert.match(lib, /export function parseDeepAnalysisJudgeJson/)
  assert.match(lib, /grounding_score/)
  assert.match(lib, /hallucination_risk_score/)
})
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test
```

Expected: FAIL because the script files and package command do not exist.

- [ ] **Step 3: Implement `scripts/deep-analysis-eval-lib.mjs`**

```js
export function buildDeepAnalysisJudgePrompt({ article, analysis }) {
  return [
    'You are evaluating a structured Deep Analysis for an AI news article.',
    'Return strict JSON only.',
    'Scores must be numbers from 0 to 1.',
    '',
    'Evaluate:',
    '- grounding_score: analysis claims are supported by the article text and summaries',
    '- specificity_score: analysis contains concrete actors, numbers, mechanisms, and consequences',
    '- structure_completeness_score: expected sections are present and substantive',
    '- bilingual_consistency_score: English and Chinese fields preserve the same meaning',
    '- hallucination_risk_score: 0 means no unsupported claims, 1 means severe unsupported claims',
    '',
    `ARTICLE_TITLE: ${article.title ?? ''}`,
    `ARTICLE_SUMMARY_EN: ${article.summary_en ?? ''}`,
    `ARTICLE_SUMMARY_ZH: ${article.summary_zh ?? ''}`,
    `ARTICLE_CONTENT: ${(article.article_content ?? '').slice(0, 12000)}`,
    '',
    `DEEP_ANALYSIS_JSON: ${JSON.stringify(analysis ?? {})}`,
    '',
    'Return JSON shape:',
    '{"grounding_score":0.0,"specificity_score":0.0,"structure_completeness_score":0.0,"bilingual_consistency_score":0.0,"hallucination_risk_score":0.0,"evidence_anchor_count":0,"unsupported_claim_count":0,"judge_rationale":"short rationale"}'
  ].join('\n')
}

export function parseDeepAnalysisJudgeJson(text) {
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error('Judge response did not contain JSON')
  }

  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1))
  const scoreKeys = [
    'grounding_score',
    'specificity_score',
    'structure_completeness_score',
    'bilingual_consistency_score',
    'hallucination_risk_score'
  ]

  for (const key of scoreKeys) {
    const value = Number(parsed[key])
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid ${key}`)
    }
    parsed[key] = value
  }

  parsed.evidence_anchor_count = Math.max(0, Number.parseInt(parsed.evidence_anchor_count ?? 0, 10) || 0)
  parsed.unsupported_claim_count = Math.max(0, Number.parseInt(parsed.unsupported_claim_count ?? 0, 10) || 0)
  parsed.judge_rationale = String(parsed.judge_rationale ?? '').slice(0, 2000)

  return parsed
}
```

- [ ] **Step 4: Implement `scripts/deep-analysis-eval.mjs`**

Follow existing `scripts/rag-eval-*.mjs` client patterns. Required behavior:

```js
// Required CLI flags:
// --max-articles 24
// --sample-strategy latest_ready
// --judge-model <model-id>
// --valid-for-release-notes false
//
// Required DB behavior:
// 1. Insert deep_analysis_eval_runs row.
// 2. Select ready article_deep_analysis rows joined to daily_news.
// 3. Judge each row with buildDeepAnalysisJudgePrompt().
// 4. Upsert deep_analysis_eval_results.
// 5. Print aggregate metrics and worst rows.
```

- [ ] **Step 5: Add package script**

Add:

```json
"eval:deep-analysis": "node scripts/deep-analysis-eval.mjs"
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Smoke run**

Run:

```bash
npm run eval:deep-analysis -- --max-articles 3 --sample-strategy latest_ready --valid-for-release-notes false --judge-model qwen/qwen3.5-flash
```

Expected: inserts one eval run with 3 result rows and prints aggregate metrics. If provider/network fails, keep the run invalid and record the failure reason.

- [ ] **Step 8: Commit**

```bash
git add package.json scripts/deep-analysis-eval.mjs scripts/deep-analysis-eval-lib.mjs tests/deep-analysis-trend-brief-eval.test.mjs
git commit -m "feat: add deep analysis eval runner"
```

---

## Task 3: Trend Brief Eval Schema

**Files:**
- Create: `supabase/sql/20260611_trend_brief_eval.sql`
- Test: `tests/deep-analysis-trend-brief-eval.test.mjs`

- [ ] **Step 1: Add schema test**

```js
test('trend brief eval schema stores source coverage citation and synthesis scores', () => {
  const sql = readFileSync('supabase/sql/20260611_trend_brief_eval.sql', 'utf8')

  assert.match(sql, /create table if not exists public\.trend_brief_eval_runs/i)
  assert.match(sql, /create table if not exists public\.trend_brief_eval_results/i)
  assert.match(sql, /anchor_date\s+date\s+not null/i)
  assert.match(sql, /step_days\s+integer\s+not null/i)
  assert.match(sql, /source_coverage_score\s+numeric/i)
  assert.match(sql, /citation_accuracy_score\s+numeric/i)
  assert.match(sql, /trend_coherence_score\s+numeric/i)
  assert.match(sql, /novelty_score\s+numeric/i)
  assert.match(sql, /contradiction_handling_score\s+numeric/i)
  assert.match(sql, /revoke all on public\.trend_brief_eval_runs from anon,\s*authenticated/i)
  assert.match(sql, /grant all on public\.trend_brief_eval_results to service_role/i)
})
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test
```

Expected: FAIL because the SQL file does not exist.

- [ ] **Step 3: Create `supabase/sql/20260611_trend_brief_eval.sql`**

```sql
-- 20260611 — Trend Brief eval schema.
--
-- Eval-only quality store for cross-window Trend Brief synthesis.
-- Production generation, digest delivery, and user-mode caching are unchanged.

create extension if not exists pgcrypto;

create table if not exists public.trend_brief_eval_runs (
  id                         uuid primary key default gen_random_uuid(),
  eval_name                  text not null default 'trend-brief-v1',
  judge_model                text not null,
  window_strategy            text not null,
  valid_for_release_notes    boolean not null default false,
  invalid_reason             text,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

create table if not exists public.trend_brief_eval_results (
  id                                  uuid primary key default gen_random_uuid(),
  eval_run_id                          uuid not null references public.trend_brief_eval_runs(id) on delete cascade,
  trend_brief_id                       uuid references public.trend_briefs(id) on delete set null,
  anchor_date                          date not null,
  step_days                            integer not null,
  source_article_count                 integer not null default 0,
  cited_article_count                  integer not null default 0,
  source_coverage_score                numeric not null check (source_coverage_score between 0 and 1),
  citation_accuracy_score              numeric not null check (citation_accuracy_score between 0 and 1),
  trend_coherence_score                numeric not null check (trend_coherence_score between 0 and 1),
  novelty_score                        numeric not null check (novelty_score between 0 and 1),
  contradiction_handling_score         numeric not null check (contradiction_handling_score between 0 and 1),
  actionability_score                  numeric not null check (actionability_score between 0 and 1),
  unsupported_synthesis_claim_count    integer not null default 0,
  judge_rationale                      text,
  metadata                             jsonb not null default '{}'::jsonb,
  created_at                           timestamptz not null default now(),
  unique(eval_run_id, anchor_date, step_days)
);

create index if not exists trend_brief_eval_results_run_idx
  on public.trend_brief_eval_results(eval_run_id, trend_coherence_score, citation_accuracy_score);

alter table public.trend_brief_eval_runs enable row level security;
alter table public.trend_brief_eval_results enable row level security;

revoke all on public.trend_brief_eval_runs from anon, authenticated;
revoke all on public.trend_brief_eval_results from anon, authenticated;
grant all on public.trend_brief_eval_runs to service_role;
grant all on public.trend_brief_eval_results to service_role;

select
  r.id as eval_run_id,
  r.created_at,
  r.valid_for_release_notes,
  count(res.id) as windows,
  round(avg(res.source_coverage_score), 3) as avg_source_coverage,
  round(avg(res.citation_accuracy_score), 3) as avg_citation_accuracy,
  round(avg(res.trend_coherence_score), 3) as avg_trend_coherence,
  round(avg(res.novelty_score), 3) as avg_novelty,
  round(avg(res.contradiction_handling_score), 3) as avg_contradiction_handling
from public.trend_brief_eval_runs r
left join public.trend_brief_eval_results res on res.eval_run_id = r.id
where r.id = (
  select id from public.trend_brief_eval_runs order by created_at desc limit 1
)
group by r.id, r.created_at, r.valid_for_release_notes;
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/sql/20260611_trend_brief_eval.sql tests/deep-analysis-trend-brief-eval.test.mjs
git commit -m "feat: add trend brief eval schema"
```

---

## Task 4: Trend Brief Eval Runner

**Files:**
- Create: `scripts/trend-brief-eval-lib.mjs`
- Create: `scripts/trend-brief-eval.mjs`
- Modify: `package.json`
- Test: `tests/deep-analysis-trend-brief-eval.test.mjs`

- [ ] **Step 1: Add structural runner test**

```js
test('trend brief eval runner exposes window citation and synthesis checks', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const runner = readFileSync('scripts/trend-brief-eval.mjs', 'utf8')
  const lib = readFileSync('scripts/trend-brief-eval-lib.mjs', 'utf8')

  assert.equal(pkg.scripts['eval:trend-brief'], 'node scripts/trend-brief-eval.mjs')
  assert.match(runner, /--max-windows/)
  assert.match(runner, /trend_brief_eval_runs/)
  assert.match(runner, /trend_brief_eval_results/)
  assert.match(lib, /export function buildTrendBriefJudgePrompt/)
  assert.match(lib, /export function computeSourceCoverage/)
  assert.match(lib, /citation_accuracy_score/)
  assert.match(lib, /trend_coherence_score/)
})
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test
```

Expected: FAIL because the scripts and package command do not exist.

- [ ] **Step 3: Implement `scripts/trend-brief-eval-lib.mjs`**

```js
export function computeSourceCoverage({ windowArticles, sourcesJson }) {
  const windowIds = new Set(windowArticles.map((article) => String(article.id)))
  const citedIds = new Set((sourcesJson ?? []).map((source) => String(source.id)).filter(Boolean))
  const citedInWindow = [...citedIds].filter((id) => windowIds.has(id)).length
  return {
    source_article_count: windowIds.size,
    cited_article_count: citedIds.size,
    source_coverage_score: windowIds.size === 0 ? 0 : Math.min(1, citedInWindow / Math.min(windowIds.size, 12))
  }
}

export function buildTrendBriefJudgePrompt({ brief, windowArticles, sourceCoverage }) {
  const compactArticles = windowArticles.slice(0, 80).map((article, index) => ({
    index: index + 1,
    id: article.id,
    title: article.title_en ?? article.title ?? '',
    summary: article.summary_en ?? article.summary ?? '',
    published_at: article.published_at
  }))

  return [
    'You are evaluating a cross-window AI news Trend Brief.',
    'Return strict JSON only. Scores must be numbers from 0 to 1.',
    '',
    'Evaluate:',
    '- citation_accuracy_score: cited article IDs/titles support the claims',
    '- trend_coherence_score: the brief identifies real connected trends, not a loose article list',
    '- novelty_score: the brief explains what changed versus generic AI news',
    '- contradiction_handling_score: conflicts and weak signals are handled carefully',
    '- actionability_score: implications are useful for builders/investors/operators',
    '',
    `SOURCE_COVERAGE: ${JSON.stringify(sourceCoverage)}`,
    `WINDOW_ARTICLES: ${JSON.stringify(compactArticles)}`,
    `BRIEF_EN: ${brief.synthesis_en ?? ''}`,
    `BRIEF_ZH: ${brief.synthesis_zh ?? ''}`,
    '',
    'Return JSON shape:',
    '{"citation_accuracy_score":0.0,"trend_coherence_score":0.0,"novelty_score":0.0,"contradiction_handling_score":0.0,"actionability_score":0.0,"unsupported_synthesis_claim_count":0,"judge_rationale":"short rationale"}'
  ].join('\n')
}

export function parseTrendBriefJudgeJson(text) {
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error('Judge response did not contain JSON')
  }

  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1))
  const scoreKeys = [
    'citation_accuracy_score',
    'trend_coherence_score',
    'novelty_score',
    'contradiction_handling_score',
    'actionability_score'
  ]

  for (const key of scoreKeys) {
    const value = Number(parsed[key])
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid ${key}`)
    }
    parsed[key] = value
  }

  parsed.unsupported_synthesis_claim_count = Math.max(0, Number.parseInt(parsed.unsupported_synthesis_claim_count ?? 0, 10) || 0)
  parsed.judge_rationale = String(parsed.judge_rationale ?? '').slice(0, 2000)
  return parsed
}
```

- [ ] **Step 4: Implement `scripts/trend-brief-eval.mjs`**

Follow existing eval runner patterns. Required behavior:

```js
// Required CLI flags:
// --max-windows 5
// --step-days 1,7,30
// --judge-model <model-id>
// --valid-for-release-notes false
//
// Required DB behavior:
// 1. Insert trend_brief_eval_runs row.
// 2. Select recent trend_briefs rows for requested step_days.
// 3. Load daily_news rows in each window.
// 4. Compute source coverage from sources_json.
// 5. Judge synthesis quality.
// 6. Upsert trend_brief_eval_results.
// 7. Print aggregate metrics and worst windows.
```

- [ ] **Step 5: Add package script**

Add:

```json
"eval:trend-brief": "node scripts/trend-brief-eval.mjs"
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Smoke run**

Run:

```bash
npm run eval:trend-brief -- --max-windows 2 --step-days 1,7 --valid-for-release-notes false --judge-model qwen/qwen3.5-flash
```

Expected: inserts one eval run with up to 2 result rows and prints aggregate metrics. If no brief exists for a window, skip that window and record the skipped count in run metadata.

- [ ] **Step 8: Commit**

```bash
git add package.json scripts/trend-brief-eval.mjs scripts/trend-brief-eval-lib.mjs tests/deep-analysis-trend-brief-eval.test.mjs
git commit -m "feat: add trend brief eval runner"
```

---

## Task 5: Reporting And Release Gates

**Files:**
- Create: `supabase/sql/20260611_deep_analysis_trend_brief_eval_reports.sql`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`
- Test: `tests/deep-analysis-trend-brief-eval.test.mjs`

- [ ] **Step 1: Add report SQL test**

```js
test('deep analysis and trend brief reports expose gated latest-run summaries', () => {
  const sql = readFileSync('supabase/sql/20260611_deep_analysis_trend_brief_eval_reports.sql', 'utf8')

  assert.match(sql, /deep_analysis_eval_runs/i)
  assert.match(sql, /trend_brief_eval_runs/i)
  assert.match(sql, /valid_for_release_notes\s*=\s*true/i)
  assert.match(sql, /hallucination_risk_score/i)
  assert.match(sql, /citation_accuracy_score/i)
  assert.match(sql, /unsupported_synthesis_claim_count/i)
})
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test
```

Expected: FAIL because the report SQL does not exist.

- [ ] **Step 3: Create report SQL**

Create a report file with three sections:

```sql
-- Latest valid Deep Analysis eval summary.
select
  r.id as eval_run_id,
  r.created_at,
  count(res.id) as articles,
  round(avg(res.grounding_score), 3) as avg_grounding,
  round(avg(res.specificity_score), 3) as avg_specificity,
  round(avg(res.bilingual_consistency_score), 3) as avg_bilingual_consistency,
  round(avg(res.hallucination_risk_score), 3) as avg_hallucination_risk
from public.deep_analysis_eval_runs r
join public.deep_analysis_eval_results res on res.eval_run_id = r.id
where r.valid_for_release_notes = true
group by r.id, r.created_at
order by r.created_at desc
limit 5;

-- Worst Deep Analysis rows in latest valid run.
with latest as (
  select id
  from public.deep_analysis_eval_runs
  where valid_for_release_notes = true
  order by created_at desc
  limit 1
)
select
  res.article_id,
  dn.title,
  res.grounding_score,
  res.specificity_score,
  res.hallucination_risk_score,
  res.unsupported_claim_count,
  res.judge_rationale
from public.deep_analysis_eval_results res
join latest on latest.id = res.eval_run_id
join public.daily_news dn on dn.id = res.article_id
order by res.hallucination_risk_score desc, res.grounding_score asc
limit 20;

-- Latest valid Trend Brief eval summary.
select
  r.id as eval_run_id,
  r.created_at,
  count(res.id) as windows,
  round(avg(res.source_coverage_score), 3) as avg_source_coverage,
  round(avg(res.citation_accuracy_score), 3) as avg_citation_accuracy,
  round(avg(res.trend_coherence_score), 3) as avg_trend_coherence,
  round(avg(res.novelty_score), 3) as avg_novelty,
  round(avg(res.contradiction_handling_score), 3) as avg_contradiction_handling,
  sum(res.unsupported_synthesis_claim_count) as unsupported_synthesis_claims
from public.trend_brief_eval_runs r
join public.trend_brief_eval_results res on res.eval_run_id = r.id
where r.valid_for_release_notes = true
group by r.id, r.created_at
order by r.created_at desc
limit 5;
```

- [ ] **Step 4: Update progress doc**

Add a concise section:

```markdown
## Future Surface-Specific Eval

Q&A RAG eval is not a substitute for Deep Analysis or Trend Brief eval.

- Deep Analysis eval will score article-level grounding, specificity, structure completeness, bilingual consistency, and hallucination risk.
- Trend Brief eval will score source coverage, citation accuracy, trend coherence, novelty, contradiction handling, and actionability.
- Agentic RAG remains eval-only and should be used only for ambiguous, comparison, multi-hop, or low-context questions.
- GraphRAG remains deferred until relation-based eval misses prove chunk/hybrid/rerank cannot recover the needed evidence.
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/sql/20260611_deep_analysis_trend_brief_eval_reports.sql docs/superpowers/rag-retrieval-refinement-progress.md tests/deep-analysis-trend-brief-eval.test.mjs
git commit -m "docs: add deep analysis and trend brief eval reporting gates"
```

---

## Task 6: Release Interpretation And Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/project-interview-resume-brief.md`
- Modify: `docs/current-state.md`

- [ ] **Step 1: Add README wording**

Add a short paragraph under Current Results:

```markdown
These RAG metrics currently describe the Q&A eval track. Deep Analysis and Trend Brief require separate surface-specific evals before their quality can be quoted. Agentic RAG is an eval-only orchestration path; GraphRAG is deferred until relation-based failures justify it.
```

- [ ] **Step 2: Add interview-brief wording**

Add:

```markdown
Deep Analysis eval and Trend Brief eval are planned as separate quality gates. They should not inherit Q&A Recall/MRR/NDCG claims because their outputs are structured article analysis and cross-window synthesis, not ranked answer retrieval.
```

- [ ] **Step 3: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/project-interview-resume-brief.md docs/current-state.md
git commit -m "docs: clarify surface-specific rag eval roadmap"
```

---

## Release Gates

Do not quote Deep Analysis or Trend Brief metrics externally until all are true:

1. Eval schema exists and is service-role-only.
2. Runner has at least one successful non-smoke run.
3. Results are marked `valid_for_release_notes = true`.
4. Worst-case rows have been manually inspected.
5. Metrics are surface-specific and not borrowed from Q&A retrieval eval.
6. Docs state whether the result is offline eval, production shadow eval, or production traffic eval.

---

## Git Commit Command For This Plan

```bash
git add docs/superpowers/plans/2026-06-11-deep-analysis-trend-brief-rag-eval-refinement-plan.md README.md docs/project-interview-resume-brief.md
git commit -m "docs: plan deep analysis and trend brief rag eval"
```
