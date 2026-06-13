# answer-question Chunk Dense Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live `answer-question` use `chunk_dense @cf/baai/bge-m3` as the default production retriever based on the valid 21-case gold-set replay, so normal production traffic no longer uses article-level dense retrieval.

**Architecture:** Add a production-safe chunk retrieval RPC over `article_chunks`, embed user questions with the same BGE model used by chunk backfill, and route `answer-question` to chunk retrieval by default. Keep `match_articles_prefer_analysis` only as an explicit rollback path and an optionally disabled emergency fallback, with traces clearly distinguishing chunk production from article-dense rollback.

**Tech Stack:** Supabase Edge Functions, Supabase PostgREST RPC, PostgreSQL + pgvector, Cloudflare Workers AI/OpenAI-compatible `@cf/baai/bge-m3` embeddings, Node `node:test`, existing `rag_retrieval_*` trace tables.

---

## Release Basis

Use this rollout basis in code comments, trace metadata, and deployment notes:

- Eval set: `qa-v1-2026-06`
- Corpus-health run: `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`
- Selected retrieval eval run: `8ba5bdac-88a7-4f7b-8058-1648c734cc33`
- Strategy: `chunk_dense @cf/baai/bge-m3`
- Valid metrics: Recall@5 `0.895`, Recall@10 `0.943`, MRR `0.739`, NDCG@10 `0.764`, Hit@5 `0.952`, p50/p95 as low as `1179/3425ms`
- Rollback retriever: `match_articles_prefer_analysis`

Production claim boundary:

- Safe claim: live `answer-question` now uses the selected chunk-level dense retriever by default.
- Unsafe claim: final answer accuracy is proven solely by retrieval metrics.
- Generation-eval note: aggregate generation scores are strong, but the 24-row aggregate should still be grouped by `eval_run_id` before being quoted as the locked 21-case benchmark.

## File Structure

- Create `supabase/sql/20260613_answer_question_chunk_retrieval.sql`: production RPC `public.match_answer_question_chunks`, service-role only, separate from eval-named `match_article_chunks_eval`.
- Modify `supabase/functions/answer-question/index.ts`: add BGE query embedding, chunk retrieval helper, explicit retriever selector, fallback behavior, and trace metadata.
- Create `tests/answer-question-production-chunk-dense.test.mjs`: static guardrails for SQL permissions, default retriever behavior, BGE input type, trace metadata, and rollback isolation.
- Modify `docs/instructions.md`: add deployment, smoke, monitor, and rollback commands.
- Modify `docs/current-state.md` and `docs/superpowers/rag-retrieval-refinement-progress.md`: change production status from article dense to chunk dense after implementation.
- Modify `docs/api-keys-and-env.md`: document that `answer-question` now requires Cloudflare/BGE embedding secrets for the default path.

## Production Behavior

Default production mode:

```text
ANSWER_QUESTION_RETRIEVER_MODE unset or "chunk_dense_bge_m3" -> use chunk retrieval
```

Rollback mode:

```text
ANSWER_QUESTION_RETRIEVER_MODE="article_dense_prefer_analysis" -> use match_articles_prefer_analysis
```

Emergency fallback:

```text
ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK unset or "true" -> fall back to article dense if chunk retrieval throws
ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK="false" -> fail retrieval closed and answer from main article only
```

This satisfies the production requirement because the normal live path is chunk dense. Article-level dense retrieval is no longer the selected production path; it exists only for rollback/failure containment.

## Task 1: Add Production Chunk Retrieval RPC

**Files:**
- Create: `tests/answer-question-production-chunk-dense.test.mjs`
- Create: `supabase/sql/20260613_answer_question_chunk_retrieval.sql`

- [ ] **Step 1: Write the failing SQL contract test**

