# Semantic Chunking + Parent-Child Retrieval (Spec D) — Design Plan

## Context

Dimensions 1 and 2 of the project audit found:
- **Dim 1 (Ingestion):** No chunking. `embed-batch` embeds the whole article (truncated at 24K chars) as a single 1024-dim vector. Articles >2K chars lose internal granularity; the back half of any article >24K chars never reaches the index.
- **Dim 2 (RAG):** No hierarchical retrieval. The current `match_articles` RPC returns whole-article matches; injected related context is the article's `summary` (2-3 sentences), not the matching passage — the "context fidelity" problem flagged in the senior architect's review.

Spec D fixes both: chunked embeddings → chunk-level retrieval → inject the *matching chunk* (not the summary) as related context.

**Sequencing:** depends on Spec C (qa_logs) for baseline metrics. Without ≥1 week of qa_logs production data, there is no defensible answer to "did chunking improve RAG?" Spec D ships *after* Spec C accumulates baseline data.

**Scope contract:** going-forward chunking only. No backfill of legacy `daily_news.embedding`. The retrieval RPC handles both schemas during the coexistence period.

## Diagnose (5-Dimension Lens)

| Dim | Status |
|---|---|
| 1. Ingestion | This spec is the fix. Chunker = recursive paragraph→sentence splitter targeting 1500 chars with 200 char overlap. |
| 2. Advanced RAG | Hierarchical retrieval lands here (small chunks for matching, parent article for context). Reranker (Spec E) becomes a single-call addition over the chunk pool. |
| 3. Metrics | Spec C's qa_logs baseline is the comparison anchor. Verification §B requires measurable Recall@K / 👎-rate improvement on long-form articles before Spec D ships. |
| 4. Flywheel | Triage SQL gains a chunked-vs-legacy comparison axis. |
| 5. Safety | Chunks are still external content; injection surface is unchanged. The Spec-A cap is *revised* (see §6) to fit a chunk; the principle (mandatory cap on external content) is preserved. |

## Decisions (locked + recommended)

