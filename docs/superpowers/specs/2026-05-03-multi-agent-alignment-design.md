# Multi-Agent Architecture Alignment Design

**Date:** 2026-05-03  
**Author:** Architect role  
**Status:** Approved for implementation  
**Rubric reference:** `docs/architect-role.md` § "Architectural Evaluation Rubric: Multi-Agent Systems"

---

## Context

The project adopted a five-rule Architectural Evaluation Rubric for Multi-Agent Systems. This spec grades the current codebase against all five rules, names every violation found during a full codebase audit, and defines the remediation work ordered by severity and impact.

This is a systems-level change spec. Each phase is a separate SWE implementation session.

---

## Audit Findings — Current State vs Rubric

### Rule 1: Client-Server Boundary — 3 violations

| # | Violation | File | Severity |
|---|---|---|---|
| 1 | Twitter thread grouping (dedup + sort by engagement) runs entirely client-side after fetching individual tweet rows from Supabase | `news-app/App.tsx` | **High** — business logic on client |
| 2 | Pagination offset computed and tracked as client state (`FEED_PAGE_SIZE=10`, `currentOffset`); server receives a raw integer, not an opaque cursor | `news-app/App.tsx` | **Medium** — state that should be opaque is exposed |
| 3 | SSE stream `type`-field routing (`thinking` / `content` / `meta`) is parsed and branched in `ArticleCard.tsx` — client understands the protocol contract by name | `news-app/components/ArticleCard.tsx` | **Low** — inherent to SSE but contract is over-exposed |

**Compliant (not violations):** Category and date range filtering are query *parameters* passed to the server; no business rule duplication. Auth gate is fully server-enforced via RLS + `is_beta_user()`.

---

### Rule 2: Domain Boundaries & Orchestration — 2 violations

| # | Violation | File | Severity |
|---|---|---|---|
| 4 | `answer-question` is a God Function (~425 lines): auth extraction, response-cache check, Cohere RAG embedding, `match_articles` RPC, context capping, 3-tier LLM routing, SSE streaming, abort handling, and `qa_logs` persistence — all inline with no stage boundaries | `supabase/functions/answer-question/index.ts` | **High** |
| 5 | No top-level orchestrator exists for multi-domain flows. The RAG answer pipeline crosses Auth → Retrieval → Generation → Persistence without a named coordinator; control flow is implicit inline sequencing | System-wide | **Medium** |

**Compliant:** Domain data ownership is clean — each function writes only its own tables. No lateral cross-domain DB reads found.

---

### Rule 3: AI Workflow Patterns — 1 violation

| # | Violation | File | Severity |
|---|---|---|---|
| 6 | `generate-trend-brief` user-facing path fires a secondary-language LLM call asynchronously mid-primary-stream. This creates an implicit two-phase state machine (stream-fires-secondary → secondary-resolves-or-times-out → conditional DB write) that is not a clean Plan-and-Execute separation | `supabase/functions/generate-trend-brief/index.ts` | **Medium** |

**Compliant:** `process-queue` (single LLM call → structured JSON → batch DB inserts) and `answer-question` (single LLM call → stream) are already Plan-and-Execute.

---

### Rule 4: Tool Design (Stateless Execution) — 3 violations

| # | Violation | File(s) | Severity |
|---|---|---|---|
| 7 | AI relevance keyword gate (`EN_AI_KEYWORDS`, `ZH_AI_KEYWORDS`) is copy-pasted verbatim in three separate files. Manual sync required; no enforcement. A keyword added to one file silently does not apply to the other two. | `supabase/functions/process-queue/`, `workers/ingest-builders/`, `supabase/functions/ingest-apify-tweets/` | **High** |
| 8 | Silent category fallback in `process-queue`: if LLM omits or returns an invalid category, the function silently substitutes `source.category`. Tool hides a decision that the orchestrator should observe. | `supabase/functions/process-queue/index.ts` (`insertAndMarkDone`) | **Medium** |
| 9 | 3-tier LLM routing (`callLLM()` / `callLLMStream()`) is re-implemented independently in each of five functions. Any routing logic change (new tier, timeout adjustment) must be applied to five files. | `process-queue`, `ingest-builders`, `answer-question`, `generate-trend-brief`, `refresh-questions` | **Medium** |

**Compliant:** `redeem-invite` (atomic claim + idempotent recovery), `embed-batch` (pure Cohere call), `match_articles` RPC (pure SQL) are all stateless and strongly typed.

---

### Rule 5: Observability & Regression — 3 violations