Create `tests/answer-question-production-chunk-dense.test.mjs`:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('answer-question chunk RPC is production-safe and service-role only', () => {
  const sql = readFileSync('supabase/sql/20260613_answer_question_chunk_retrieval.sql', 'utf8')

  assert.match(sql, /create or replace function public\.match_answer_question_chunks/)
  assert.match(sql, /query_embedding vector\(1024\)/)
  assert.match(sql, /embedding_model_filter text default '@cf\/baai\/bge-m3'/)
  assert.match(sql, /chunking_version_filter text default 'paragraph-window-v1-2026-06-02'/)
  assert.match(sql, /from public\.article_chunks c/)
  assert.match(sql, /partition by cm\.article_id/)
  assert.match(sql, /'answer_question_chunk_dense_bge_m3'::text as embedding_source/)
  assert.match(sql, /revoke all on function public\.match_answer_question_chunks\(vector\(1024\), integer, text, integer, text\) from public/)
  assert.match(sql, /grant execute on function public\.match_answer_question_chunks\(vector\(1024\), integer, text, integer, text\) to service_role/)
  assert.doesNotMatch(sql, /grant execute on function public\.match_answer_question_chunks[\s\S]*to authenticated/i)
  assert.doesNotMatch(sql, /grant execute on function public\.match_answer_question_chunks[\s\S]*to anon/i)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
```

Expected: fails with `ENOENT` for `supabase/sql/20260613_answer_question_chunk_retrieval.sql`.

- [ ] **Step 3: Create the production RPC**

Create `supabase/sql/20260613_answer_question_chunk_retrieval.sql`:

```sql
-- 20260613 - Production chunk retrieval RPC for answer-question.
--
-- Default production retriever target:
-- chunk_dense @cf/baai/bge-m3, selected from valid eval run
-- 8ba5bdac-88a7-4f7b-8058-1648c734cc33 after corpus-health run
-- 54dcd974-2fa2-4fb7-bb62-6eae9f3880c0.

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
      'language', d.language,
      'selected_eval_run_id', '8ba5bdac-88a7-4f7b-8058-1648c734cc33',
      'corpus_health_run_id', '54dcd974-2fa2-4fb7-bb62-6eae9f3880c0'
    ) as metadata
  from deduped d
  join public.daily_news n on n.id = d.article_id
  order by d.article_rank asc
  limit greatest(match_count, 1);
$$;

revoke all on function public.match_answer_question_chunks(vector(1024), integer, text, integer, text) from public;
grant execute on function public.match_answer_question_chunks(vector(1024), integer, text, integer, text) to service_role;
```

- [ ] **Step 4: Run the focused test and full suite**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
npm test
```

Expected: both pass.

- [ ] **Step 5: Commit the RPC**

Run:

```bash
git add supabase/sql/20260613_answer_question_chunk_retrieval.sql tests/answer-question-production-chunk-dense.test.mjs
git commit -m "feat: add production chunk retrieval rpc"
```

## Task 2: Make `answer-question` Default To Chunk Dense

**Files:**
- Modify: `tests/answer-question-production-chunk-dense.test.mjs`
- Modify: `supabase/functions/answer-question/index.ts`

- [ ] **Step 1: Add failing source tests for default chunk behavior**

Append to `tests/answer-question-production-chunk-dense.test.mjs`:

```js
test('answer-question defaults to chunk_dense_bge_m3 and uses BGE search_query embeddings', () => {
  const source = readFileSync('supabase/functions/answer-question/index.ts', 'utf8')

  assert.match(source, /type RetrieverMode = 'chunk_dense_bge_m3' \| 'article_dense_prefer_analysis'/)
  assert.match(source, /ANSWER_QUESTION_RETRIEVER_MODE/)
  assert.match(source, /ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK/)
  assert.match(source, /return 'chunk_dense_bge_m3'/)
  assert.match(source, /embedQueryWithBgeM3/)
  assert.match(source, /input_type:\s*'search_query'/)
  assert.match(source, /match_answer_question_chunks/)
  assert.match(source, /match_articles_prefer_analysis/)
  assert.match(source, /chunk_dense_failed_fell_back_to_article_dense/)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
```

Expected: fails because `answer-question` has no chunk retriever implementation.

- [ ] **Step 3: Add retriever types and env helpers**

In `supabase/functions/answer-question/index.ts`, after `type RelatedArticleCandidate`, replace the type with this expanded version and add the helper types:

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

type RetrieverMode = 'chunk_dense_bge_m3' | 'article_dense_prefer_analysis'

type RetrieverSelection = {
  mode: RetrieverMode
  reason: string
  allowArticleDenseFallback: boolean
}

function envBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function selectRetrieverMode(): RetrieverSelection {
  const rawMode = (Deno.env.get('ANSWER_QUESTION_RETRIEVER_MODE') || '').trim()
  const allowArticleDenseFallback = envBool(Deno.env.get('ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK'), true)

  if (rawMode === 'article_dense_prefer_analysis') {
    return { mode: 'article_dense_prefer_analysis', reason: 'explicit_rollback_env', allowArticleDenseFallback }
  }

  return { mode: 'chunk_dense_bge_m3', reason: rawMode === 'chunk_dense_bge_m3' ? 'explicit_chunk_env' : 'default_chunk_dense_gold_set', allowArticleDenseFallback }
}
```

- [ ] **Step 4: Add BGE query embedding helpers**

Add near `sha256Hex`:

```ts
const BGE_EMBEDDING_MODEL = '@cf/baai/bge-m3'

function env(name: string, fallback = ''): string {
  return Deno.env.get(name) ?? fallback
}

function bgeEmbeddingsUrl(): string {
  const baseUrl = env('BGE_EMBEDDING_BASE_URL')
  if (baseUrl) return `${baseUrl.replace(/\/$/, '')}/v1/embeddings`

  const accountId = env('CLOUDFLARE_ACCOUNT_ID')
  if (!accountId) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID')
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`
}

function bgeApiToken(): string {
  const token = env('BGE_EMBEDDING_API_KEY') || env('CLOUDFLARE_API_TOKEN')
  if (!token) throw new Error('Missing CLOUDFLARE_API_TOKEN')
  return token
}

async function embedQueryWithBgeM3(question: string): Promise<number[]> {
  const res = await fetch(bgeEmbeddingsUrl(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bgeApiToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: BGE_EMBEDDING_MODEL,
      input_type: 'search_query',
      input: [question],
    }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Cloudflare BGE query ${res.status}: ${errBody.substring(0, 300)}`)
  }
  const data = await res.json() as { data?: Array<{ embedding?: number[] }>; embeddings?: number[][] }
  const embedding = Array.isArray(data.data)
    ? data.data[0]?.embedding
    : data.embeddings?.[0]
  if (!Array.isArray(embedding) || embedding.length !== 1024) {
    throw new Error(`Cloudflare BGE returned invalid query embedding length=${embedding?.length ?? 'null'}`)
  }
  return embedding
}
```

- [ ] **Step 5: Extract article-dense rollback helper**

Move the existing Cohere + `match_articles_prefer_analysis` logic from `retrieve` into:

```ts
async function retrieveArticleDenseCandidates(params: {
  question: string
  sbHeaders: Record<string, string>
  env: { supabaseUrl: string; cohereApiKey: string }
  maxRelated: number
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

- [ ] **Step 6: Add chunk-dense production helper**

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
      embedding_model_filter: BGE_EMBEDDING_MODEL,
    }),
  })
  if (!rpcRes.ok) throw new Error(`match_answer_question_chunks_failed:${rpcRes.status}`)

  const rows = await rpcRes.json()
  return rows.map((row: any) => ({
    id: row.article_id,
    title: row.title || '',
    summary: row.chunk_text || row.summary || row.summary_zh || row.summary_en || '',
    score: row.score_dense ?? null,
    embedding_source: row.embedding_source || 'answer_question_chunk_dense_bge_m3',
    candidateType: 'chunk',
    chunkId: row.chunk_id,
    chunkText: row.chunk_text,
    metadata: row.metadata || {},
  }))
}
```

- [ ] **Step 7: Thread retriever selection through `retrieve`**

Change the `retrieve` signature to accept:

```ts
  retrieverSelection: RetrieverSelection,
