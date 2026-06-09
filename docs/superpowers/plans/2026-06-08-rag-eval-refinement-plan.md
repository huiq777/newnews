# RAG Eval Refinement And Agentic RAG Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RAG evaluation harder, more production-like, and ready for a future Agentic RAG layer without changing production `answer-question` yet.

**Architecture:** Keep current production retrieval unchanged. Add corpus-health preflight, eval taxonomy, hard negatives, query rewrite replay, rerank replay, generation eval, then build an eval-only Agentic RAG runtime orchestrator that can later be feature-flagged into `answer-question` after it passes trace, latency, loop-safety, retrieval, and generation gates.

**Tech Stack:** Supabase PostgreSQL, pgvector, `rag_eval_*`, `rag_retrieval_*`, `article_chunks`, Node 20 eval scripts, Cloudflare Workers AI `@cf/baai/bge-m3`, Cloudflare Workers AI `@cf/baai/bge-reranker-base`, TokenRouter judge fallback.

---

## Post-Run Status — 2026-06-09

This plan has been implemented as an eval-only stack. Corpus health now passes for run `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`, with zero chunk blockers, missing BGE embeddings, and stale-source blockers all at `0`.

Latest strategy-valid replay selects `chunk_dense @cf/baai/bge-m3` as the practical production candidate on 21 approved cases: Recall@5 `0.895`, Recall@10 `0.943`, MRR `0.739`, NDCG@10 `0.764`, Hit@5 `0.952`, with p50/p95 as low as `1179/3425ms`. `rerank_hybrid` is quality-best but latency-fails at p95 `68056ms`. Generation eval for `chunk_dense` currently aggregates to faithfulness `0.994`, answer relevancy `0.950`, context precision `0.785`, and context recall `0.819` across 24 judged rows; group by `eval_run_id` before treating that as a locked benchmark.

Production `answer-question` remains unchanged. The next implementation plan should be a feature-flagged chunk retrieval rollout with rollback and production trace checks.

---

## Current Truth

- Production `answer-question` still uses article-level dense retrieval via `match_articles_prefer_analysis`, which prefers ready Deep Analysis when available and falls back to article embeddings. Older docs may use `match_articles` as shorthand for the article-level dense retriever family; this plan uses the exact deployed RPC name.
- Latest leading offline chunk baseline is `chunk_dense @cf/baai/bge-m3`, pending Task 0 corpus-health preflight before release-grade strategy selection.
- Latest recorded metrics on 21 approved cases:
  - Recall@5 `0.710`
  - Recall@10 `0.757`
  - MRR `0.620`
  - NDCG@10 `0.658`
  - Hit@5 `0.810`
  - p50/p95 `1843/4429ms`
- `entity_hybrid` has stronger quality but p95 `11559ms`, so it remains eval-only.
- Generation quality is not yet measured.
- Agentic RAG is planned, not shipped.

## Token And Capacity Gates

Before running any LLM-heavy replay, write a budget line in the run notes:

| Path | LLM Calls Added | Default Limit | Budget Rule |
|---|---|---:|---|
| Query rewrite: entity expansion | Optional TokenRouter call if non-rule-based | 5 cases unless approved | Must estimate tokens before full 21-case run. |
| Query rewrite: HyDE | 1 generation call per case | 5 cases unless approved | Full run likely exceeds 5K tokens; requires review. |
| Query rewrite: decomposition/context completion | 1 planner call per case | 5 cases unless approved | Cache by normalized query + mode + model. |
| Generation eval answer generation | 1 answer call per case | 3 cases unless approved | Full run is a new LLM workload; requires review. |
| Generation eval judge | 1 judge call per answer | 3 cases unless approved | Store judge prompt version and token estimate. |
| Agentic planner/critique | 1-3 calls per complex case | 3 cases unless approved | Must enforce timeout and fallback to linear retrieval. |
| Cloudflare BGE rerank | No Groq TPD | 21 cases allowed | Track latency/cost separately; cache by candidate set. |

Rules:

- Any run expected to add more than 5,000 Groq/LLM tokens/day needs architecture review.
- Every new CLI must support `--max-cases`, `--dry-run-budget`, and cache reuse.
- Full official metrics should only run after a small cached smoke run succeeds.
- TokenRouter/OpenRouter calls still need cost notes even when they do not hit the Groq TPD cap.