| Item | Decision | Source |
|---|---|---|
| Backfill of legacy embeddings | **None this spec** — chunk going-forward; legacy articles keep `daily_news.embedding` | User locked in original AskUserQuestion |
| Chunk size target | **1500 chars** (~375 tokens; safe under Cohere's 512-token ceiling) | Recommended |
| Chunk overlap | **200 chars** | Recommended |
| Hard chunk ceiling | **2000 chars** (per architect critique — 1700 risked truncating mid-word when overlap was prepended) | Architect-locked |
| Chunking method | **Recursive: paragraph → sentence → fixed**, never mid-word unless pathological | Recommended |
| Schema shape | **New `article_chunks` table** + `daily_news.is_chunked` flag (per architect critique — see §1, Fix 1) | Architect-locked |
| Retrieval channel | **Unified `match_articles` RPC searches both** chunks AND legacy `daily_news.embedding`, deduplicates by `article_id` | Recommended |
| RPC SQL shape | **Two-CTE structure** isolating ANN sort from window function (per architect critique — see §4, Fix 3) | Architect-locked |
| Cohere call shape | **Defensive sub-batching to ≤96 texts per call**, parallel via `Promise.all` (per architect critique — see §3, Fix 2) | Architect-locked |
| Related-context shape | **Inject the matching chunk text** for chunked articles; fall back to summary for legacy articles | Recommended |
| Spec A cap revision | **Bump related-context cap from 800 → 1500 chars**; main cap unchanged at 12K | Recommended |
| Going-forward whole-article embedding | **Drop it.** New articles only have `article_chunks` rows; `daily_news.embedding` stays NULL for new articles | Recommended |

## Architectural reality check

- **No new cron trigger.** Reuses `embed-batch`'s existing 5-minute schedule. ✅
- **Token economy:** chunking adds zero LLM tokens. The cap revision (§6) raises per-RAG-query budget by ~500 tokens. At Spec C's expected ~50 queries/day = +25K tokens/day, well under 100K TPD. ✅
- **Subrequest budget (CRITICAL — see §3 Fix 2):** the naive "one Cohere call per chunk" design blows the 50-subrequest CF limit. Defensive sub-batching to ≤96 texts/call with `Promise.all` keeps it at 1-3 Cohere subrequests per `embed-batch` run. ✅
- **Pipeline integrity (CRITICAL — see §1 Fix 1):** `NOT EXISTS chunks` as the claim predicate creates a permanent wedge if any article produces 0 chunks (empty content). Fix: track processing state via `daily_news.is_chunked` flag; mark TRUE on every claim regardless of chunk count. ✅
- **HNSW index usage (CRITICAL — see §4 Fix 3):** mixing `ROW_NUMBER() OVER` with `ORDER BY <=> LIMIT` in the same query block confuses the Postgres planner into Seq Scan. Fix: isolate the ANN sort in its own CTE; apply the window function on the small materialized result. ✅
- **Queue path:** chunks derive from `daily_news.article_content` which already came through `raw_ingestion`. No new queue surface.
- **Failure mode:** if the chunker fails for an article, log + skip + leave it un-flagged (`is_chunked = false`), retry next run. The chunker is pure (no I/O), so failures here are programmer errors, not transient — the SWE must add a hard error log so they surface.

## Recommended approach

### 1. Schema — `article_chunks` table + `daily_news.is_chunked` flag

**Files:**
- `supabase/sql/20260427_article_chunks.sql` (new)
- (same file) `daily_news.is_chunked` ALTER

**Fix 1 rationale (Pipeline Integrity — wedge):** the architect critique caught a permanent wedge mode in the naive design: claiming articles by `NOT EXISTS (SELECT 1 FROM article_chunks WHERE article_id = dn.id)` means that **any article whose `chunkArticle()` returns `[]` (whitespace, garbage, parser failure) is re-claimed forever**. Subsequent articles in the queue are never reached. Fix: track processing state explicitly on the parent table.

```sql
-- ── Parent-table processing flag (Fix 1) ──────────────────────────────────
-- The new chunked-pipeline marker. Ensures pathological articles (0-chunk results)
-- are processed once and never re-claimed. Legacy articles keep is_chunked = false
-- forever — they are served by the legacy branch of match_articles.
alter table public.daily_news add column is_chunked boolean not null default false;

-- Partial index: the embed-batch claim query targets only unprocessed new articles.
-- Most rows over time will be is_chunked = true, so partial keeps the index tiny.
create index daily_news_unchunked_idx on public.daily_news(created_at desc)
  where is_chunked = false and article_content is not null and embedding is null;

-- ── Chunks table ──────────────────────────────────────────────────────────
create table public.article_chunks (
  id          uuid primary key default gen_random_uuid(),
  article_id  uuid not null references public.daily_news(id) on delete cascade,
  chunk_idx   smallint not null,                     -- 0-based ordinal
  content     text not null,
  embedding   vector(1024) not null,                 -- Cohere embed-english-v3.0
  created_at  timestamptz not null default now(),
  unique (article_id, chunk_idx)
);

create index article_chunks_embedding_hnsw_idx on public.article_chunks
  using hnsw (embedding vector_cosine_ops);

create index article_chunks_article_id_idx on public.article_chunks(article_id);

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.article_chunks enable row level security;
create policy "public_read_chunks" on public.article_chunks
  for select to anon, authenticated using (true);
-- No insert/update policies → only service role (used by embed-batch) writes.
```

**Article state machine after Spec D ships:**

| State | `embedding` | `is_chunked` | `article_chunks` rows | Reachable via |
|---|---|---|---|---|
| Unprocessed-new | NULL | false | 0 | (claimed by next embed-batch run) |
| Processed-new (with chunks) | NULL | true | ≥1 | RPC `chunk_hits` branch |
| Processed-new (empty content) | NULL | true | 0 | Not retrievable (correct — there's nothing to retrieve) |
| Legacy | NOT NULL | false | 0 | RPC `legacy_hits` branch |

These four states are mutually exclusive by construction (claim query excludes states 2/3/4; chunker writes always pair with `is_chunked = true`).

### 2. Chunker module

**File:** `workers/embed-batch/src/chunker.ts` (new, ~80 lines)

Recursive paragraph→sentence→fixed splitter. Target 1500 chars per chunk, 200 char overlap, hard ceiling 2000 chars (architect-locked — 1700 was caught as risking mid-word truncation when overlap is prepended to a chunk that already ended on a clean boundary near 1500).

```ts
export type Chunk = { idx: number; content: string }

const TARGET_CHARS = 1500
const OVERLAP_CHARS = 200
const HARD_MAX = 2000   // safety margin; well under Cohere's ~2000-char (512-token) input limit

export function chunkArticle(text: string): Chunk[] {
  const cleaned = text.trim()
  if (cleaned.length === 0) return []
  if (cleaned.length <= TARGET_CHARS) return [{ idx: 0, content: cleaned }]

  // Step 1: split on paragraph boundaries
  const paragraphs = cleaned.split(/\n\s*\n/).filter(p => p.trim().length > 0)

  // Step 2: greedy pack paragraphs up to TARGET_CHARS; recurse to sentence-split
  // for paragraphs that themselves exceed TARGET_CHARS.
  const buckets: string[] = []
  let cur = ''
  for (const p of paragraphs) {
    if (p.length > TARGET_CHARS) {
      if (cur) { buckets.push(cur); cur = '' }
      buckets.push(...splitBySentence(p))
      continue
    }
    if ((cur + '\n\n' + p).length > TARGET_CHARS) {
      buckets.push(cur)
      cur = p
    } else {
      cur = cur ? cur + '\n\n' + p : p
    }
  }
  if (cur) buckets.push(cur)

  // Step 3: prepend overlap from previous chunk's tail. HARD_MAX = 2000 leaves
  // headroom for OVERLAP_CHARS (200) + a full TARGET-sized chunk (1500), so the
  // safety slice never severs a sentence that ended on a clean boundary.
  return buckets.map((b, i) => {
    if (i === 0) return { idx: 0, content: b.slice(0, HARD_MAX) }
    const tail = buckets[i - 1].slice(-OVERLAP_CHARS)
    return { idx: i, content: (tail + ' ' + b).slice(0, HARD_MAX) }
  })
}

function splitBySentence(text: string): string[] {
  // Bilingual sentence-boundary regex: EN .!? + ZH 。？！
  const sentences = text.match(/[^.!?。？！]+[.!?。？！]+["')\]]?\s*/g) ?? [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (s.length > TARGET_CHARS) {
      if (cur) { out.push(cur); cur = '' }
      for (let i = 0; i < s.length; i += TARGET_CHARS) {
        out.push(s.slice(i, i + TARGET_CHARS))
      }
      continue
    }
    if ((cur + s).length > TARGET_CHARS) {
      out.push(cur)
      cur = s
    } else {
      cur += s
    }
  }
  if (cur) out.push(cur)
  return out
}
```

**Test cases the SWE must add** (`workers/embed-batch/src/chunker.test.ts`):
- Empty / whitespace input → `[]`
- Single paragraph ≤ 1500 chars → 1 chunk
- 4 paragraphs of 600 chars each → 2 chunks (greedy pack), with overlap
- Single paragraph of 5000 chars → multi-chunk via sentence-split
- Single sentence of 4000 chars (no punctuation) → hard-split fallback, no infinite loop
- Mixed EN/中 paragraph → splits cleanly on `。` and `.`
- Article with one paragraph of exactly TARGET_CHARS → 1 chunk, content unchanged
- **Wedge canary:** input that evaluates to "non-empty trim but zero useful content" (e.g., `"   \n\n   \n"`) → `[]`. Worker must still mark `is_chunked = true` for this article (see §3).

### 3. `embed-batch` Worker — claim, chunk, defensively-batched embed, dual-write

**File:** [workers/embed-batch/src/index.ts](../../../workers/embed-batch/src/index.ts) (modified)

Today's flow: SELECT `WHERE embedding IS NULL` → 1 Cohere call per article → UPDATE `daily_news.embedding`.

Tomorrow's flow:

```ts
// 1. Claim: state-1 articles only (Fix 1 — uses is_chunked flag, not NOT EXISTS chunks)
const articles = await sb
  .from('daily_news')
  .select('id, article_content')
  .eq('is_chunked', false)
  .is('embedding', null)
  .not('article_content', 'is', null)
  .order('created_at', { ascending: false })
  .limit(5)

if (!articles.data?.length) return  // nothing to do

// 2. Chunk each (pure, no I/O)
const flat: { article_id: string; chunk_idx: number; content: string }[] = []
for (const a of articles.data) {
  const chunks = chunkArticle(a.article_content)
  for (const c of chunks) {
    flat.push({ article_id: a.id, chunk_idx: c.idx, content: c.content })
  }
  // Articles producing 0 chunks (state-3 candidates) contribute nothing to flat
  // but are STILL flagged is_chunked=true in step 5 below — this is the wedge fix.
}

// 3. Defensive sub-batching for Cohere (Fix 2) — never exceed 96 texts per call.
//    Cohere's hard limit is 96; a 5-article batch with long podcasts can blow this.
//    Promise.all + 1-3 calls = 1-3 subrequests, comfortably under CF's 50.
const COHERE_BATCH_SIZE = 96
const batches: typeof flat[] = []
for (let i = 0; i < flat.length; i += COHERE_BATCH_SIZE) {
  batches.push(flat.slice(i, i + COHERE_BATCH_SIZE))
}

const cohereResponses = await Promise.all(
  batches.map(batch =>
    fetch('https://api.cohere.com/v1/embed', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${COHERE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'embed-english-v3.0',
        input_type: 'search_document',     // Architectural Principle 5 — index-time embedding
        texts: batch.map(c => c.content),
      }),
    }).then(r => r.json() as Promise<{ embeddings: number[][] }>)
  )
)

const allEmbeddings = cohereResponses.flatMap(r => r.embeddings)
// Sanity check: per-call return order is preserved by Cohere; allEmbeddings.length === flat.length
if (allEmbeddings.length !== flat.length) {
  console.error('[embed-batch] Cohere returned mismatched embeddings count', allEmbeddings.length, 'vs', flat.length)
  return  // do NOT mark is_chunked — leave for retry
}

// 4. Bulk insert into article_chunks (only if any chunks produced)
if (flat.length > 0) {
  const rows = flat.map((c, i) => ({ ...c, embedding: allEmbeddings[i] }))
  const { error } = await sb.from('article_chunks').insert(rows)
  if (error) {
    console.error('[embed-batch] article_chunks insert failed:', error.message)
    return  // do NOT mark is_chunked — let retry happen on next cron tick
  }
}

// 5. Mark all claimed articles is_chunked = true (Fix 1 — including 0-chunk articles).
//    Order matters: this happens AFTER the chunks insert succeeds, so a partial
//    failure (chunks inserted but flag not set) is recoverable on next run by
//    UNIQUE (article_id, chunk_idx) preventing duplicates.
const claimedIds = articles.data.map(a => a.id)
await sb
  .from('daily_news')
  .update({ is_chunked: true })
  .in('id', claimedIds)
```

**Subrequest count per run:**
- 1 SELECT (claim) + 1-3 Cohere calls (defensive batching) + 1 INSERT (chunks) + 1 UPDATE (is_chunked) = **4-6 subrequests**
- Hard ceiling: 5 articles × 13 chunks each = 65 chunks → ⌈65/96⌉ = 1 Cohere call. Under any realistic scenario, ≤2 Cohere calls.
- Comfortable headroom under CF's 50.

**Idempotency on partial failure:**
- If chunks insert succeeds but the `is_chunked` UPDATE fails (network blip): next cron run re-claims the same articles. Re-chunking + re-embedding produces identical chunks. The INSERT fails with `unique violation (article_id, chunk_idx)` — wrap in try/catch and treat as success, then re-attempt the UPDATE. This is *acceptable* operationally; document but do not engineer around.
- The user's earlier feedback rule (`feedback_no_git_commit`) doesn't apply here, but the Architectural Principle 2 rule (idempotency at every seam) does — UNIQUE (article_id, chunk_idx) IS the seam guarantee.

### 4. `match_articles` RPC — unified two-channel retrieval (HNSW-safe)

**File:** `supabase/sql/20260427_match_articles_v2.sql` (new). Drops + recreates the function (return signature changes — adds `chunk_content`).

**Fix 3 rationale (HNSW index bypass):** the naive design mixes `ROW_NUMBER() OVER (... ORDER BY embedding <=> query)` with the outer `ORDER BY embedding <=> query LIMIT N` in the same query block. Postgres' planner sees the window function and frequently abandons the HNSW index in favor of a full Seq Scan to satisfy partition ordering. As `article_chunks` grows, RAG latency spikes silently. **Fix:** isolate the ANN sort in its own CTE so the planner *must* use HNSW; apply the window function over the small materialized result.

```sql
drop function if exists public.match_articles(vector, int);

create or replace function public.match_articles(
  query_embedding vector(1024),
  match_count     int default 5
)
returns table (
  id              uuid,
  title           text,
  summary         text,
  chunk_content   text,           -- NEW: matched chunk text (NULL for legacy whole-article hits)
  published_at    timestamptz,
  score           float
)
language sql stable as $$

  -- ── Chunk channel ────────────────────────────────────────────────────────
  -- Two-CTE split (Fix 3): ANN sort in raw_chunk_hits *only*. The HNSW index
  -- is guaranteed to be used because the query block contains nothing but
  -- ORDER BY <=> + LIMIT. The window function operates on the materialized
  -- (≤ match_count*4) row set.
  with raw_chunk_hits as (
    select
      ac.article_id,
      ac.content,
      ac.embedding <=> query_embedding as dist
    from public.article_chunks ac
    order by ac.embedding <=> query_embedding   -- raw <=> for HNSW (Architectural rule)
    limit match_count * 4
  ),
  best_chunk_per_article as (
    select article_id, content as chunk_content, 1 - dist as score
    from (
      select
        article_id,
        content,
        dist,
        row_number() over (partition by article_id order by dist) as rn
      from raw_chunk_hits
    ) ranked
    where rn = 1
  ),

  -- ── Legacy channel ───────────────────────────────────────────────────────
  -- Same isolation pattern, even though there's no window function — keeps
  -- the structure parallel and future-proof if we ever add per-article dedupe
  -- to the legacy side.
  raw_legacy_hits as (
    select
      dn.id as article_id,
      dn.embedding <=> query_embedding as dist
    from public.daily_news dn
    where dn.embedding is not null
      and dn.is_chunked = false              -- defense-in-depth; should be tautological
    order by dn.embedding <=> query_embedding
    limit match_count * 4
  ),
  legacy_hits as (
    select article_id, null::text as chunk_content, 1 - dist as score
    from raw_legacy_hits
  ),

  -- ── Union, dedupe across channels (a chunked article should not also appear via legacy) ─
  combined as (
    select * from best_chunk_per_article
    union all
    select * from legacy_hits
    where article_id not in (select article_id from best_chunk_per_article)
  )

  select
    dn.id,
    dn.title,
    dn.summary,
    c.chunk_content,
    dn.published_at,
    c.score
  from combined c
  join public.daily_news dn on dn.id = c.article_id
  order by c.score desc
  limit match_count;
$$;
```

**Verification of HNSW use** (mandatory before ship; see §A test 9):
```sql
explain analyze
select * from match_articles(<some-vector>, 5);
-- The plan for raw_chunk_hits CTE must show:
--   "Index Scan using article_chunks_embedding_hnsw_idx"
-- NOT "Seq Scan on article_chunks". If Seq Scan appears, Fix 3 is not actually shipped.
```

**Backwards compatibility:**
- `generate-trend-brief` also calls `match_articles` ([generate-trend-brief/index.ts](../../../supabase/functions/generate-trend-brief/index.ts)). The return signature *adds* `chunk_content`; existing callers selecting by name (`r.title, r.summary, r.score`) ignore it.
- **SWE pre-deploy action:** grep for every `match_articles` call site. Verify each consumes the result by name (`r.title`, etc.), not by positional destructuring. If any site uses positional access, fix before deploy.

### 5. `answer-question` retrieval — inject chunks (the context-fidelity fix)

**File:** [supabase/functions/answer-question/index.ts](../../../supabase/functions/answer-question/index.ts)

Today, related context uses `r.summary` only. After Spec D's RPC change returns `chunk_content`, update the related-context build:

```ts
// REPLACE the existing relatedContext build (post Spec A cap) with:
if (filtered.length > 0) {
  const label = lang === 'zh' ? '相关文章' : 'Related article'
  relatedContext = '\n\n' + filtered.map((r, i) => {
    // Prefer the matched chunk (true context); fall back to summary for legacy articles.
    const body = r.chunk_content || r.summary || ''
    const trimmed = body.slice(0, RELATED_CONTEXT_CAP)   // see §6 cap revision
    return `[${label} ${i + 1}] ${r.title}\n${trimmed}`
  }).join('\n\n')
}
```

Filter is unchanged: `MAX_RELATED = 3`, exclude current `article_id`.

### 6. Spec A cap revision — bump related cap from 800 → 1500 chars

**File:** [docs/architect-role.md](../../architect-role.md), Principle 4.

**Revised Principle 4 wording:**

> Context truncation is also mandatory. In `process-queue`, `article_content` is capped at 24,000 chars. In `answer-question`, the system-role budget is tiered:
> - Main article: 12,000 chars.
> - Each related context (chunk for new articles, summary for legacy): 1,500 chars.
> - Max related: 3.
>
> Total system-role budget ≤ 16,500 chars (~4,100 tokens).
> Any new LLM call that ingests external content must have an explicit char cap and a defended total.

**Code change in `answer-question`:**
```ts
const RELATED_CONTEXT_CAP = 1500   // was 800 in Spec A; bumped to fit a chunk
```

**Token-budget impact:**
- Spec A budget: 14,400 chars ≈ 3,600 tokens
- Spec D budget: 16,500 chars ≈ 4,100 tokens
- Delta: +500 tokens per RAG query
- At ~50 queries/day = +25K tokens/day — comfortably under 100K TPD cap; flag the new baseline to operator triage.

### 7. Backfill design (deferred build)

Not built in this spec, but designed forward-compatibly:

- **One-time backfill script:** iterate `daily_news WHERE embedding IS NOT NULL AND is_chunked = false`, chunk each article, re-embed via Cohere defensive-batched, insert into `article_chunks`, then `UPDATE daily_news SET embedding = NULL, is_chunked = true`.
- **Cost estimate:** ~150 legacy articles × ~3 chunks each = 450 Cohere texts, fits in 5 calls (96/call). Cohere production trial = 5M tokens/month; 450 × ~400 tokens = 180K tokens. Trivial.
- **Trigger:** when legacy articles dominate qa_logs negative feedback OR when `daily_news.embedding` storage becomes a concern (not soon at this scale).
- **Schema readiness:** after backfill, `daily_news.embedding` becomes droppable. A later spec performs the column drop after a soak window confirms no consumers remain.

## Verification

### A. Behavioral (manual, blocking before ship)

| # | Scenario | Expected |
|---|---|---|
| 1 | New article (>3K chars) ingested → `embed-batch` runs | ≥2 rows in `article_chunks` for that article; `daily_news.is_chunked = true`; `daily_news.embedding` is NULL |
| 2 | New article (<1500 chars) ingested → `embed-batch` runs | Exactly 1 row in `article_chunks` with `chunk_idx = 0`, content == full `article_content`; `is_chunked = true`; `embedding` NULL |
| 3 | Legacy article (already has `daily_news.embedding`) | Unchanged. No new rows in `article_chunks`. `is_chunked` stays `false`. RPC finds it via the `legacy_hits` branch |
| 4 | Question against an article whose related candidates include both chunked and legacy articles | RPC returns mix; `chunk_content` non-null for chunked, null for legacy; `answer-question` logs confirm fallback to summary fires for legacy |
| 5 | **Wedge canary 1 (Fix 1):** ingest an article with `article_content = '   \n\n   '` (whitespace only) → `embed-batch` runs | `chunkArticle` returns `[]`; ZERO rows in `article_chunks`; `daily_news.is_chunked = true`. **Verify on the next cron tick that this article is NOT re-claimed** (the wedge fix). |
| 6 | **Wedge canary 2 (Fix 2):** synthetically create 5 articles with very long content forcing total chunks > 96 across the batch | Cohere is called ≥2 times via `Promise.all`; subrequest count ≤6; no 400 from Cohere; all chunks land in `article_chunks` |
| 7 | `match_articles` returns at most `match_count` distinct articles when chunk-hits cluster | Query for which 4 of top-5 chunk hits belong to same article → RPC returns 4 distinct articles (over-fetch + dedupe working) |
| 8 | `generate-trend-brief` still works after RPC change | Trigger a brief regen; sources arrive as before; no schema-mismatch errors |
| 9 | **HNSW canary (Fix 3):** `EXPLAIN ANALYZE select * from match_articles(<vec>, 5);` | Plan for `raw_chunk_hits` CTE shows **`Index Scan using article_chunks_embedding_hnsw_idx`** — NOT `Seq Scan`. If Seq Scan appears, Fix 3 is not shipped and latency will degrade as the table grows. Re-deploy and re-test. |
| 10 | Subrequest budget under load | Run `embed-batch` against a backlog of 5 long articles producing 30+ chunks. CF Worker logs show subrequest count ≤6. |

### B. Quality eval (blocking — uses Spec C qa_logs as the baseline)

This spec depends on **at least 1 week of Spec C qa_logs production data** as the baseline.

**Pre-deploy baseline (computed before Spec D ships):**
```sql
-- Long-article 👎 rate (the cohort Spec D should help most)
select
  count(*) filter (where feedback = -1) * 100.0 / nullif(count(*), 0) as down_pct,
  count(*) as n
from qa_logs
where context_main_chars >= 12000
  and asked_at >= now() - interval '7 days'
  and feedback is not null;
-- Capture: down_pct_baseline, n_baseline
```

**Post-deploy comparison (1 week after Spec D live):**
```sql
select
  count(*) filter (where feedback = -1) * 100.0 / nullif(count(*), 0) as down_pct,
  count(*) as n
from qa_logs q
where q.context_main_chars >= 12000
  and q.article_id in (select article_id from article_chunks)
  and q.asked_at >= '<spec-d-deploy-date>' + interval '1 day'
  and q.feedback is not null;
```

**Acceptance criteria:**
- `n_after ≥ 30` (statistical floor)
- `down_pct_after < down_pct_baseline` (any improvement counts; significant drop is the win)
- If no improvement: investigate before keeping. Likely root causes: chunk size wrong, cap revision too aggressive, RPC dedupe behaving badly.

**Spec A's 21-pair eval set re-run** as regression check — Spec D must not degrade short-article quality. Acceptance: zero new "much worse" verdicts.

### C. Cost / budget post-deploy check (one-time, 7 days after ship)

```sql
-- New chunk volume
select count(*) as chunks, count(distinct article_id) as articles,
       avg(chunks_per_article) as avg_chunks_per_article
from (select article_id, count(*) as chunks_per_article from article_chunks group by article_id) sub;
-- Expected: avg ≈ 2-4 for the news mix; hard ceiling ~13 for podcasts.

-- Cohere call rate from CF Worker logs: should be 1-3 calls per embed-batch run
-- (defensive batching). Verify in Cloudflare dashboard.

-- Groq TPD impact from §6 cap revision
select
  avg(prompt_tokens) filter (where asked_at < '<spec-d-deploy-date>') as before_avg,
  avg(prompt_tokens) filter (where asked_at >= '<spec-d-deploy-date>') as after_avg
from qa_logs
where asked_at >= '<spec-d-deploy-date>' - interval '7 days'
  and prompt_tokens is not null;
-- Expected ratio: 1.10-1.30. Much higher = cap revision over-firing.
```

## Out of scope

- Backfill of legacy `daily_news.embedding` (§7, deferred).
- Hybrid retrieval (BM25 + vector + RRF) — needs a `tsvector` index first.
- Reranker (Spec E) — slots in over the chunk pool returned by the RPC; no schema change required.
- Query rewriting / expansion / routing in `answer-question` — orthogonal Dim 2 win.
- Multimodal parsing (PDF tables, equations, OCR) — Dim 1 frontier.
- Dropping `daily_news.embedding` — happens after backfill + soak.

## Critical files

| File | Status |
|---|---|
| `supabase/sql/20260427_article_chunks.sql` | New — `daily_news.is_chunked` ALTER + `article_chunks` table + HNSW index + RLS |
| `supabase/sql/20260427_match_articles_v2.sql` | New — drops + recreates `match_articles` with two-CTE structure (Fix 3) |
| `workers/embed-batch/src/chunker.ts` | New — recursive paragraph→sentence splitter (HARD_MAX = 2000) |
| `workers/embed-batch/src/chunker.test.ts` | New — Vitest cases enumerated in §2 |
| [workers/embed-batch/src/index.ts](../../../workers/embed-batch/src/index.ts) | Modified — claim by `is_chunked = false`, defensive Cohere sub-batching with `Promise.all` (Fix 2), bulk insert chunks, mark `is_chunked = true` for ALL claimed articles regardless of chunk count (Fix 1) |
| [supabase/functions/answer-question/index.ts](../../../supabase/functions/answer-question/index.ts) | Modified — related-context uses `chunk_content || summary`; `RELATED_CONTEXT_CAP` raised to 1500 |
| [supabase/functions/generate-trend-brief/index.ts](../../../supabase/functions/generate-trend-brief/index.ts) | **Audit required** — verify it consumes `match_articles` columns by name, not position |
| [docs/architect-role.md](../../architect-role.md) | Modified — Principle 4 revised per §6 |
| [docs/keep-in-mind.md](../../keep-in-mind.md) | Append: chunker invariants; the "verify match_articles callers consume by name" check; the cost / quality SQL queries from §B/§C; the EXPLAIN ANALYZE HNSW canary (§A test 9) |

## Sequencing

- **Hard depends on Spec C** (qa_logs) for baseline metrics. Spec D ships *after* Spec C accumulates ≥1 week of production data.
- **Independent of Spec A and Spec B** in mechanism, but Spec D *amends* Spec A's Principle-4 cap (raises related from 800 → 1500). Encoded in §6.
- **Unblocks Spec E** (reranker) — Spec E becomes a single Cohere `rerank-v3.0` call between the unified RPC and the related-context build. No schema change.
- **Unblocks future hybrid retrieval** — adding BM25 means a `tsvector` index on `article_chunks.content` and a third channel + RRF fusion. Designed-for, not built.
