# RAG Retrieval Refinement Next Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the next offline RAG refinement layer after trace completeness and golden dataset v1: diagnose current misses, expand gold coverage, add lexical and hybrid replay baselines, and prepare chunked retrieval without changing production behavior.

**Architecture:** Keep Supabase as the system of record and keep all work eval-only until metrics prove improvement. The next lever is retrieval machinery, not generation: current results show article-level dense retrieval often misses the primary article and returns noisy semantically adjacent candidates. This plan adds diagnostic SQL, replay-only lexical/hybrid candidate generation, and chunk schema/backfill scaffolding so future production changes can be gated by Recall/MRR/NDCG deltas.

**Tech Stack:** Supabase PostgreSQL, pgvector, PostgREST, Node 20 CLI scripts, Cohere `embed-english-v3.0`, existing `rag_eval_*` and `rag_retrieval_*` tables.

**Implementation status (2026-06-03):** Implemented as eval-only. Added diagnostic SQL, lexical eval RPC, dense/lexical/hybrid replay support, gold candidate expansion, eval-only `article_chunks` scaffold, chunk backfill CLI, and static/unit tests. Production `answer-question`, `generate-trend-brief`, and `match_articles` behavior remain unchanged. Latest approved-gold comparison: dense Recall@10 0.278 / MRR 0.133 / NDCG@10 0.259; hybrid Recall@10 0.500 / MRR 0.190 / NDCG@10 0.342 with much higher latency. See `docs/superpowers/rag-retrieval-refinement-progress.md` for the current handoff.

---

## File Structure

- Modify: `scripts/rag-eval-lib.mjs`
  - Add lexical candidate fetching through an eval-only SQL RPC, reciprocal-rank fusion, metric grouping helpers, and optional candidate source metadata.
- Modify: `scripts/rag-eval-replay.mjs`
  - Add `--strategy dense|lexical|hybrid`, preserve current dense default, and write strategy-specific labels into both eval runs and retrieval traces.
- Modify: `scripts/rag-eval-generate-gold.mjs`
  - Add gold expansion so dense, lexical, hybrid, and primary-article baseline candidates can all be judged before official comparisons.
- Create: `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`
  - Read-only SQL for current miss analysis, source article retrieval rank, noisy top candidates, per-case grade distributions, and approved-gold preflight checks.
- Create: `supabase/sql/20260602_rag_lexical_eval_rpc.sql`
  - Eval-only lexical retrieval RPC for Chinese/mixed-language article-level baselines.
- Create: `supabase/sql/20260602_article_chunks_eval_scaffold.sql`
  - Eval-only chunk table and indexes. No production retrieval uses it yet.
- Create: `scripts/rag-chunk-backfill.mjs`
  - On-demand chunk backfill CLI for long articles. It creates chunks and embeddings but does not alter `answer-question`.
- Create: `tests/rag-retrieval-refinement.test.mjs`
  - Static and unit tests for lexical/hybrid replay support and chunk scaffold.

---

## Operating Rules

- Do not modify `supabase/functions/answer-question/index.ts` in this plan.
- Do not modify `supabase/functions/generate-trend-brief/index.ts` in this plan.
- Do not change `match_articles` or `match_articles_prefer_analysis` behavior in this plan.
- All new retrieval strategies run only through `npm run eval:replay` and gold expansion tooling.
- Official dense/lexical/hybrid comparisons require approved relevant gold evidence; exploratory comparisons may use pending labels only when explicitly marked.
- Production behavior changes require a later plan and a metric gate.

---

### Task 1: Add Diagnostic SQL for Current Retrieval Misses

**Files:**
- Create: `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`

- [ ] **Step 1: Add failing static test expectations**