| # | Violation | Scope | Severity |
|---|---|---|---|
| 10 | No correlation/request IDs. If `process-queue` fails processing article 3 of a 5-article batch, there is no ID to isolate that article's log lines from the others in the same invocation. | All functions | **High** |
| 11 | No pipeline tracing table. The journey of an article from `raw_ingestion.id` → `daily_news.id` → `qa_logs.id` is not traceable without ad hoc multi-table SQL joins; there is no append-only event log. | Database | **High** |
| 12 | No regression test harness. Production `qa_logs` failures cannot be automatically converted into isolated test cases. Debugging requires reproducing context manually, often by pasting code into an LLM. | System-wide | **High** |

---

## Remediation Plan

Phases are ordered: P0 (Observability) is a prerequisite — once correlation IDs exist, all later refactors are traceable and verifiable.

---

### Phase 0 — Observability Foundation (Rule 5)

**Why first:** Every subsequent phase produces code changes that are impossible to verify without structured logs and a tracing table. Build the floor before building the walls.

**Changes:**

#### 0a. `pipeline_events` table (new DB migration)

```sql
CREATE TABLE pipeline_events (
  id          BIGSERIAL PRIMARY KEY,
  run_id      UUID        NOT NULL,          -- stamped at batch claim time
  step        TEXT        NOT NULL,          -- 'claim' | 'fetch' | 'keyword_gate' | 'llm' | 'insert' | 'embed'
  status      TEXT        NOT NULL,          -- 'ok' | 'skip' | 'error'
  source_id   BIGINT,
  raw_id      UUID,
  daily_id    UUID,
  duration_ms INT,
  error_text  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON pipeline_events (run_id);
CREATE INDEX ON pipeline_events (raw_id);
CREATE INDEX ON pipeline_events (created_at);
```

No RLS. Service-role only. Storage projection: ~288 events/day at current throughput = ~105K rows/year — well within free-tier Postgres.

#### 0b. `run_id` column on `raw_ingestion` and `daily_news`

```sql
ALTER TABLE raw_ingestion ADD COLUMN run_id UUID;
ALTER TABLE daily_news    ADD COLUMN run_id UUID;
```

Stamped by `process-queue` at `claim_pending_batch()` time. Allows: "show me every article from the run that produced this bad output" → single-column filter.

#### 0c. `request_id` column on `qa_logs`

```sql
ALTER TABLE qa_logs ADD COLUMN request_id UUID;
```

Generated at `answer-question` Edge Function entry (`crypto.randomUUID()`). Every log line for that request emits this ID. Allows full trace of: route decision → retrieval results → LLM call → persistence outcome.

#### 0d. Standardized log format (all functions)

All `console.log()` calls emit a JSON object with at minimum:
```json
{ "ts": "<ISO>", "fn": "<function-name>", "run_id": "<uuid>", "event": "<name>", ...payload }
```

This makes Supabase Dashboard log search and any future external aggregator trivially filterable by `run_id`.

**Verification:** Trigger `process-queue` manually → query `pipeline_events` → verify one row per article per step → verify `run_id` appears in every log line for that invocation.

---

### Phase 1 — Tool Centralization (Rule 4, violation #7 and #8)

**Why next:** The keyword gate is the highest-risk silent failure in the system. Three files, manual sync, no test. Fix before any other refactor touches those files.

**Changes:**

#### 1a. Centralize keyword gate as a Supabase SQL function

```sql
CREATE OR REPLACE FUNCTION is_ai_relevant(content TEXT, source_type TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  en_keywords TEXT[] := ARRAY[...]; -- single canonical list
  zh_keywords TEXT[] := ARRAY[...];
BEGIN
  -- EN regex match OR ZH substring match based on source_type
  ...
END;
$$;
```

All three callers replace their local keyword gate with `supabase.rpc('is_ai_relevant', { content, source_type })`. The SQL function is the single source of truth. Callable from both Cloudflare Workers (via Supabase REST) and Edge Functions (via supabase-js).

**Trade-off:** One extra subrequest per article in `ingest-builders`. Current subrequest count is ~38–50/50. If this pushes over the limit, use Option B (shared TypeScript module under `supabase/functions/_shared/keywords.ts`; Workers copy only the file, not the logic). The spec author prefers Option A for true centralization.

#### 1b. Remove silent category fallback — make it observable

In `process-queue` `insertAndMarkDone()`, replace the silent fallback with:

```typescript
if (!VALID_CATEGORIES.includes(llmCategory)) {
  await writePipelineEvent(runId, rawId, 'llm_category_mismatch', 'skip', {
    llm_output: llmCategory,
    fallback_used: source.category
  });
  resolvedCategory = source.category; // still use fallback, but it's now visible
}
```