```

Replace the current RAG `try` block inside `retrieve` with:

```ts
  let fallbackReason: string | null = null
  try {
    if (retrieverSelection.mode === 'article_dense_prefer_analysis') {
      relatedCandidates = await retrieveArticleDenseCandidates({
        question,
        sbHeaders,
        env: { supabaseUrl: env.supabaseUrl, cohereApiKey: env.cohereApiKey },
        maxRelated: caps.maxRelated,
      })
    } else {
      try {
        relatedCandidates = await retrieveChunkDenseCandidates({
          question,
          sbHeaders,
          env: { supabaseUrl: env.supabaseUrl },
          maxRelated: caps.maxRelated,
        })
      } catch (chunkError) {
        if (!retrieverSelection.allowArticleDenseFallback) throw chunkError
        fallbackReason = 'chunk_dense_failed_fell_back_to_article_dense'
        console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'answer-question', request_id: requestId, event: 'chunk_dense_fallback', error: (chunkError as Error).message }))
        relatedCandidates = await retrieveArticleDenseCandidates({
          question,
          sbHeaders,
          env: { supabaseUrl: env.supabaseUrl, cohereApiKey: env.cohereApiKey },
          maxRelated: caps.maxRelated,
        })
      }
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
    console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'answer-question', request_id: requestId, event: 'rag_retrieval_failed', retriever_mode: retrieverSelection.mode, error: (e as Error).message }))
  }