Create `tests/rag-retrieval-refinement.test.mjs` with:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('retrieval diagnostics SQL inspects latest eval misses, gold readiness, and primary article rank', () => {
  const sql = readFileSync('supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql', 'utf8')

  assert.match(sql, /rag_eval_retrieval_metrics/)
  assert.match(sql, /primary_rank/)
  assert.match(sql, /rag_retrieval_candidates/)
  assert.match(sql, /primary_article_baseline/)
  assert.match(sql, /approved_relevant_gold/)
  assert.match(sql, /score_lexical/)
})
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: fail with missing `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`.

- [ ] **Step 3: Write diagnostic SQL file**

Create `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`:

```sql
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
```

- [ ] **Step 4: Run test and verify pass**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql tests/rag-retrieval-refinement.test.mjs
git commit -m "test: add rag retrieval diagnostics sql"
```

---

### Task 2: Add Replay-Only Lexical Retrieval

**Files:**
- Create: `supabase/sql/20260602_rag_lexical_eval_rpc.sql`
- Modify: `scripts/rag-eval-lib.mjs`
- Modify: `scripts/rag-eval-replay.mjs`
- Test: `tests/rag-retrieval-refinement.test.mjs`

- [ ] **Step 1: Add failing tests for lexical helpers and replay strategy switch**

Append to `tests/rag-retrieval-refinement.test.mjs`:

```js
test('eval lib exposes lexical and hybrid replay helpers', () => {
  const source = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')
  const sql = readFileSync('supabase/sql/20260602_rag_lexical_eval_rpc.sql', 'utf8')

  assert.match(source, /fetchLexicalCandidates/)
  assert.match(source, /fuseCandidatesByRrf/)
  assert.match(source, /extractLexicalTerms/)
  assert.match(sql, /match_articles_lexical_eval/)
  assert.match(sql, /pg_trgm/)
  assert.match(sql, /title_en/)
  assert.match(sql, /summary_zh/)
})