Until `rag_eval_runs` has a dedicated JSONB metadata column, `rag_eval_runs.notes` must contain a parseable JSON object for LLM-heavy runs:

```json
{
  "notes_schema_version": "rag-eval-run-notes-v1",
  "estimated_tokens": 0,
  "actual_tokens": null,
  "max_cases": 3,
  "cache_policy": "read_write",
  "timeout_ms": 120000,
  "budget_approved_by": null,
  "llm_call_count": 0,
  "models": [],
  "dry_run_budget": true,
  "valid_for_strategy_selection": false,
  "invalid_reason": "corpus_health_not_checked",
  "corpus_health_run_id": null
}
```

If a later migration adds `rag_eval_runs.metadata jsonb`, move these keys there and keep `notes` human-readable only. Parsers must tolerate old non-JSON or nonconforming `notes` text as legacy and treat those runs as `valid_for_strategy_selection = false` for release interpretation unless manually overridden.

## Task 0: Add Corpus Health Preflight Gate

**Files:**

- Create: `supabase/sql/20260608_rag_eval_corpus_health.sql`
- Modify: `scripts/rag-eval-replay.mjs`
- Modify: `tests/rag-retrieval-refinement.test.mjs`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`

- [ ] Create a corpus-health run source of truth:
  - preferred table: `rag_eval_corpus_health_runs`
  - columns: `id`, `eval_set_id`, `chunking_version`, `embedding_model`, `ready_for_taxonomy`, `ready_for_hard_negatives`, `ready_for_replay`, `summary jsonb not null default '{}'::jsonb`, `created_at`
  - `summary` keys: `zero_chunk_gold_articles`, `missing_bge_embedding_gold_articles`, `stale_source_count`, `deep_analysis_pending`, `deep_analysis_processing_stale`, `deep_analysis_retryable_errors`, `short_or_empty_ineligible_articles`
  - RLS/grants: enable RLS, revoke anon/authenticated, grant service_role
  - if this table is not implemented in the first pass, `corpus_health_run_id` must remain `null` and `invalid_reason` must explain that no persisted corpus-health run exists

- [ ] Add read-only SQL for source freshness by source type:
  - active WeChat / Reddit / YouTube rows in the last 24h
  - newest raw row per active source
  - newest processed `daily_news` row per active source

- [ ] Add Deep Analysis readiness:
  - eligible ready count
  - pending count
  - processing older than 15 minutes
  - retryable error count
  - short/empty ineligible count

- [ ] Add chunk and embedding coverage:
  - approved gold articles with zero chunks
  - approved gold articles without `@cf/baai/bge-m3` chunk embeddings
  - chunk count by `chunking_version`

- [ ] Add stop/go summary:
  - `ready_for_taxonomy`
  - `ready_for_hard_negatives`
  - `ready_for_replay`

- [ ] Update `scripts/rag-eval-replay.mjs` to write run validity metadata into `rag_eval_runs.notes`:
  - `notes_schema_version = 'rag-eval-run-notes-v1'`
  - `valid_for_strategy_selection`
  - `invalid_reason`
  - `corpus_health_run_id`
  - inputs may come from `--corpus-health-run-id`, `--valid-for-strategy-selection`, and `--invalid-reason`; if omitted, replay must default to `valid_for_strategy_selection = false`

- [ ] Add legacy-safe parsing helpers for `rag_eval_runs.notes`:
  - parse valid JSON notes with `notes_schema_version`
  - tolerate legacy text or older JSON without throwing
  - default legacy/nonconforming notes to `valid_for_strategy_selection = false`

Acceptance:

- Labeling-only work may proceed when corpus coverage is incomplete:
  - taxonomy backfill
  - hard-negative proposal/review
  - source-note annotation
- Chunk-dependent strategy selection, release interpretation, and resume-quality claims are blocked if approved gold articles have zero chunks or missing `@cf/baai/bge-m3` chunk embeddings.
- Article-level dense/lexical baselines may still run as diagnostics when chunk health fails, but must be marked `valid_for_strategy_selection = false` and `invalid_reason = 'chunk_corpus_health_failed'`.
- Rewrite, rerank, generation, and Agentic RAG eval may run only as smoke tests with `valid_for_strategy_selection = false` until corpus health passes.
- The progress doc records the latest corpus-health result before metric interpretation.

## Task 1: Add Eval Case Taxonomy

**Files:**

- Modify: `docs/superpowers/specs/2026-06-01-rag-golden-dataset-v1-design.md`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`
- Create: `supabase/sql/20260608_rag_eval_case_taxonomy.sql`