```

- [ ] **Step 8: Update retrieval context and call site**

Update `RetrievalContext`:

```ts
type RetrievalContext = {
  mainContext: string
  relatedContext: string
  injectedRelatedIds: string[]
  retrievalRunId: string | null
  ragSuccess: boolean
  retrieverMode: RetrieverMode
  retrieverSelectionReason: string
  fallbackReason: string | null
}
```

In `orchestrateAnswer`, before calling `retrieve`, add:

```ts
  const retrieverSelection = selectRetrieverMode()
  log('retrieving', { article_id, retriever_mode: retrieverSelection.mode, retriever_selection_reason: retrieverSelection.reason })
```

Pass `retrieverSelection` into `retrieve`.

Return these fields from `retrieve`:

```ts
  return {
    mainContext,
    relatedContext,
    injectedRelatedIds,
    retrievalRunId,
    ragSuccess,
    retrieverMode: retrieverSelection.mode,
    retrieverSelectionReason: retrieverSelection.reason,
    fallbackReason,
  }
```

- [ ] **Step 9: Run focused and full tests**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
npm test
```

Expected: tests pass.

- [ ] **Step 10: Commit default chunk retriever**

Run:

```bash
git add supabase/functions/answer-question/index.ts tests/answer-question-production-chunk-dense.test.mjs
git commit -m "feat: default answer-question to chunk dense retrieval"
```

## Task 3: Trace Chunk Production Separately From Rollback

**Files:**
- Modify: `tests/answer-question-production-chunk-dense.test.mjs`
- Modify: `supabase/functions/answer-question/index.ts`

- [ ] **Step 1: Add failing trace metadata test**

Append:

```js
test('answer-question traces chunk production with selected gold-set metadata', () => {
  const source = readFileSync('supabase/functions/answer-question/index.ts', 'utf8')

  assert.match(source, /retrieval_strategy: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? 'chunk_dense_bge_m3'/)
  assert.match(source, /query_embedding_model: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? BGE_EMBEDDING_MODEL/)
  assert.match(source, /retrieval_version: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? 'answer-question-chunk-dense-bge-m3-v1-2026-06-13'/)
  assert.match(source, /retriever_name: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? 'match_answer_question_chunks'/)
  assert.match(source, /selected_eval_run_id: '8ba5bdac-88a7-4f7b-8058-1648c734cc33'/)
  assert.match(source, /corpus_health_run_id: '54dcd974-2fa2-4fb7-bb62-6eae9f3880c0'/)
  assert.match(source, /candidate_type: candidate\.candidateType \|\| 'article'/)
  assert.match(source, /chunk_id: candidate\.chunkId \|\| null/)
})
```

- [ ] **Step 2: Run focused test and verify it fails**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
```

Expected: fails because trace metadata has not been updated.

- [ ] **Step 3: Expand trace params**

Update `recordAnswerQuestionTrace` params:

```ts
  requestedRetrieverMode: RetrieverMode
  actualRetrieverMode: RetrieverMode
  retrieverSelectionReason: string
  fallbackReason: string | null