The fallback behavior is preserved (no data loss), but the mismatch is now a queryable event. This feeds the data flywheel: periodic review of `pipeline_events WHERE step = 'llm_category_mismatch'` surfaces LLM prompt drift.

**Verification:** Update a keyword in the SQL function → verify all three ingest pipelines reject/accept correctly without touching any TypeScript file.

---

### Phase 2 — Domain Decomposition of `answer-question` (Rule 2, violations #4 and #5)

**Changes:**

Decompose the God Function into three pure, named stages within the same file. No new Edge Functions required (respects free-tier constraint). The orchestrator lives in the same file as the handler.

#### Stage A: `route(req)` → `RouteDecision`

```typescript
type RouteDecision =
  | { action: 'serve_cache'; cachedRow: QaLog }
  | { action: 'generate'; userId: string; article: Article; context: string }
```

Responsibilities: JWT extraction → user_id; cache lookup; article fetch; return decision object. No LLM calls. No SSE writes.

#### Stage B: `retrieve(articleId, question, lang)` → `RetrievalContext`

```typescript
type RetrievalContext = {
  mainArticle: Article;
  relatedChunks: ArticleChunk[];
  ragSuccess: boolean;  // false if Cohere or match_articles failed
}
```

Responsibilities: Cohere embed (input_type: `search_query`); `match_articles` RPC; context truncation (12K main + 3×800 related). Non-blocking — failure sets `ragSuccess: false` and returns with main article only.

#### Stage C: `generate(context, decision, requestId, stream)` → `void`

Responsibilities: Build system + user prompt; call 3-tier LLM router; pipe deltas to SSE stream; handle abort signal; persist `qa_logs` row with `request_id` on completion or abort.

#### Orchestrator: `orchestrateAnswer(req)` → `Response`

```typescript
async function orchestrateAnswer(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const decision = await route(req);
  if (decision.action === 'serve_cache') return serveCached(decision.cachedRow, requestId);
  const context = await retrieve(decision.article.id, decision.context, decision.lang);
  return generate(context, decision, requestId, new TransformStream());
}
```

The handler becomes a one-liner: `serve(req) => orchestrateAnswer(req)`.

**Constraint:** All three stages remain in `supabase/functions/answer-question/index.ts`. No new functions, no new deployments.

**Verification:** Submit a Q&A request → verify `qa_logs.request_id` is set → verify log lines for route/retrieve/generate all share the same `request_id`.

---

### Phase 3 — `generate-trend-brief` Plan-and-Execute (Rule 3, violation #6)

**Changes:**

Replace the implicit async secondary-language fire with an explicit Plan-and-Execute structure.

#### Plan step: `buildBriefPlan(params)` → `BriefPlan`

```typescript
type BriefPlan = {
  articles: Article[];
  historicalContext: Article[];
  enMessages: LLMMessage[];
  zhMessages: LLMMessage[];
}
```

Fetches articles + historical context. Builds both language message arrays. Pure data preparation — no LLM calls.

#### Execute step: `executeBriefPlan(plan)` → `BriefResult`

```typescript
const [enResult, zhResult] = await Promise.all([
  callLLM(plan.enMessages),
  callLLM(plan.zhMessages)
]);
```

Both calls run in parallel via `Promise.all()`. Both must complete before the DB write. One atomic write regardless of which language completes first.

**TTFT trade-off:** The current architecture streams the primary language to the user while the secondary generates. The new approach buffers both before streaming. Expected latency increase: 15–25s (secondary generation time). This is acceptable for a trend brief (non-realtime), but must be validated in production. If unacceptable:

**Fallback option:** Keep primary streaming, but extract the secondary call into a named function `triggerSecondaryGeneration(plan, primaryResult)` with explicit timeout and its own `pipeline_event` record. The key requirement is that the secondary's state machine is *named and explicit*, not embedded in the stream pipe.

**Verification:** Trigger brief generation → verify `trend_briefs` row has both `synthesis_en` and `synthesis_zh` populated in a single atomic write → verify no orphaned secondary calls in logs.

---

### Phase 4 — Client Decoupling (Rule 1, violations #1 and #2)

**Changes:**

#### 4a. Server-side thread grouping via new RPC