- [ ] Add metadata fields or JSON conventions for:
  - `format_cohort`
  - `content_length_bucket`
  - `source_type`
  - `language`
  - `question_type`
  - `difficulty_tags`
  - `entity_density`
  - `origin`

- [ ] Backfill existing 21 cases with best-effort taxonomy labels.

- [ ] Add read-only SQL to report metrics by taxonomy slice.

Acceptance:

- Every approved eval case has at least `format_cohort`, `content_length_bucket`, `source_type`, `question_type`, `entity_density`, and `origin`.
- Metrics can be grouped by short news, long-form, transcript/social, official, entity-heavy, and multi-hop.

## Task 2: Add Hard Negative Evaluation

**Files:**

- Create: `supabase/sql/20260608_rag_eval_hard_negatives.sql`
- Modify: `scripts/rag-eval-generate-gold.mjs`
- Modify: `scripts/rag-eval-replay.mjs`
- Modify: `tests/rag-retrieval-refinement.test.mjs`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`

- [ ] Add a convention for hard-negative evidence rows:
  - `metadata->>'evidence_role' = 'hard_negative'`
  - `relevance_grade = 0`
  - same-topic wrong event
  - same entity wrong time
  - same source wrong article
  - semantically similar but not answer-supporting
  - this metadata convention is canonical unless a later migration adds a real `evidence_role` column and updates metric code first

- [ ] Add candidate selection SQL that proposes 5-10 hard negatives per approved case.

- [ ] Add controlled negative injection:
  - passive diagnostics first: report whether normal retrieval ranks hard negatives above approved gold
  - forced rerank stress second: inject hard negatives before fusion/rerank only when testing reranker discrimination
  - never append hard negatives after ranking and call the resulting movement an MRR/NDCG drop
  - hard negatives are not included in `relevantGold`
  - hard negatives do not contribute positive NDCG gain
  - diagnostics separately count hard negatives above approved gold

- [ ] Update replay diagnostics to show:
  - hard negatives ranked above gold
  - gold rank after hard-negative injection
  - MRR/NDCG drop caused by distractors

- [ ] Add test coverage asserting `metadata->>'evidence_role' = 'hard_negative'` can never have `relevance_grade > 0`.

- [ ] Add DB check constraint:
  - `check ((metadata->>'evidence_role' is distinct from 'hard_negative') or relevance_grade = 0)`

Acceptance:

- At least 10 cases have human-approved hard negatives.
- Leaderboard includes a hard-negative slice.
- Any hard negative outranking gold is visible by case.
- A hard negative can never improve Recall, MRR, Hit@5, or NDCG.

## Task 3: Add Query Rewrite Replay Modes

**Files:**

- Modify: `scripts/rag-eval-lib.mjs`
- Modify: `scripts/rag-eval-replay.mjs`
- Create: `supabase/sql/20260608_rag_query_rewrite_diagnostics.sql`

- [ ] Add eval-only rewrite modes:
  - `none`
  - `entity_expansion`
  - `hyde`
  - `decomposition`
  - `context_completion`

- [ ] Add drift guardrail metadata:
  - original query
  - rewritten query
  - rewrite mode
  - accepted or rejected
  - reject reason

- [ ] Define measurable drift behavior:
  - baseline retrieval always runs for comparison
  - default BGE cosine threshold: accept rewrite only when original-vs-rewrite similarity is `>= 0.82`
  - if BGE similarity is unavailable, use an LLM judge only in capped runs
  - rejected rewrites fall back to original-query candidates
  - diagnostics list rejected rewrites and top candidate divergence

- [ ] Add replay labels such as:
  - `chunk_dense_rewrite_none`
  - `chunk_dense_rewrite_entity_expansion`
  - `chunk_dense_rewrite_hyde`
  - `agentic_decomposition_eval`

Acceptance:

- Rewrites are eval-only.
- Simple questions can skip rewrite.
- Rewritten queries are traceable and can be compared against original-query replay.
- Drift threshold and fallback behavior are recorded in trace metadata.

## Task 4: Add Rerank Replay With Cloudflare BGE Reranker

**Files:**

- Modify: `scripts/rag-eval-lib.mjs`
- Modify: `scripts/rag-eval-replay.mjs`
- Create: `supabase/sql/20260608_rag_eval_rerank_cache.sql`
- Modify: `tests/rag-retrieval-refinement.test.mjs`
- Modify: `package.json`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`