```

- [ ] **Step 4: Update `rag_retrieval_runs` insert fields**

Inside the insert payload in `recordAnswerQuestionTrace`, replace the fixed article-dense fields with:

```ts
        query_input: {
          article_id: params.articleId,
          lang: params.lang,
          requested_retriever_mode: params.requestedRetrieverMode,
          actual_retriever_mode: params.actualRetrieverMode,
          retriever_selection_reason: params.retrieverSelectionReason,
          fallback_reason: params.fallbackReason,
          selected_eval_run_id: '8ba5bdac-88a7-4f7b-8058-1648c734cc33',
          corpus_health_run_id: '54dcd974-2fa2-4fb7-bb62-6eae9f3880c0',
          eval_set: 'qa-v1-2026-06',
        },
        query_embedding_model: params.actualRetrieverMode === 'chunk_dense_bge_m3' ? BGE_EMBEDDING_MODEL : 'embed-english-v3.0',
        embedding_input_type: 'search_query',
        retrieval_strategy: params.actualRetrieverMode === 'chunk_dense_bge_m3' ? 'chunk_dense_bge_m3' : 'dense_article_similarity_prefer_deep_analysis',
        retrieval_version: params.actualRetrieverMode === 'chunk_dense_bge_m3' ? 'answer-question-chunk-dense-bge-m3-v1-2026-06-13' : 'answer-question-related-v1-2026-05-31',
        retriever_name: params.actualRetrieverMode === 'chunk_dense_bge_m3' ? 'match_answer_question_chunks' : 'match_articles_prefer_analysis',
```

- [ ] **Step 5: Update candidate rows**

In the candidate row builder, replace the candidate metadata fields with:

```ts
          candidate_type: candidate.candidateType || 'article',
          article_id: candidate.id,
          chunk_id: candidate.chunkId || null,
          title: candidate.title,
          summary_excerpt: (candidate.chunkText || candidate.summary || '').slice(0, 1000),
          score_dense: typeof candidate.score === 'number' ? candidate.score : null,
          score_final: typeof candidate.score === 'number' ? candidate.score : null,
          embedding_source: candidate.embedding_source ?? null,
          injected,
          drop_reason: injected ? null : candidate.id === params.articleId ? 'primary_article_excluded' : 'rank_beyond_context_cap',
          metadata: {
            ...(candidate.metadata || {}),
            lang: params.lang,
            requested_retriever_mode: params.requestedRetrieverMode,
            actual_retriever_mode: params.actualRetrieverMode,
            retriever_selection_reason: params.retrieverSelectionReason,
            fallback_reason: params.fallbackReason,
            selected_eval_run_id: '8ba5bdac-88a7-4f7b-8058-1648c734cc33',
            corpus_health_run_id: '54dcd974-2fa2-4fb7-bb62-6eae9f3880c0',
          },
```

- [ ] **Step 6: Pass trace metadata from `retrieve`**

Before calling `recordAnswerQuestionTrace`, compute:

```ts
  const actualRetrieverMode: RetrieverMode = fallbackReason ? 'article_dense_prefer_analysis' : retrieverSelection.mode
```

Pass:

```ts
    requestedRetrieverMode: retrieverSelection.mode,
    actualRetrieverMode,
    retrieverSelectionReason: retrieverSelection.reason,
    fallbackReason,
```

- [ ] **Step 7: Run tests**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
npm test
```

Expected: tests pass.

- [ ] **Step 8: Commit trace update**

Run:

```bash
git add supabase/functions/answer-question/index.ts tests/answer-question-production-chunk-dense.test.mjs
git commit -m "feat: trace answer-question chunk retrieval"
```

## Task 4: Add Production Rollout Diagnostics

**Files:**
- Create: `supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql`
- Modify: `tests/answer-question-production-chunk-dense.test.mjs`

- [ ] **Step 1: Add failing monitoring SQL test**

Append:

```js
test('chunk dense monitoring reports production gates and rollback state', () => {
  const sql = readFileSync('supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql', 'utf8')

  assert.match(sql, /chunk_dense_bge_m3/)
  assert.match(sql, /dense_article_similarity_prefer_deep_analysis/)
  assert.match(sql, /fallback_rate/)
  assert.match(sql, /empty_candidate_rate/)
  assert.match(sql, /p95_latency_ms/)
  assert.match(sql, /production_gate_status/)
  assert.match(sql, /canary_gate_pass/)
})
```

- [ ] **Step 2: Run focused test and verify it fails**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
```

Expected: fails because monitoring SQL does not exist.

- [ ] **Step 3: Create monitoring SQL**

Create `supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql`:

```sql
-- 20260613 - answer-question chunk dense production monitoring.

with recent_runs as (
  select
    rr.id,
    rr.created_at,
    rr.request_id,
    rr.retrieval_strategy,
    rr.retriever_name,
    rr.latency_ms,
    rr.candidate_count,
    rr.injected_count,
    rr.query_input,
    q.id as qa_log_id,
    q.error_message,
    q.feedback
  from public.rag_retrieval_runs rr
  left join public.qa_logs q on q.rag_retrieval_run_id = rr.id
  where rr.surface = 'answer_question_related_articles'
    and rr.created_at >= now() - interval '24 hours'
),
by_strategy as (
  select
    retrieval_strategy,
    retriever_name,
    count(*) as requests,
    percentile_cont(0.5) within group (order by latency_ms) as p50_latency_ms,
    percentile_cont(0.95) within group (order by latency_ms) as p95_latency_ms,
    avg(case when injected_count = 0 then 1 else 0 end) as empty_candidate_rate,
    avg(case when error_message is not null then 1 else 0 end) as qa_error_rate,
    avg(case when feedback < 0 then 1 else 0 end) filter (where feedback is not null) as negative_feedback_rate,
    avg(case when query_input->>'fallback_reason' = 'chunk_dense_failed_fell_back_to_article_dense' then 1 else 0 end) as fallback_rate
  from recent_runs
  group by retrieval_strategy, retriever_name
)
select
  retrieval_strategy,
  retriever_name,
  requests,
  round(p50_latency_ms::numeric, 0) as p50_latency_ms,
  round(p95_latency_ms::numeric, 0) as p95_latency_ms,
  round(empty_candidate_rate::numeric, 4) as empty_candidate_rate,
  round(qa_error_rate::numeric, 4) as qa_error_rate,
  round(coalesce(negative_feedback_rate, 0)::numeric, 4) as negative_feedback_rate,
  round(fallback_rate::numeric, 4) as fallback_rate,
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
      then 'canary_gate_watch'
    when retrieval_strategy = 'dense_article_similarity_prefer_deep_analysis'
      then 'rollback_or_fallback_path'
    else 'unknown_strategy'
  end as production_gate_status