```sql
CREATE OR REPLACE FUNCTION fetch_grouped_feed(
  p_date_start  DATE,
  p_date_end    DATE,
  p_category    TEXT DEFAULT NULL,
  p_lang        TEXT DEFAULT 'en',
  p_limit       INT  DEFAULT 10,
  p_cursor      UUID DEFAULT NULL   -- last seen daily_news.id for keyset pagination
)
RETURNS TABLE (
  id            UUID,
  title         TEXT,
  summary       TEXT,
  source_type   TEXT,
  thread_group  TEXT,   -- Twitter handle for tweet threads, NULL for others
  published_at  TIMESTAMPTZ,
  next_cursor   UUID    -- last id in this result set, NULL if no more pages
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    dn.id,
    CASE WHEN p_lang = 'zh' THEN dn.title_zh ELSE dn.title_en END AS title,
    CASE WHEN p_lang = 'zh' THEN dn.summary_zh ELSE dn.summary_en END AS summary,
    s.source_type,
    CASE WHEN s.source_type = 'tweet' THEN s.handle ELSE NULL END AS thread_group,
    dn.published_at,
    LAST_VALUE(dn.id) OVER (ORDER BY dn.published_at DESC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS next_cursor
  FROM daily_news dn
  JOIN sources s ON s.id = dn.source_id
  WHERE dn.published_at::date BETWEEN p_date_start AND p_date_end
    AND (p_category IS NULL OR s.category = p_category)
    AND (p_cursor IS NULL OR dn.id < p_cursor)
  ORDER BY dn.published_at DESC
  LIMIT p_limit;
$$;
```

The client receives `thread_group` as a field. It renders "thread container" when `thread_group` is non-null and multiple rows share the same value — zero grouping logic client-side.

#### 4b. Cursor-based pagination

The RPC returns `next_cursor` (last `id` in result set). Client passes `cursor: nextCursor` on next call. `currentOffset` state is removed from `App.tsx`. No offset arithmetic on the client.

#### 4c. SSE stream contract (no change)

The `type` field values (`thinking`, `content`, `meta`, `done`) are minimal and inherent to SSE. The client's interpretation of `type` is rendering dispatch, not business logic. No change required.

**Verification:** Load feed in browser → inspect network calls → confirm no JavaScript thread-grouping code executes → confirm `thread_group` field drives grouping → test pagination: page 2 cursor matches last ID of page 1.

---

## Priority Matrix

| Priority | Phase | Effort | Token Cost | Free-Tier Risk |
|---|---|---|---|---|
| **P0** | Phase 0 — Observability | Medium (DB migration + log changes in 4 files) | Zero | None — append-only table, <1MB/year |
| **P1** | Phase 1 — Keyword gate centralization | Low (SQL function + 3 call-site replacements) | Zero (SQL call, not LLM) | +1 subrequest in ingest-builders; watch 50-limit |
| **P2** | Phase 2 — `answer-question` decompose | Medium (refactor, same file, no new deployments) | Zero | None |
| **P3** | Phase 3 — Trend brief Plan-and-Execute | Low-Medium (restructure async flow) | Zero | Possible TTFT regression — validate before shipping |
| **P4** | Phase 5 — Client decoupling | Medium-High (new RPC + `App.tsx` + `ArticleCard.tsx` changes) | Zero | New RPC adds 1 Supabase call per page load — negligible |

---

## Hard Constraint Verification

| Constraint | Check |
|---|---|
| Cloudflare cron triggers ≤ 5 | No new workers added. 4/5 slots remain after this spec. ✅ |
| Groq TPD ≤ 100K/day | No new LLM calls. Phase 3 restructures existing calls. Net: zero. ✅ |
| Groq TPM ≤ 12K/min | No batch size changes. ✅ |
| CF subrequests ≤ 50/invocation | Phase 1 adds 1 RPC call to `ingest-builders` (currently ~38–50). **Monitor.** If over limit, use shared TS module instead of RPC. ⚠️ |
| Queue-first for new data sources | No new data sources introduced. ✅ |
| Idempotency at every seam | `pipeline_events` is append-only; no ON CONFLICT logic needed. `run_id` columns are write-once. ✅ |

---

## Five-Dimension Check (per architect-role.md)

**Dimension 1 — Data Ingestion:** No changes to ingestion path. Keyword gate centralization (Phase 1) reduces silent filtering inconsistencies. ✅

**Dimension 2 — RAG & Retrieval:** No retrieval changes in this spec. The `RetrievalContext` type in Phase 2 makes RAG success/failure explicit and observable for the first time. Minor improvement. ✅

**Dimension 3 — Production Metrics:** Phase 0 adds pipeline tracing. Phase 2 adds `request_id` to every Q&A interaction. These are the first observable metrics in the system. Significant improvement. ✅

**Dimension 4 — Data Flywheel:** `pipeline_events WHERE step = 'llm_category_mismatch'` is the first structured badcase signal. `request_id` on `qa_logs` enables future badcase clustering. Flywheel prerequisites being laid. ✅

**Dimension 5 — Safety Guardrails:** No new external content surfaces opened. Phase 4 RPC is read-only SQL with no user-controlled injection path. Role separation unchanged. ✅