- [ ] Add `@cf/baai/bge-reranker-base` rerank helper.

- [ ] Add Cloudflare Workers AI adapter contract:
  - env: `CLOUDFLARE_ACCOUNT_ID`
  - env: `CLOUDFLARE_AUTH_TOKEN`
  - endpoint: `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/baai/bge-reranker-base`
  - request body: `{ "query": string, "contexts": [{ "text": string }], "top_k": number }`
  - response mapping: map returned result indices/scores back to the original ordered candidate ids; never assume the response order equals input order
  - `top_k` defaults to the input candidate count and must be no larger than `contexts.length`
  - cache key must include the ordered candidate ids and the exact context text hash used for each candidate

- [ ] Add package script:
  - `eval:rerank`: `node scripts/rag-eval-replay.mjs --strategy rerank_hybrid`

- [ ] Use TokenRouter LLM judge rerank only as fallback/audit.

- [ ] Rerank overfetched dense + lexical/entity candidates.

- [ ] Store:
  - `score_rerank`
  - rerank model
  - rerank input candidate ids
  - rerank cache key
  - cache hit/miss
  - rerank latency

- [ ] Add cache convention:
  - persistence target: `rag_eval_rerank_cache`
  - key = hash of normalized query, ordered candidate ids, rerank model, chunking version, and strategy variant
  - value = ordered candidate ids with rerank scores, model metadata, latency, created_at, and cache_version
  - database constraints: `unique(cache_key)`, `cache_version not null`, `stale_reason text null`
  - access: RLS enabled, no anon/authenticated policies, service-role grants only
  - invalidation: model id, chunking version, strategy variant, or candidate id ordering changes must produce a different cache key; explicit stale rows keep `stale_reason`
  - cached rows can be reused for repeated sweeps
  - p95 reports must distinguish cold-cache and warm-cache runs

- [ ] Extend rerank tests to cover:
  - Cloudflare rerank helper selection
  - TokenRouter judge fallback/audit mode
  - rerank cache key composition
  - cache hit/miss trace metadata
  - cold and warm latency fields

Acceptance:

- Rerank replay reports MRR/NDCG movement.
- p95 latency is reported separately.
- p95 is not interpreted without cache-hit metadata.
- Rerank remains eval-only unless it passes latency gate.

## Task 5: Add Generation Evaluation

**Files:**

- Create: `supabase/sql/20260608_rag_generation_eval.sql`
- Create: `scripts/rag-eval-generate-answers.mjs`
- Create: `scripts/rag-eval-judge-answers.mjs`
- Create: `tests/rag-generation-eval.test.mjs`
- Modify: `package.json`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`

- [ ] Create exact generation eval tables with service-role-only access:
  - `rag_generation_eval_results`
  - columns: `id`, `eval_run_id`, `case_id`, `retrieval_run_id`, `generation_eval_mode`, `context_pack_version`, `context_hash`, `context_chars`, `context_text`, `answer_text`, `answer_model`, `answer_prompt_version`, `judge_model`, `judge_prompt_version`, `faithfulness_score`, `answer_relevancy_score`, `context_precision_score`, `context_recall_score`, `human_override_score`, `human_override_notes`, `metadata`, `created_at`
  - constraints: FK to `rag_eval_runs`, `rag_eval_cases`, and nullable FK to `rag_retrieval_runs`; unique `(eval_run_id, case_id, generation_eval_mode, context_pack_version)`
  - RLS/grants: enable RLS, revoke anon/authenticated, grant service_role
  - if `context_text` is later split into a child table, the parent row must keep `context_hash`/`context_chars` and the child table must be linked by `generation_eval_result_id`

- [ ] Add package scripts:
  - `eval:generate-answers`: `node scripts/rag-eval-generate-answers.mjs`
  - `eval:judge-answers`: `node scripts/rag-eval-judge-answers.mjs`

- [ ] Add static contract tests for:
  - generation eval schema columns, constraints, RLS/grants
  - package scripts above
  - context reproducibility through `context_text` or linked child table

- [ ] Add two explicit generation eval modes:
  - `inline_article_generation_eval`: mirrors production inline Q&A, including primary article context before related retrieval
  - `corpus_retrieval_generation_eval`: answers only from retrieved corpus candidates, excluding privileged primary article context, so retrieval strategy differences remain visible

- [ ] Add a production-like context pack builder for `inline_article_generation_eval` matching `answer-question.retrieve()`:
  - primary article Deep Analysis context when ready
  - compact context
  - capped raw article content fallback
  - related article context cap
  - max related article count
  - packed context character count and hash

- [ ] Store `context_pack_version = 'answer-question-v1-prefer-analysis'` with every generation eval row.

- [ ] Store `generation_eval_mode` with every row and report the two modes separately.

- [ ] Keep strategy-only context packs as `corpus_retrieval_generation_eval`, not as the default inline answer-quality claim.

- [ ] Generate answers from selected retrieval strategies.

- [ ] Judge:
  - faithfulness / groundedness
  - answer relevancy
  - context precision
  - context recall

- [ ] Store:
  - generated answer
  - injected context
  - judge model
  - judge prompt version
  - scores
  - human override

Acceptance:

- Retrieval metrics and generation metrics are reported separately.
- No resume or production doc claims answer accuracy from retrieval metrics alone.

## Task 6: Implement Agentic RAG Runtime Orchestrator

This task builds the actual Agentic RAG control flow. It must run eval-only first, but the module boundaries should be compatible with a later feature-flagged production integration in `answer-question`.

**Files:**

- Create: `scripts/rag-agentic-runtime.mjs`
- Create: `tests/rag-agentic-runtime.test.mjs`
- Modify: `scripts/rag-eval-lib.mjs`
- Modify: `scripts/rag-eval-replay.mjs`
- Modify: `package.json`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`