from by_strategy
order by retrieval_strategy, retriever_name;
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test tests/answer-question-production-chunk-dense.test.mjs
npm test
```

Expected: tests pass.

- [ ] **Step 5: Commit monitoring SQL**

Run:

```bash
git add supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql tests/answer-question-production-chunk-dense.test.mjs
git commit -m "feat: add answer-question chunk monitoring"
```

## Task 5: Update Docs And Deployment Runbook

**Files:**
- Modify: `docs/instructions.md`
- Modify: `docs/current-state.md`
- Modify: `docs/superpowers/rag-retrieval-refinement-progress.md`
- Modify: `docs/api-keys-and-env.md`

- [ ] **Step 1: Update command docs**

Add this section to `docs/instructions.md` near the `answer-question` deployment notes:

````md
### answer-question Chunk Dense Production Retriever

Current production target:

```bash
ANSWER_QUESTION_RETRIEVER_MODE=chunk_dense_bge_m3
ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK=true
```

Apply SQL:

```sql
\i supabase/sql/20260613_answer_question_chunk_retrieval.sql
\i supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql
```

Set BGE secrets:

```bash
supabase secrets set CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" --project-ref "$SUPABASE_PROJECT_REF"
supabase secrets set CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" --project-ref "$SUPABASE_PROJECT_REF"
```

Optional OpenAI-compatible BGE override:

```bash
supabase secrets set BGE_EMBEDDING_BASE_URL="$BGE_EMBEDDING_BASE_URL" --project-ref "$SUPABASE_PROJECT_REF"
supabase secrets set BGE_EMBEDDING_API_KEY="$BGE_EMBEDDING_API_KEY" --project-ref "$SUPABASE_PROJECT_REF"
```

Deploy chunk default:

```bash
supabase secrets set ANSWER_QUESTION_RETRIEVER_MODE=chunk_dense_bge_m3 --project-ref "$SUPABASE_PROJECT_REF"
supabase secrets set ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK=true --project-ref "$SUPABASE_PROJECT_REF"
supabase functions deploy answer-question
```

Monitor:

```sql
\i supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql
```

Rollback:

```bash
supabase secrets set ANSWER_QUESTION_RETRIEVER_MODE=article_dense_prefer_analysis --project-ref "$SUPABASE_PROJECT_REF"
supabase functions deploy answer-question
```
````

- [ ] **Step 2: Update current state**

In `docs/current-state.md`, replace wording that says production `answer-question` still uses article-level dense retrieval with:

```md
Production `answer-question` now defaults to `chunk_dense @cf/baai/bge-m3`, selected from the corpus-health-valid 21-case gold-set replay. Article-level dense retrieval through `match_articles_prefer_analysis` remains available only as an explicit rollback path and emergency fallback.
```

- [ ] **Step 3: Update progress handoff**

In `docs/superpowers/rag-retrieval-refinement-progress.md`, change the `Current Rule` section to:

```md
Production `answer-question` now uses chunk-level dense retrieval by default through `match_answer_question_chunks` with `@cf/baai/bge-m3` query embeddings and `paragraph-window-v1-2026-06-02` chunks. The prior article-level dense path, `match_articles_prefer_analysis`, is retained as an explicit rollback baseline and optional emergency fallback, not as the normal live retriever.
```

- [ ] **Step 4: Update env docs**

In `docs/api-keys-and-env.md`, update the Cloudflare rows so `answer-question` is listed beside `generate-deep-analysis` for:

```md
`CLOUDFLARE_ACCOUNT_ID`
`CLOUDFLARE_API_TOKEN`
`BGE_EMBEDDING_BASE_URL`
`BGE_EMBEDDING_API_KEY`
```

Add:

```md
`ANSWER_QUESTION_RETRIEVER_MODE`: `chunk_dense_bge_m3` for current production, `article_dense_prefer_analysis` for rollback.
`ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK`: defaults to `true`; set to `false` only when you want chunk retrieval failures to skip related retrieval instead of using the rollback retriever.
```

- [ ] **Step 5: Verify docs**

Run:

```bash
rg -n "answer-question.*still uses|Current production `answer-question` still uses|production `answer-question` remained unchanged" docs supabase/sql/results.md
npm test
```

Expected:

- Any matches are historical notes with explicit dates, not current-state wording.
- Tests pass.

- [ ] **Step 6: Commit docs**

Run:

```bash
git add docs/instructions.md docs/current-state.md docs/superpowers/rag-retrieval-refinement-progress.md docs/api-keys-and-env.md
git commit -m "docs: document answer-question chunk production"
```

## Task 6: Apply, Deploy, Smoke, And Monitor

**Files:**
- Modify after deployment: `supabase/sql/results.md`

- [ ] **Step 1: Apply SQL in Supabase**

Run in Supabase SQL Editor:

```sql
\i supabase/sql/20260613_answer_question_chunk_retrieval.sql
```

Expected:

- `public.match_answer_question_chunks` exists.
- `service_role` can execute it.
- `anon` and `authenticated` cannot execute it directly.

- [ ] **Step 2: Set production secrets**

Run:

```bash
supabase secrets set ANSWER_QUESTION_RETRIEVER_MODE=chunk_dense_bge_m3 --project-ref "$SUPABASE_PROJECT_REF"
supabase secrets set ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK=true --project-ref "$SUPABASE_PROJECT_REF"
supabase secrets set CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" --project-ref "$SUPABASE_PROJECT_REF"
supabase secrets set CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" --project-ref "$SUPABASE_PROJECT_REF"
```

Expected:

- `answer-question` has BGE credentials.
- Retriever mode is explicitly chunk dense.

- [ ] **Step 3: Deploy Edge Function**

Run:

```bash
supabase functions deploy answer-question
```

Expected: deploy succeeds.

- [ ] **Step 4: Smoke one known question**

Use the frontend or API to ask one authenticated Q&A question. Then run:

```sql
select
  rr.created_at,
  rr.retrieval_strategy,
  rr.retriever_name,
  rr.query_embedding_model,
  rr.query_input,
  rr.candidate_count,
  rr.injected_count,
  rr.latency_ms