test('replay runner supports dense, lexical, and hybrid strategies without production changes', () => {
  const source = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(source, /--strategy/)
  assert.match(source, /dense/)
  assert.match(source, /lexical/)
  assert.match(source, /hybrid/)
  assert.match(source, /recordRetrievalTrace\(env, evalCase, candidates, matchCount, latencyMs, strategyLabel/)
  assert.doesNotMatch(source, /answer-question\/index\.ts/)
})
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: fail because lexical RPC, helpers, strategy switch, and trace strategy propagation do not exist.

- [ ] **Step 3: Create eval-only lexical RPC**

Create `supabase/sql/20260602_rag_lexical_eval_rpc.sql`:

```sql
-- 20260602 — Eval-only lexical article retrieval.
-- Used by offline RAG replay only. Does not change production retrieval.

create extension if not exists pg_trgm;

create or replace function public.match_articles_lexical_eval(
  query_terms text[],
  match_count integer default 10
)
returns table (
  id uuid,
  title text,
  summary text,
  summary_en text,
  summary_zh text,
  article_content text,
  score_lexical double precision,
  embedding_source text
)
language sql
stable
security definer
set search_path = public
as $$
  with terms as (
    select lower(trim(term)) as term
    from unnest(query_terms) term
    where length(trim(term)) >= 2
    limit 16
  ),
  scored as (
    select
      n.id,
      coalesce(n.title, n.title_zh, n.title_en, '') as title,
      n.summary,
      n.summary_en,
      n.summary_zh,
      n.article_content,
      sum(
        greatest(
          similarity(lower(coalesce(n.title, '')), terms.term) * 4.0,
          similarity(lower(coalesce(n.title_en, '')), terms.term) * 4.0,
          similarity(lower(coalesce(n.title_zh, '')), terms.term) * 4.0,
          similarity(lower(coalesce(n.summary, '')), terms.term) * 2.0,
          similarity(lower(coalesce(n.summary_en, '')), terms.term) * 2.0,
          similarity(lower(coalesce(n.summary_zh, '')), terms.term) * 2.0,
          case when lower(coalesce(n.article_content, '')) like '%' || terms.term || '%' then 1.0 else 0.0 end
        )
      ) as score_lexical
    from public.daily_news n
    cross join terms
    where
      lower(coalesce(n.title, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.title_en, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.title_zh, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.summary, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.summary_en, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.summary_zh, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.article_content, '')) like '%' || terms.term || '%'
    group by n.id, n.title, n.title_en, n.title_zh, n.summary, n.summary_en, n.summary_zh, n.article_content
  )
  select
    scored.id,
    scored.title,
    scored.summary,
    scored.summary_en,
    scored.summary_zh,
    scored.article_content,
    scored.score_lexical,
    'lexical_eval_trigram_v1'::text as embedding_source
  from scored
  where scored.score_lexical > 0
  order by scored.score_lexical desc, scored.id
  limit greatest(match_count, 1);
$$;

revoke all on function public.match_articles_lexical_eval(text[], integer) from public;
grant execute on function public.match_articles_lexical_eval(text[], integer) to service_role;
```

- [ ] **Step 4: Add lexical helper functions**

Modify `scripts/rag-eval-lib.mjs` and add:

```js
export function extractLexicalTerms(question) {
  const normalized = String(question || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .trim()
  const spacedTerms = normalized
    .split(/\s+/)
    .filter(term => term.length >= 2)
  const chineseTerms = [...normalized.matchAll(/[\u3400-\u9fff]{2,8}/g)]
    .map(match => match[0])
  return [...new Set([...spacedTerms, ...chineseTerms])].slice(0, 16)
}

export async function fetchLexicalCandidates(env, question, matchCount = 10) {
  const queryTerms = extractLexicalTerms(question)
  if (queryTerms.length === 0) return []
  const rows = await rpc(env, 'match_articles_lexical_eval', {
    query_terms: queryTerms,
    match_count: matchCount,
  })
  return rows.map((row, index) => ({
    ...normalizeCandidate(row, index),
    score_lexical: row.score_lexical,
    score_final: row.score_lexical,
    embedding_source: row.embedding_source || 'lexical_eval_trigram_v1',
    metadata: { lexical_terms: queryTerms },
  }))
}

export function fuseCandidatesByRrf(candidateLists, k = 60) {
  const byId = new Map()
  for (const list of candidateLists) {
    for (const candidate of list) {
      const id = candidate.id || candidate.article_id
      if (!id) continue
      if (!byId.has(id)) {
        byId.set(id, {
          ...candidate,
          score_final: 0,
          metadata: { fusion_sources: [] },
        })
      }
      const existing = byId.get(id)
      existing.score_final += 1 / (k + (candidate.rank || 1))
      existing.score_dense = existing.score_dense ?? candidate.score
      existing.score_lexical = existing.score_lexical ?? candidate.score_lexical
      existing.metadata.fusion_sources.push(candidate.embedding_source)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score_final - a.score_final)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}
```

- [ ] **Step 5: Wire strategy switch into replay**

Modify `scripts/rag-eval-replay.mjs`.

Import helpers:

```js
  fetchLexicalCandidates,
  fuseCandidatesByRrf,
```

Parse strategy:

```js
const strategy = String(args.strategy || 'dense')
if (!['dense', 'lexical', 'hybrid'].includes(strategy)) {
  throw new Error('--strategy must be dense, lexical, or hybrid')
}
const strategyLabel = `${strategy}_${RETRIEVAL_STRATEGY}`
const retrieverName = strategy === 'dense'
  ? RETRIEVER_NAME
  : strategy === 'lexical'
    ? 'match_articles_lexical_eval'
    : `${RETRIEVER_NAME}+match_articles_lexical_eval`
```

Replace dense-only retrieval inside the case loop with:

```js
const { candidates, latencyMs } = await retrieveCandidates(env, evalCase, matchCount, strategy)
```

Add function:

```js
async function retrieveCandidates(env, evalCase, matchCount, strategy) {
  const start = Date.now()
  if (strategy === 'lexical') {
    const candidates = await fetchLexicalCandidates(env, evalCase.question, matchCount)
    return { candidates, latencyMs: Date.now() - start }
  }

  const queryEmbedding = await cohereEmbedSearchQuery(env.COHERE_API_KEY, evalCase.question)
  const rawDense = await rpc(env, 'match_articles_prefer_analysis', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
  })
  const denseCandidates = rawDense.map(normalizeCandidate).filter(row => row.id)
  if (strategy === 'dense') return { candidates: denseCandidates, latencyMs: Date.now() - start }

  const lexicalCandidates = await fetchLexicalCandidates(env, evalCase.question, matchCount)
  const candidates = fuseCandidatesByRrf([denseCandidates, lexicalCandidates]).slice(0, matchCount)
  return { candidates, latencyMs: Date.now() - start }
}
```

Set eval run strategy fields:

```js
retrieval_strategy: strategyLabel,
```

Pass trace labels when recording retrieval:

```js
const retrievalRun = await recordRetrievalTrace(
  env,
  evalCase,
  candidates,
  matchCount,
  latencyMs,
  strategyLabel,
  retrieverName,
  strategy
)
```

Update `recordRetrievalTrace` signature:

```js
async function recordRetrievalTrace(env, evalCase, candidates, matchCount, latencyMs, strategyLabel, retrieverName, strategy)
```

Inside the existing `rag_retrieval_runs` insert payload, replace the three strategy fields with:

```js
retrieval_strategy: strategyLabel,
retrieval_version: RETRIEVAL_VERSION,
retriever_name: retrieverName,
```

When recording candidate rows, set:

```js
score_dense: candidate.score ?? candidate.score_dense ?? null,
score_lexical: candidate.score_lexical ?? null,
score_final: candidate.score_final ?? candidate.score ?? candidate.score_lexical ?? null,
embedding_source: candidate.embedding_source,
metadata: {
  eval_case_id: evalCase.id,
  eval_set_id: evalCase.eval_set_id,
  replay_strategy: strategy,
  fusion_sources: candidate.metadata?.fusion_sources || null,
  lexical_terms: candidate.metadata?.lexical_terms || null,
},
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
node --test tests/*.test.mjs
```

Expected: all pass.

- [ ] **Step 7: Run exploratory offline baselines**

Run:

```bash
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending true --strategy dense
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending true --strategy lexical
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending true --strategy hybrid
```

Expected: three eval runs with comparable aggregate metrics marked as exploratory if pending gold is used.

- [ ] **Step 8: Commit**

```bash
git add supabase/sql/20260602_rag_lexical_eval_rpc.sql scripts/rag-eval-lib.mjs scripts/rag-eval-replay.mjs tests/rag-retrieval-refinement.test.mjs
git commit -m "feat: add replay-only lexical and hybrid rag baselines"
```

---

### Task 3: Expand Gold Coverage Before Official Baseline Comparison

**Files:**
- Modify: `scripts/rag-eval-generate-gold.mjs`
- Modify: `tests/rag-retrieval-refinement.test.mjs`

- [ ] **Step 1: Add failing static test for gold expansion**

Append:

```js
test('gold generation expands evidence beyond dense candidates before official comparison', () => {
  const source = readFileSync('scripts/rag-eval-generate-gold.mjs', 'utf8')

  assert.match(source, /--expand-candidates/)
  assert.match(source, /primary_article_baseline/)
  assert.match(source, /fetchLexicalCandidates/)
  assert.match(source, /fuseCandidatesByRrf/)
  assert.match(source, /candidate_sources/)
})
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: fail because gold generation does not yet expand candidate coverage.

- [ ] **Step 3: Import lexical and fusion helpers**

Modify `scripts/rag-eval-generate-gold.mjs` imports:

```js
import {
  DEFAULT_EVAL_SET,
  RETRIEVAL_STRATEGY,
  RETRIEVAL_VERSION,
  RETRIEVER_NAME,
  callTokenRouterJson,
  cohereEmbedSearchQuery,
  fetchLexicalCandidates,
  fuseCandidatesByRrf,
  normalizeCandidate,
  normalizeEvalQuestions,
  parseArgs,
  readEvalQuestions,
  requiredEnv,
  restInsert,
  restSelect,
  rpc,
  uuidIn,
} from './rag-eval-lib.mjs'
```

- [ ] **Step 4: Add expansion flag**

After argument parsing, add:

```js
const expandCandidates = args['expand-candidates'] === 'true'
```

- [ ] **Step 5: Add candidate expansion helper**

Add this helper near the existing candidate-loading logic:

```js
async function expandGoldCandidates(env, evalCase, denseCandidates, matchCount) {
  const candidateLists = [denseCandidates]

  const primaryBaseline = evalCase.primary_article_id
    ? await restSelect(
        env,
        `daily_news?select=id,title,summary,summary_en,summary_zh,article_content&id=eq.${evalCase.primary_article_id}&limit=1`
      )
    : []
  if (primaryBaseline[0]) {
    candidateLists.push(primaryBaseline.map((row, index) => ({
      ...normalizeCandidate(row, index),
      score_final: 1,
      embedding_source: 'primary_article_baseline',
      metadata: { candidate_sources: ['primary_article_baseline'] },
    })))
  }

  const lexicalCandidates = await fetchLexicalCandidates(env, evalCase.question, matchCount)
  candidateLists.push(lexicalCandidates)

  return fuseCandidatesByRrf(candidateLists)
    .slice(0, Math.max(matchCount, 20))
    .map(candidate => ({
      ...candidate,
      metadata: {
        ...candidate.metadata,
        candidate_sources: candidate.metadata?.fusion_sources
          || candidate.metadata?.candidate_sources
          || [candidate.embedding_source || 'dense'],
      },
    }))
}
```

- [ ] **Step 6: Use expanded candidates only when requested**

Where gold candidates are currently judged, replace the dense-only candidate variable with:

```js
const candidatesForJudging = expandCandidates
  ? await expandGoldCandidates(env, evalCase, denseCandidates, matchCount)
  : denseCandidates
```

When inserting `rag_eval_gold_evidence`, include the candidate source metadata:

```js
metadata: {
  judge_model: GOLD_MODEL,
  candidate_rank: index + 1,
  score_dense: candidate.score ?? candidate.score_dense ?? null,
  score_lexical: candidate.score_lexical ?? null,
  score_final: candidate.score_final ?? candidate.score ?? candidate.score_lexical ?? null,
  generated_latency_ms: Date.now() - start,
  embedding_input_type: QUERY_EMBEDDING_INPUT_TYPE,
  retrieval_strategy: expandCandidates ? 'expanded_dense_lexical_primary_baseline' : RETRIEVAL_STRATEGY,
  retrieval_version: RETRIEVAL_VERSION,
  retriever_name: expandCandidates ? `${RETRIEVER_NAME}+match_articles_lexical_eval+primary_article_baseline` : RETRIEVER_NAME,
  source: candidate.embedding_source,
  candidate_sources: candidate.metadata?.candidate_sources || [candidate.embedding_source || 'dense'],
}
```

- [ ] **Step 7: Run exploratory gold expansion**

Run:

```bash
npm run eval:generate-gold -- --set qa-v1-2026-06 --expand-candidates true
```

Expected: pending evidence rows include dense, lexical, hybrid/fusion, and `primary_article_baseline` sources. Human approval is still required before official comparisons.

- [ ] **Step 8: Run tests**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
node --test tests/*.test.mjs
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/rag-eval-generate-gold.mjs tests/rag-retrieval-refinement.test.mjs
git commit -m "feat: expand rag gold evidence candidate coverage"
```

---

### Task 4: Add Chunk Eval Scaffold

**Files:**
- Create: `supabase/sql/20260602_article_chunks_eval_scaffold.sql`
- Modify: `tests/rag-retrieval-refinement.test.mjs`

- [ ] **Step 1: Add failing test for chunk scaffold**

Append:

```js
test('chunk scaffold creates eval-only article chunk table', () => {
  const sql = readFileSync('supabase/sql/20260602_article_chunks_eval_scaffold.sql', 'utf8')

  assert.match(sql, /create table if not exists public\.article_chunks/)
  assert.match(sql, /chunking_version/)
  assert.match(sql, /chunking_params/)
  assert.match(sql, /chunk_hash/)
  assert.match(sql, /unique \(article_id, chunking_version, chunk_hash\)/)
  assert.match(sql, /unique \(article_id, chunking_version, chunk_index\)/)
  assert.match(sql, /embedding vector\(1024\)/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /revoke all on public\.article_chunks from anon, authenticated/)
})
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: missing file failure.

- [ ] **Step 3: Create chunk scaffold SQL**

Create `supabase/sql/20260602_article_chunks_eval_scaffold.sql`:

```sql
-- 20260602 — Eval-only article chunks scaffold.
-- This table is not used by production retrieval until a later gated rollout.

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists public.article_chunks (
  id                       uuid primary key default gen_random_uuid(),
  article_id               uuid not null references public.daily_news(id) on delete cascade,
  source_id                uuid references public.sources(id) on delete set null,
  chunking_version         text not null,
  chunking_params          jsonb not null default '{}'::jsonb,
  chunk_index              integer not null,
  chunk_text               text not null,
  chunk_hash               text not null,
  boundary_type            text not null check (boundary_type in ('paragraph', 'heading', 'semantic', 'sliding_window')),
  char_start               integer,
  char_end                 integer,
  token_estimate           integer,
  language                 text not null default 'unknown',
  embedding                vector(1024),
  embedding_model          text,
  embedding_input_type     text,
  created_at               timestamptz not null default now(),

  unique (article_id, chunking_version, chunk_hash),
  unique (article_id, chunking_version, chunk_index)
);

create index if not exists article_chunks_article_idx
  on public.article_chunks(article_id, chunking_version, chunk_index);

create index if not exists article_chunks_no_embedding_idx
  on public.article_chunks(id)
  where embedding is null;

create index if not exists article_chunks_embedding_hnsw_idx
  on public.article_chunks
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table public.article_chunks enable row level security;

revoke all on public.article_chunks from anon, authenticated;
grant all on public.article_chunks to service_role;
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/sql/20260602_article_chunks_eval_scaffold.sql tests/rag-retrieval-refinement.test.mjs
git commit -m "feat: add eval-only article chunks scaffold"
```

---

### Task 5: Add On-Demand Chunk Backfill CLI

**Files:**
- Create: `scripts/rag-chunk-backfill.mjs`
- Modify: `package.json`
- Modify: `tests/rag-retrieval-refinement.test.mjs`

- [ ] **Step 1: Add failing static test**

Append:

```js
test('chunk backfill script preserves paragraph boundaries and embeds with search_document', () => {
  const source = readFileSync('scripts/rag-chunk-backfill.mjs', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.equal(pkg.scripts['eval:chunk-backfill'], 'node scripts/rag-chunk-backfill.mjs')
  assert.match(source, /CHUNKING_VERSION/)
  assert.match(source, /chunking_version/)
  assert.match(source, /splitArticleIntoChunks/)
  assert.match(source, /embedChunksInBatches/)
  assert.match(source, /fetchWithRetry/)
  assert.match(source, /boundary_type: 'paragraph'/)
  assert.match(source, /input_type: 'search_document'/)
  assert.match(source, /article_chunks/)
})
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: missing script/package entry failure.

- [ ] **Step 3: Add package command**

Modify root `package.json` scripts:

```json
"eval:chunk-backfill": "node scripts/rag-chunk-backfill.mjs"
```

- [ ] **Step 4: Create chunk backfill script**

Create `scripts/rag-chunk-backfill.mjs`:

```js
#!/usr/bin/env node

import crypto from 'node:crypto'
import process from 'node:process'

import {
  fetchWithRetry,
  parseArgs,
  requiredEnv,
  restInsert,
  restSelect,
} from './rag-eval-lib.mjs'

const CHUNKING_VERSION = 'paragraph-window-v1-2026-06-02'
const CHUNKING_PARAMS = {
  targetChars: 3200,
  overlapChars: 600,
}

async function main() {
  const args = parseArgs()
  const env = requiredEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'COHERE_API_KEY'])
  const limit = Number(args.limit || 20)
  const minChars = Number(args['min-chars'] || 5000)

  const rows = await restSelect(
    env,
    `daily_news?select=id,source_id,title,article_content,summary,summary_en,summary_zh&article_content=not.is.null&order=created_at.desc&limit=${limit}`
  )
  const articles = rows.filter(row => String(row.article_content || '').length >= minChars)
  let chunksWritten = 0

  for (const article of articles) {
    const chunks = splitArticleIntoChunks(
      article.article_content,
      CHUNKING_PARAMS.targetChars,
      CHUNKING_PARAMS.overlapChars
    )
    if (chunks.length === 0) continue
    const embeddings = await embedChunksInBatches(env.COHERE_API_KEY, chunks.map(chunk => chunk.chunk_text))
    const insertRows = chunks.map((chunk, index) => ({
      article_id: article.id,
      source_id: article.source_id,
      chunking_version: CHUNKING_VERSION,
      chunking_params: CHUNKING_PARAMS,
      chunk_index: index,
      chunk_text: chunk.chunk_text,
      chunk_hash: sha256(chunk.chunk_text),
      boundary_type: 'paragraph',
      char_start: chunk.char_start,
      char_end: chunk.char_end,
      token_estimate: Math.ceil(chunk.chunk_text.length / 4),
      language: detectLanguage(chunk.chunk_text),
      embedding: `[${embeddings[index].join(',')}]`,
      embedding_model: 'embed-english-v3.0',
      embedding_input_type: 'search_document',
    }))
    await restInsert(env, 'article_chunks', insertRows, {
      upsert: true,
      onConflict: 'article_id,chunking_version,chunk_hash',
    })
    chunksWritten += insertRows.length
    console.log(`chunked ${insertRows.length}: ${article.title || article.id}`)
  }

  console.log(`Done. Wrote/upserted ${chunksWritten} chunks.`)
}

export function splitArticleIntoChunks(text, targetChars = 3200, overlapChars = 600) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
  const chunks = []
  let buffer = ''
  let start = 0
  let cursor = 0

  for (const paragraph of paragraphs) {
    const paragraphStart = text.indexOf(paragraph, cursor)
    const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    if (next.length > targetChars && buffer) {
      chunks.push({ chunk_text: buffer, char_start: start, char_end: start + buffer.length })
      const overlap = buffer.slice(Math.max(0, buffer.length - overlapChars))
      buffer = `${overlap}\n\n${paragraph}`
      start = Math.max(0, paragraphStart - overlap.length)
    } else {
      if (!buffer) start = paragraphStart >= 0 ? paragraphStart : cursor
      buffer = next
    }
    cursor = paragraphStart >= 0 ? paragraphStart + paragraph.length : cursor + paragraph.length
  }

  if (buffer) chunks.push({ chunk_text: buffer, char_start: start, char_end: start + buffer.length })
  return chunks
}

async function embedChunksInBatches(cohereApiKey, texts, batchSize = 64) {
  const embeddings = []
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize)
    const batchEmbeddings = await embedChunkBatch(cohereApiKey, batch)
    if (batchEmbeddings.length !== batch.length) {
      throw new Error(`Cohere returned ${batchEmbeddings.length} embeddings for ${batch.length} chunks`)
    }
    embeddings.push(...batchEmbeddings)
  }
  return embeddings
}

async function embedChunkBatch(cohereApiKey, texts) {
  const res = await fetchWithRetry('https://api.cohere.com/v1/embed', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cohereApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'embed-english-v3.0',
      input_type: 'search_document',
      texts: texts.map(text => text.slice(0, 4000)),
    }),
  })
  if (!res.ok) throw new Error(`Cohere chunk embed ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const json = await res.json()
  return json.embeddings
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function detectLanguage(text) {
  return /[\u3400-\u9fff]/.test(text) ? 'zh' : 'en'
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 5: Run checks**

Run:

```bash
node --check scripts/rag-chunk-backfill.mjs
node --test tests/rag-retrieval-refinement.test.mjs
node --test tests/*.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Run small backfill smoke test**

After applying `20260602_article_chunks_eval_scaffold.sql` in Supabase:

```bash
npm run eval:chunk-backfill -- --limit 3 --min-chars 5000
```

Verify:

```sql
select
  count(*) as chunks,
  count(*) filter (where embedding is not null) as embedded_chunks,
  count(distinct article_id) as articles
from public.article_chunks;
```

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/rag-chunk-backfill.mjs tests/rag-retrieval-refinement.test.mjs
git commit -m "feat: add on-demand article chunk backfill"
```

---

### Task 6: Compare Baselines and Decide the Next Lever

**Files:**
- Modify: `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`

- [ ] **Step 1: Add cross-run comparison query**

Append:

```sql
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
```

- [ ] **Step 2: Run approved-gold preflight**

Run query 6 from `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`.

Expected: `cases_without_relevant_gold = 0`. If `cases_with_only_pending_relevant_gold > 0`, finish human approval before official comparison or explicitly mark the next runs as exploratory.

- [ ] **Step 3: Run official replay strategies**

Run:

```bash
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy dense
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy lexical
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy hybrid
```

- [ ] **Step 4: Run comparison SQL**

Run query 7 from `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`.

Expected decision guide:

- If hybrid improves Recall@10 and MRR materially without high latency: next plan should evaluate a production-safe hybrid RPC.
- If lexical improves primary article recall but hurts NDCG: next plan should test a reranker over hybrid candidates.
- If all article-level strategies remain poor: next plan should move to chunk replay using `article_chunks`.

- [ ] **Step 5: Commit**

```bash
git add supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql
git commit -m "chore: add rag baseline comparison query"
```

---

## Verification Checklist

- [ ] `node --test tests/*.test.mjs` passes.
- [ ] `git diff --check` passes.
- [ ] `npm run eval:generate-gold -- --set qa-v1-2026-06 --expand-candidates true` has produced expanded candidate evidence for human review.
- [ ] Diagnostic SQL preflight shows every official comparison case has approved relevant gold evidence.
- [ ] `npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy dense` records an eval run.
- [ ] `npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy lexical` records an eval run.
- [ ] `npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy hybrid` records an eval run.
- [ ] Diagnostic SQL shows latest baseline comparison.
- [ ] No production Edge Function or frontend retrieval code changed.

---

## Self-Review

**Spec coverage:** This plan implements the architecture’s next measurement loop: trace-backed replay, expanded gold coverage, one-lever comparison, and chunk scaffold. It does not implement production chunk retrieval, reranking, badcase queue, or generation scoring; those are later plans after this baseline comparison.

**Placeholder scan:** No TODO/TBD placeholders. All commands and SQL are explicit.

**Type consistency:** Strategy names are `dense`, `lexical`, and `hybrid` across tests, scripts, SQL metadata, eval-run rows, and retrieval-trace rows.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-rag-retrieval-refinement-next-steps.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