- [ ] Add package script:
  - `eval:agentic-runtime`: `node scripts/rag-agentic-runtime.mjs`

- [ ] Add `classifyAgenticIntent(question, conversationContext)`:
  - simple
  - entity-heavy
  - ambiguous follow-up
  - comparison
  - multi-hop
  - low-context/conflicting evidence

- [ ] Add `buildAgenticPlan(question, intent, conversationContext)` returning:
  - `plan_id`
  - `intent`
  - `subqueries` with one to three retrieval subgoals
  - `required_evidence`
  - `stop_condition`
  - `timeout_budget_ms`

- [ ] Add `runAgenticRetrievalStep(plan, subquery, strategyOptions)`:
  - uses current `chunk_dense @cf/baai/bge-m3` as the default retriever
  - can opt into lexical/entity hybrid
  - can opt into rerank after overfetch
  - returns candidates plus trace metadata

- [ ] Add `critiqueRetrievedContext(question, plan, candidates)` returning:
  - context sufficiency
  - relevance
  - conflict check
  - answerability
  - retry reason if another retrieval round is allowed

- [ ] Add `orchestrateAgenticRag(question, options)`:
  - routes simple questions back to the linear `chunk_dense` path
  - decomposes complex questions into subqueries
  - runs retrieval for each subquery
  - critiques the merged context
  - permits at most one re-retrieval round
  - returns final candidate context plus a complete agent trace

- [ ] Add production-compatible integration contract, but do not enable production:

```ts
type AgenticRagResult = {
  mode: 'linear_fallback' | 'agentic'
  intent: string
  plan: {
    plan_id: string
    subqueries: Array<{ id: string; query: string; purpose: string }>
    required_evidence: string[]
    stop_condition: string
  }
  candidates: Array<{
    article_id: string
    chunk_id: string | null
    title: string
    chunk_text: string | null
    summary: string
    rank: number
    score_dense: number | null
    score_lexical: number | null
    score_rerank: number | null
    score_final: number
    source_strategy: 'chunk_dense' | 'lexical' | 'entity_hybrid' | 'rerank_hybrid'
    metadata: Record<string, unknown>
  }>
  context_pack: {
    text: string
    article_ids: string[]
    chunk_ids: string[]
    context_chars: number
    context_hash: string
  }
  critique: {
    sufficient: boolean
    answerable: boolean
    retry_reason: string | null
  }
  trace: {
    retrieval_rounds: number
    subquery_count: number
    stop_reason: string
    latency_ms: number
  }
}
```

- [ ] Enforce guardrails:
  - max two retrieval rounds
  - max three subqueries
  - hard timeout budget
  - no external web browsing
  - fallback to linear retrieval on planner or critique failure
  - deterministic trace output for every run
  - JSON schema validation for planner, critique, candidates, and context pack