from public.rag_retrieval_runs rr
where rr.surface = 'answer_question_related_articles'
order by rr.created_at desc
limit 5;
```

Expected:

- New row has `retrieval_strategy = 'chunk_dense_bge_m3'`.
- New row has `retriever_name = 'match_answer_question_chunks'`.
- New row has `query_embedding_model = '@cf/baai/bge-m3'`.
- `query_input->>'selected_eval_run_id' = '8ba5bdac-88a7-4f7b-8058-1648c734cc33'`.
- No new row uses `dense_article_similarity_prefer_deep_analysis` unless fallback occurred.

- [ ] **Step 5: Run production monitoring**

Run:

```sql
\i supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql
```

Expected after enough traffic:

- `chunk_dense_bge_m3` appears.
- `p50_latency_ms <= 2500`.
- `p95_latency_ms <= 8000`.
- `fallback_rate <= 0.05`.
- `qa_error_rate <= 0.02`.
- `empty_candidate_rate <= 0.02`.

- [ ] **Step 6: Record deployment result**

Append to `supabase/sql/results.md`:

```md
## 2026-06-13 answer-question Chunk Dense Production Switch

- production retriever: `chunk_dense_bge_m3`
- rollback retriever: `match_articles_prefer_analysis`
- selected eval run: `8ba5bdac-88a7-4f7b-8058-1648c734cc33`
- corpus-health run: `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`
- smoke retrieval strategy:
- smoke retriever name:
- smoke latency:
- fallback observed:
- decision:
```

- [ ] **Step 7: Commit deployment ledger**

Run:

```bash
git add supabase/sql/results.md
git commit -m "docs: record answer-question chunk production switch"
```

## Task 7: Rollback Procedure

**Files:**
- Modify after rollback if used: `supabase/sql/results.md`

- [ ] **Step 1: Trigger rollback**

Run:

```bash
supabase secrets set ANSWER_QUESTION_RETRIEVER_MODE=article_dense_prefer_analysis --project-ref "$SUPABASE_PROJECT_REF"
supabase functions deploy answer-question
```

Expected: new `answer-question` traces use `dense_article_similarity_prefer_deep_analysis`.

- [ ] **Step 2: Verify rollback trace**

Run:

```sql
select
  created_at,
  retrieval_strategy,
  retriever_name,
  query_input->>'retriever_selection_reason' as retriever_selection_reason
from public.rag_retrieval_runs
where surface = 'answer_question_related_articles'
order by created_at desc
limit 5;
```

Expected:

- `retrieval_strategy = 'dense_article_similarity_prefer_deep_analysis'`
- `retriever_name = 'match_articles_prefer_analysis'`
- `retriever_selection_reason = 'explicit_rollback_env'`

- [ ] **Step 3: Record rollback reason**

Append to `supabase/sql/results.md`:

```md
## 2026-06-13 answer-question Chunk Dense Rollback

- rollback time:
- rollback reason:
- failing gate:
- last chunk p50/p95:
- last fallback rate:
- last QA error rate:
- next fix:
```

## Self-Review

- Spec coverage: the plan covers SQL RPC creation, BGE query embedding, default chunk selection, rollback isolation, trace metadata, monitoring, docs, deploy, and rollback.
- Placeholder scan: no unresolved markers, no unspecified test steps, no vague "add tests" instruction.
- Type consistency: `RetrieverMode`, `RetrieverSelection`, `RelatedArticleCandidate`, and trace field names are introduced before use.
- Risk check: the only article-level dense use left in normal code is explicit rollback or emergency fallback; production traces expose either case.