Acceptance:

- The runtime can execute a full agentic path in offline replay without touching production `answer-question`.
- Simple questions are routed to the linear path.
- Multi-hop/comparison questions produce multiple subqueries.
- Critique can trigger exactly one bounded re-retrieval round.
- Trace output includes `plan_id`, `intent`, `subqueries`, `retrieval_rounds`, `critique`, `stop_reason`, and `latency_ms`.

## Task 7: Add Agentic RAG Eval Harness

**Files:**

- Create: `supabase/sql/20260608_agentic_rag_eval_trace.sql`
- Create: `scripts/rag-agentic-eval-replay.mjs`
- Create: `tests/rag-agentic-eval.test.mjs`
- Modify: `scripts/rag-agentic-runtime.mjs`
- Modify: `package.json`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`

- [ ] Wire `scripts/rag-agentic-eval-replay.mjs` to call `orchestrateAgenticRag()`.

- [ ] Add package script:
  - `eval:agentic`: `node scripts/rag-agentic-eval-replay.mjs`

- [ ] Add static contract tests for:
  - agentic trace schema columns, constraints, RLS/grants
  - package script above
  - required trace fields for planner, critique, retry, and stop reason

- [ ] Store agentic trace rows:
  - `plan_id`
  - `intent`
  - `subquery`
  - `retrieval_round`
  - `strategy`
  - `candidate_count`
  - `critique_sufficient`
  - `critique_answerable`
  - `retry_reason`
  - `stop_reason`
  - `latency_ms`

- [ ] Report agentic metrics by eval slice:
  - multi-hop
  - comparison
  - ambiguous follow-up
  - entity-heavy
  - low-context/conflicting evidence

Acceptance:

- Agentic replay has its own metrics slice.
- Multi-hop Recall@10 beats the linear `chunk_dense` baseline before any production consideration.
- Each agentic decision slice must have `n >= 5` approved cases before pass/fail language; smaller slices are directional only.
- Loop safety is explicitly measured.
- p95 latency stays below the agentic gate or remains eval-only.

## Task 8: Update Interview And Resume Brief

**Files:**

- Modify: `docs/project-interview-resume-brief.md`

- [ ] Keep real metric numbers unchanged unless reruns produce new recorded results.

- [ ] Add a concise "Agentic RAG implemented eval runtime" section only after Tasks 6 and 7 have trace/eval output.

- [ ] Keep honest boundaries:
  - offline retrieval, not production answer accuracy
  - 21 cases is engineering-gate scale
  - generation eval still separate
  - Agentic RAG remains eval-only until production feature flag, rollback, latency, loop-safety, retrieval, and generation gates pass

Acceptance:

- Resume bullets remain truthful and defensible in interview.
- No unverified production claims are added.

## Execution Order

1. Task 0: corpus-health preflight gate.
2. Task 1: eval taxonomy.
3. Task 2: hard negatives.
4. Task 4: rerank replay.
5. Task 3: query rewrite replay.
6. Task 5: generation eval.
7. Task 6: Agentic RAG runtime orchestrator.
8. Task 7: Agentic RAG eval harness.
9. Task 8: resume/interview brief update.

## Immediate Next Commands

After implementation begins, run current baseline before changing eval code:

```bash
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy chunk_dense --chunking-version paragraph-window-v1-2026-06-02
```

Check current recorded metrics:

```sql
select
  r.retrieval_strategy,
  m.total_cases,
  round(m.avg_recall_at_5::numeric, 3) as recall_at_5,
  round(m.avg_recall_at_10::numeric, 3) as recall_at_10,
  round(m.avg_mrr::numeric, 3) as mrr,
  round(m.avg_ndcg_at_10::numeric, 3) as ndcg_at_10,
  round(m.avg_hit_rate_at_5::numeric, 3) as hit_at_5,
  m.latency_p50_ms,
  m.latency_p95_ms,
  r.created_at
from rag_eval_runs r
join rag_eval_retrieval_metrics m on m.eval_run_id = r.id
order by r.created_at desc
limit 10;
```

## Stop Conditions

- Stop if source/chunk coverage is stale.
- Stop if eval labels are not human-approved.
- Stop if a strategy improves quality but p95 latency fails gate.
- Stop if generation eval contradicts retrieval optimism.
- Stop if Agentic RAG adds loops without measurable multi-hop benefit.
