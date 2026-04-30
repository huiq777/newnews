# qa_logs Table + Feedback Capture (Spec C) — Design Plan

## Context

Dimension-4 audit: **the project has no badcase capture.** RAG queries and answers stream and disappear. Without persistence, every retrieval/prompt change is judged by vibes (Architect-role 5-Dimension Framework, Dimension 4).

Spec A's quality eval gives us a 21-pair seed corpus; that is a one-time artifact. Spec C builds the production data flywheel: every RAG query persists a structured row capturing question, retrieval context, response, timing, model, token cost, the Spec-A cap usage, and (later, async) the user's 👍/👎 signal.

This spec **depends on Spec B** (auth gate) — the `is_beta_user()` helper and `auth.uid()` are the access-control primitives every qa_logs RLS policy uses. It cannot land before Spec B.

There are no per-user token quotas. qa_logs captures token counts purely for observability (cost attribution, badcase correlation), not enforcement.

## Diagnose (5-Dimension Lens)

| Dim | Status |
|---|---|
| 1. Ingestion | N/A. |
| 2. Advanced RAG | qa_logs is the prerequisite for justifying any future change here — without baseline measurement, reranker / chunking / query-rewrite changes cannot be defended. |
| 3. Metrics | First persisted measurements in the project: TTFT, total latency, prompt/completion tokens, model used, error rate. The structured columns replace Spec A's `console.log` — same data, queryable. **Telemetry integrity is enforced at the Postgres layer** via column-level GRANTs (see §1) — clients cannot tamper with operational fields, only feedback. |
| 4. Flywheel | This *is* the flywheel. Operator triages via SQL until volume justifies a UI; clustering/labeling deferred to a future spec. |
| 5. Safety / PII | Question text contains PII. RLS locks reads/updates to `auth.uid() = user_id`; operator (service role) bypasses for triage. No anon access ever. Retention: indefinite for round 1, bounded by closed-beta scale. |

## Decisions (locked)

| Item | Decision |
|---|---|
| Write timing | **Hybrid.** Server (`answer-question` Edge Function) writes the row at stream close with retrieval + response + timing + token + context-cap data. Client receives the row `id` via a final SSE `meta` event and PATCHes `feedback` later. |
| Aborted streams | Edge Function aborts the upstream LLM `fetch` immediately (token-economy critical — see §2e), then writes a row with `aborted = true` and whatever partial `response_text` was streamed. Operator can distinguish "user left" from "answer completed but unrated." |
| Hard errors (LLM 502) | Edge Function writes a row with `error_message` populated and `response_text` null. These are first-class triage rows, not silent drops. |
| Feedback shape | **Binary** — `-1` (👎), `0` (explicit "no opinion" — reserved, unused for round 1), `+1` (👍). No reason picker until 👎 rate > 5%. |
| Implicit feedback | Out of scope for round 1. (Retry / abandonment can be derived from query patterns post-hoc.) |
| Retention | **None for round 1.** ~50 users × ~10 q/day × 365 = 182K rows/year ≈ 9 GB. Free Supabase = 500 MB. Revisit retention policy at 100K rows. |
| Operator triage UX | SQL queries against the table via Supabase dashboard. Admin UI deferred. |
| Telemetry tampering defense | **Column-level GRANTs** restrict client UPDATE permission to `(feedback, feedback_at)` only. RLS row-scoping plus GRANT column-scoping form the layered defense. (See §1.) |

## Architectural reality check

- **No new cron trigger.** Writes are request-driven; reads are operator-driven.
- **Token economy:** zero impact on the steady-state budget. **Critical risk addressed in §2e:** without explicit upstream abort on client cancel, a single closed-tab event could burn ~1K tokens of useless generation. The fix in §2e closes this leak.
- **Subrequest budget:** N/A — `answer-question` is an Edge Function, not a CF Worker.
- **Queue path:** qa_logs is operational data, not ingested content. Skips `raw_ingestion` per architectural Principle 1's `user_tokens` precedent.
- **Failure mode:** if the qa_log INSERT fails (e.g., Supabase unavailable mid-stream-close), the user's answer **must not break.** Wrap the write in try/catch; log to console; return the stream cleanly. The cost of a missed log row is one badcase blind-spot; the cost of a broken answer is a user-facing failure. The asymmetry is clear.

## Recommended approach

### 1. Schema — `qa_logs` table

**File:** `supabase/sql/20260426_qa_logs.sql` (new)

```sql
create table public.qa_logs (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,

  -- Request
  article_id               uuid references public.daily_news(id) on delete set null,
  question                 text not null,
  lang                     text not null check (lang in ('en','zh')),
  asked_at                 timestamptz not null default now(),

  -- Retrieval — the truth-set actually injected into the prompt (post Spec-A cap, post filter)
  related_article_ids      uuid[] not null default '{}',
  context_main_chars       int,
  context_related_chars    int,
  context_total_chars      int,

  -- Response
  response_text            text,            -- streamed answer; null if aborted before any byte
  model_used               text,            -- 'qwen/qwen3.6-plus' | 'llama-3.3-70b-versatile' | etc.
  prompt_tokens            int,
  completion_tokens        int,
  total_tokens             int,

  -- Timing (server-measured)
  ttft_ms                  int,             -- request start → first SSE byte
  total_ms                 int,             -- request start → stream close
  aborted                  boolean not null default false,

  -- Failure
  error_message            text,            -- LLM-tier failure; non-null implies response_text is null

  -- Feedback (patched by client after the answer renders)
  feedback                 smallint check (feedback in (-1, 0, 1)),
  feedback_at              timestamptz,

  created_at               timestamptz not null default now()
);

-- Indexes
create index qa_logs_user_id_idx     on public.qa_logs(user_id);
create index qa_logs_asked_at_idx    on public.qa_logs(asked_at desc);
create index qa_logs_feedback_idx    on public.qa_logs(feedback) where feedback is not null;
create index qa_logs_article_id_idx  on public.qa_logs(article_id) where article_id is not null;

-- ── RLS (row-level) ─────────────────────────────────────────────────────────
alter table public.qa_logs enable row level security;

create policy "users_read_own_logs" on public.qa_logs
  for select to authenticated
  using (is_beta_user() and user_id = auth.uid());

-- The Edge Function uses service role and bypasses RLS for INSERT, but this
-- policy governs any future direct-from-client insert path.
create policy "users_insert_own_logs" on public.qa_logs
  for insert to authenticated
  with check (is_beta_user() and user_id = auth.uid());

-- Row-level scope: each user can update only their own row.
-- Column-level scope is enforced separately via GRANT below — this is critical.
create policy "users_update_own_feedback" on public.qa_logs
  for update to authenticated
  using (is_beta_user() and user_id = auth.uid())
  with check (is_beta_user() and user_id = auth.uid());

-- ── Column-level GRANTs (telemetry integrity) ───────────────────────────────
-- CRITICAL: Postgres RLS controls which ROWS a role can act on, but NOT which
-- COLUMNS. The default GRANT ALL on `authenticated` would let a malicious or
-- buggy client PATCH their own row and overwrite operational telemetry
-- (response_text, ttft_ms, aborted, model_used, total_tokens, etc.). That
-- corrupts every downstream metric we rely on.
--
-- Fix: revoke the default UPDATE grant, then re-grant UPDATE only on the two
-- feedback columns. Service role retains full UPDATE via RLS bypass. The
-- `anon` role gets nothing.
revoke update on public.qa_logs from authenticated;
grant  update (feedback, feedback_at) on public.qa_logs to authenticated;
revoke all    on public.qa_logs from anon;
```

**Schema notes:**
- `user_id` cascades on `auth.users` delete → user removal automatically scrubs their history.
- `article_id` set-nulls on article delete → preserves the qa_log for triage even if the source article is removed.
- `related_article_ids` stores **what was actually injected into the prompt** (after Spec A's `MAX_RELATED = 3` filter and `RELATED_CONTEXT_CAP = 800`-char trim). This is the truth-set, not the candidate pool from `match_articles`.
- `context_*_chars` columns mirror Spec A's tiered cap so badcase triage can correlate "user said this answer was bad" with "the cap chopped 60% of the article." This replaces Spec A's transient `console.log`.
- The column-GRANT block is the **only** defense against client-side telemetry overwrite. RLS alone is not sufficient. Verification §B tests #6 and #7 prove the layered defense is working.

### 2. `answer-question` Edge Function — add row insert at stream close

**File:** [supabase/functions/answer-question/index.ts](../../../supabase/functions/answer-question/index.ts)

Six changes — three additions (JWT extract, timing/response capture, persist), one structural change (AbortController plumbing — token-economy critical), one new SSE event, one removal (Spec A's `console.log`).

#### 2a. Capture the JWT-bound user

Mirror the Spec B `redeem-invite` pattern: instantiate a per-request client with the caller's `Authorization` header, call `auth.getUser()` to get the verified user. Note: `answer-question` deploys with `verify_jwt = true` already; this just extracts the verified UID — no manual JWT verification.

```ts
const authHeader = req.headers.get('Authorization') ?? ''
const sbAsUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: authHeader } },
})
const { data: { user } } = await sbAsUser.auth.getUser()
const userId = user?.id ?? null

if (authHeader && !userId) {
  // The request carried an Authorization header but it didn't resolve to a user.
  // In the auth-gated app this should never happen — surface as a warn, not silent.
  console.warn('[answer-question] Authorization header present but user resolution failed')
}
// userId === null is allowed (preserves dev-curl and future public-endpoint paths).
// persistQaLog will skip the insert when userId is null — see §2c.
```

#### 2b. Hoist the AbortController (token-economy critical)

Today the function uses **per-tier** AbortControllers for timeout (`new AbortController()` inside each Tier 1 / Tier 2 try-block). The fix: hoist a **single outer** `downstreamAbort` controller. Every LLM `fetch` passes its `signal`. The `ReadableStream.cancel()` handler aborts it on client disconnect.

```ts
// Outer scope, before any LLM call
const downstreamAbort = new AbortController()

// In each LLM tier (TokenRouter, OpenRouter, Groq), the existing fetch gains:
const r = await fetch('https://api.tokenrouter.com/v1/chat/completions', {
  method: 'POST',
  signal: downstreamAbort.signal,        // NEW — cancel propagation
  headers: { /* existing */ },
  body: JSON.stringify({ ...llmBody, model: LLM_MODEL }),
})
```

The existing per-tier *timeout* setTimeout (`controller.abort()` at 8s) can either:
- (preferred) be merged into the outer controller — call `downstreamAbort.abort()` on timeout, accept that all subsequent tiers will then also see the aborted signal (acceptable: timeout means upstream is unresponsive anyway, fall back to next tier with a fresh outer controller); OR
- (simpler) keep per-tier timeout controllers AND attach the outer signal via `AbortSignal.any([downstreamAbort.signal, perTierTimeoutController.signal])` (Deno supports `AbortSignal.any` since 1.39).

**Recommendation: the simpler `AbortSignal.any` path** — preserves the existing 8s timeout semantics and adds the cancel signal without restructuring tier fallback logic. SWE picks the implementation that fits the existing code shape.

#### 2c. Capture timing, retrieval, response, tokens

Add measurement points around the existing flow:

```ts
const t0 = Date.now()
let ttftMs: number | null = null
let totalMs: number | null = null
let chosenModel: string | null = null
let responseAccumulator = ''
let tokens: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null

// after retrieval, capture what was actually injected (post Spec-A cap + filter)
const injectedRelatedIds = filtered.map(r => r.id)
const contextMainChars = mainContext.length
const contextRelatedChars = relatedContext.length
const contextTotalChars = contextMainChars + contextRelatedChars

// inside the stream pull loop:
//   - on first delta with content: ttftMs = Date.now() - t0
//   - on each delta with content: responseAccumulator += delta.content
//   - on the final usage payload (Groq sends `usage` in the last chunk before [DONE]):
//       tokens = parsed.usage
//   - on stream close (done): totalMs = Date.now() - t0
//   - chosenModel is set in each tier branch ('qwen/qwen3.6-plus', OPENROUTER_MODEL, 'llama-3.3-70b-versatile')
```

#### 2d. Persist function

After `controller.close()` (or in the abort/error paths), write the qa_log row using the **service-role client** (bypasses RLS). Wrap in try/catch — a failed insert MUST NOT break the user's stream.

```ts
async function persistQaLog(opts: {
  aborted: boolean
  errorMessage: string | null
}): Promise<string | null> {
  if (!userId) return null  // anonymous demo path; nothing to attribute

  try {
    const sbService = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data, error } = await sbService.from('qa_logs').insert({
      user_id: userId,
      article_id,
      question,
      lang,
      related_article_ids: injectedRelatedIds,
      context_main_chars: contextMainChars,
      context_related_chars: contextRelatedChars,
      context_total_chars: contextTotalChars,
      response_text: responseAccumulator || null,
      model_used: chosenModel,
      prompt_tokens: tokens?.prompt_tokens ?? null,
      completion_tokens: tokens?.completion_tokens ?? null,
      total_tokens: tokens?.total_tokens ?? null,
      ttft_ms: ttftMs,
      total_ms: opts.aborted ? Date.now() - t0 : totalMs,
      aborted: opts.aborted,
      error_message: opts.errorMessage,
    }).select('id').single()

    if (error) {
      console.error('[answer-question] qa_logs insert failed:', error.message)
      return null
    }
    return data?.id ?? null
  } catch (e) {
    console.error('[answer-question] qa_logs insert threw:', (e as Error).message)
    return null
  }
}
```

#### 2e. Wire up the ReadableStream — abort upstream FIRST, then persist

```ts
const stream = new ReadableStream({
  async pull(controller) {
    // existing pull loop, augmented per §2c (capture ttftMs, accumulator, tokens)
    // on done:
    totalMs = Date.now() - t0
    const qaLogId = await persistQaLog({ aborted: false, errorMessage: null })
    if (qaLogId) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ type: 'meta', qa_log_id: qaLogId })}\n\n`
      ))
    }
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller.close()
  },

  async cancel() {
    // Client disconnected mid-stream. Order matters:
    // 1. Halt the upstream LLM IMMEDIATELY to stop burning tokens. Without this,
    //    Groq keeps generating up to max_tokens (1024) and we silently discard the
    //    output — a direct violation of Architectural Principle 3.
    downstreamAbort.abort()

    // 2. Persist the abort row (best effort; do not let a Supabase failure leak a logged error).
    await persistQaLog({ aborted: true, errorMessage: null })
  },
})
```

**The order is non-negotiable.** Aborting first saves tokens immediately; persisting second is bookkeeping. If the order were reversed, the LLM would keep generating during the ~50–150ms Supabase insert latency.

If the LLM call fails entirely (the catch path that today returns 502): call `persistQaLog({ aborted: false, errorMessage: '<message>' })` before returning the error response. The user gets their 502; the operator gets the row.

#### 2f. Emit `qa_log_id` to the client

Already shown in §2e — a single `data: {"type":"meta","qa_log_id":"<uuid>"}` event is enqueued before `[DONE]`. The frontend SSE parser already branches on `parsed.type` (`thinking` / `content`); adding a `meta` branch is a 3-line change.

A 100ms insert latency at stream close is invisible compared to the streamed answer duration. The synchronous `await persistQaLog` before `[DONE]` is acceptable.

#### 2g. Remove Spec A's `console.log`

Spec A added a `console.log` capturing `main / related / total` chars. Those values are now persisted as columns. Remove the log line — keep the function output clean.

### 3. Frontend — receive `qa_log_id`, render feedback UI

**Files:**
- [news-app/App.tsx](../../../news-app/App.tsx) — extend the answer state to carry `qaLogId`; thread to the answer renderer.
- `news-app/components/AnswerFeedback.tsx` (new, ~80 lines) — the 👍/👎 row.
- [news-app/lib/config.ts](../../../news-app/lib/config.ts) — extend `AnswerState` type with `qaLogId: string | null`.

#### 3a. SSE parser change

In the existing line-buffer SSE parser (App.tsx), add:

```ts
if (parsed.type === 'meta' && parsed.qa_log_id) {
  // Stash the id on the answer state for this article
  setAnswerForArticle(articleId, prev => ({ ...prev, qaLogId: parsed.qa_log_id }))
}
```

The `qaLogId` lives alongside `thinking` / `content` in the per-article answer state.

#### 3b. AnswerFeedback component

```tsx
type Props = {
  qaLogId: string | null
  lang: 'en' | 'zh'
}

// Renders nothing until qaLogId arrives. Renders two minimal buttons after.
// On tap: optimistic local state + supabase.from('qa_logs').update({ feedback, feedback_at: now }).eq('id', qaLogId)
// On error: revert optimistic state and surface a small inline notice.
// State persists for the lifetime of the answer view; no fetching of prior feedback.
```

Visual: two small icon buttons (👍 👎) right-aligned beneath the answer body. After tap, the chosen icon stays filled and the other dims; tapping the same again clears (returns to neutral). No "thanks for your feedback!" toast — the visual state change is the confirmation.

The feedback PATCH succeeds because of the column-level GRANT in §1: clients have UPDATE rights on `(feedback, feedback_at)` only. Any attempt to also write `response_text` etc. in the same PATCH would fail at the Postgres permission layer.

Bilingual `aria-label`s only (the icons are universal). Strings live in the component's local `STRINGS` constant per house style.

#### 3c. Render placement

In the answer-card render block (inside `ArticleCard.tsx` or wherever the streamed answer lives):

```tsx
<MarkdownText value={answer.content} />
{!answer.streaming && answer.qaLogId && (
  <AnswerFeedback qaLogId={answer.qaLogId} lang={lang} />
)}
```

The component renders **only after streaming has completed** (`!answer.streaming`) AND the `qa_log_id` has arrived. Tapping a thumb mid-stream is unsupported by design — the stream isn't done, so no judgment is yet warranted.

### 4. Operator triage queries

These are not implementation; they are the workflow this spec exists to enable. Document them in [docs/keep-in-mind.md](../../keep-in-mind.md) so the operator (and future architect) can reach for them.

```sql
-- Daily question volume
select date_trunc('day', asked_at) as day, count(*) from qa_logs
group by 1 order by 1 desc limit 14;

-- Negative feedback in last 7 days
select id, asked_at, lang, question, response_text, related_article_ids
from qa_logs
where feedback = -1 and asked_at > now() - interval '7 days'
order by asked_at desc;

-- Aborted-stream rate (proxy for "user gave up")
select date_trunc('day', asked_at), count(*) filter (where aborted) * 100.0 / count(*) as abort_pct
from qa_logs group by 1 order by 1 desc limit 14;

-- Long context queries (Spec A cap fired hard)
select id, asked_at, question, context_main_chars, total_tokens
from qa_logs
where context_main_chars >= 12000 and feedback = -1
order by asked_at desc;
-- ↑ This is the Spec-A → Spec-C correlation that justifies eventual chunking (Spec D).

-- Token cost per user, last 30 days
select user_id, sum(total_tokens) as tokens
from qa_logs where asked_at > now() - interval '30 days'
group by user_id order by tokens desc;

-- Hallucination-suspect rows (manual triage seed)
select id, question, response_text from qa_logs
where feedback = -1 and error_message is null
order by asked_at desc limit 50;

-- Token-leak canary: aborted streams should have total_tokens << max_tokens (1024).
-- If aborted rows show total_tokens near 1024, Fix 2 (§2e) is not actually firing.
select id, asked_at, total_tokens, total_ms
from qa_logs
where aborted = true
order by asked_at desc limit 20;
```

## Verification

### A. Behavioral (manual, blocking before ship)

| # | Scenario | Expected |
|---|---|---|
| 1 | Beta user asks a question against a short article | qa_logs row appears in dashboard with all fields populated; `aborted = false`, `error_message = null`, `response_text` matches what user saw |
| 2 | Frontend receives `qa_log_id` SSE event | Inspect Network → SSE stream → confirm a `data: {"type":"meta","qa_log_id":"..."}` line arrives before `[DONE]` |
| 3 | Beta user taps 👍 | qa_logs row's `feedback` column becomes `1`, `feedback_at` populated; UI shows filled 👍 |
| 4 | Beta user taps 👎 | qa_logs row's `feedback` becomes `-1`; UI shows filled 👎 |
| 5 | Beta user taps the same thumb again | Feedback clears (column = NULL); UI returns to neutral |
| 6 | User closes the tab mid-stream | qa_logs row written with `aborted = true`, `response_text` contains the partial text streamed so far, `total_ms` reflects the abort time |
| 7 | LLM tier all 502 (simulate by setting bad API keys for Tier 1+2+3) | qa_logs row written with `error_message` populated, `response_text = NULL`; user sees the 502 response; row exists |
| 8 | Long article (>12K chars) → confirm `context_main_chars = 12000` exactly, matching Spec A cap | Spec A and Spec C agree |
| **9 (CRITICAL — Fix 2)** | **Token-leak smoke test.** Start a query against a long article, generating an answer expected to use ~800–1024 completion tokens. Close the tab ~2 seconds in. | (a) Edge Function logs show an `AbortError` on the upstream LLM `fetch` (proves cancel propagated to Groq/OpenRouter/TokenRouter). (b) qa_logs row shows `aborted = true` AND `total_tokens` is roughly proportional to `total_ms / typical_ms_per_token` — i.e. a fraction of the 1024 budget. **If `total_tokens` is anywhere near 1024, Fix 2 is broken — the abort did not propagate and we are still leaking tokens.** Re-deploy and re-test until this fails-fast on a real cancel. |

### B. RLS / privacy / telemetry-integrity audit (architect, blocking)

1. **Cross-user read attempt.** Sign in as user A, ask a question (qa_logs row written). Sign in as user B (different invite). From dev console: `await supabase.from('qa_logs').select('*')`. Expected: **only B's rows**, not A's. If A's rows leak, the RLS SELECT policy is wrong.
2. **Anonymous (un-redeemed) read attempt.** `signInAnonymously()` without redeeming an invite. Same query. Expected: zero rows (`is_beta_user()` returns false).
3. **Anon-key read attempt.** From a curl with only the anon key (no user JWT): `curl -H "apikey: $ANON" $SUPABASE_URL/rest/v1/qa_logs`. Expected: empty array (RLS denies + GRANT removed).
4. **Cross-user feedback patch attempt.** As B, attempt to PATCH one of A's rows: `await supabase.from('qa_logs').update({ feedback: -1 }).eq('id', '<A-row-id>')`. Expected: zero rows updated, no error (RLS row-scope blocks).
5. **Service-role read (operator path).** From the Supabase dashboard SQL editor: `select count(*) from qa_logs;`. Expected: full count across all users. Confirms operator triage works.
6. **(CRITICAL — Fix 1) Telemetry tampering attempt — operational column.** As beta user A on their own row: `await supabase.from('qa_logs').update({ response_text: 'tampered' }).eq('id', '<own>')`. **Expected: Postgres permission error** (`permission denied for column response_text` or similar). If this update succeeds, the column-level GRANT in §1 is missing or broken — telemetry integrity is gone.
7. **(Fix 1 happy path) Feedback column update.** As beta user A on their own row: `await supabase.from('qa_logs').update({ feedback: 1 }).eq('id', '<own>')`. Expected: success. Confirms the layered defense permits the intended write while blocking the unintended one.

Tests #6 and #7 are paired — they prove the column-level GRANT is doing what it should AND not over-blocking the legitimate feedback flow.

### C. Quality / coverage check (one-time, post-deploy)

Run for 24 hours after ship, then query:

```sql
-- Coverage: did every answer-question call result in a row?
-- Heuristic: compare qa_logs(asked_at >= now()-1day) count to
-- Edge Function invocation count from Supabase dashboard's function logs.
-- Acceptance: ≥95% (some logs may legitimately be missing for null-userId paths).

-- Latency sanity: p50 / p95 ttft_ms and total_ms
select
  percentile_cont(0.5) within group (order by ttft_ms) as p50_ttft,
  percentile_cont(0.95) within group (order by ttft_ms) as p95_ttft,
  percentile_cont(0.5) within group (order by total_ms) as p50_total,
  percentile_cont(0.95) within group (order by total_ms) as p95_total
from qa_logs
where asked_at >= now() - interval '1 day' and not aborted and error_message is null;
-- Expected p50 ttft: <2s. Expected p95 total: <15s.
-- These are baselines — Spec D (chunking) and Spec E (rerank) will be measured against them.
```

If coverage < 95%, investigate null-userId paths (the `userId === null` skip in §2a). If latency p95 > targets, that's a separate optimization — not a Spec C blocker.

## Out of scope

- Reason picker on 👎 (binary only for round 1; add when 👎 rate > 5%).
- Implicit feedback (retry, abandonment, time-on-answer).
- Operator admin UI for triage (SQL queries via dashboard suffice).
- Clustering / labeling of badcases (manual triage for round 1).
- Eval harness productization — Spec A's 21-pair Markdown remains the curated eval set; `qa_logs` is the production stream.
- Retention policy enforcement.
- `generate-trend-brief` similarly persisting its LLM calls — different surface, separate spec if needed.
- Rate limiting on the feedback PATCH endpoint (RLS + column GRANT prevents misuse; volume is trivial).

## Critical files

| File | Status |
|---|---|
| `supabase/sql/20260426_qa_logs.sql` | New — schema + RLS + **column-level GRANTs (Fix 1)** |
| [supabase/functions/answer-question/index.ts](../../../supabase/functions/answer-question/index.ts) | Modified — JWT extraction, **AbortController hoisted (Fix 2)**, timing capture, response accumulator, token capture, qa_log INSERT, `meta` SSE event, `cancel()` handler that aborts upstream FIRST then persists, removes Spec A's `console.log` |
| [news-app/lib/config.ts](../../../news-app/lib/config.ts) | Modified — extends `AnswerState` with `qaLogId: string \| null` |
| [news-app/App.tsx](../../../news-app/App.tsx) | Modified — SSE parser branch for `meta`; thread `qaLogId` into answer state |
| `news-app/components/AnswerFeedback.tsx` | New |
| [news-app/components/ArticleCard.tsx](../../../news-app/components/ArticleCard.tsx) | Modified — render `<AnswerFeedback>` after stream completion |
| [docs/keep-in-mind.md](../../keep-in-mind.md) | Append the operator triage queries from §4 |

## Sequencing

- **Hard depends on Spec B** (auth gate). The RLS policies reference `is_beta_user()` and `auth.uid()`; without Spec B, no `is_beta_user()` exists and there is no JWT-bound user to attribute rows to.
- **Independent of Spec A** in mechanism (different files, different concerns), but Spec C *replaces* Spec A's `console.log` instrumentation. Ordering: Spec A ships first (P0), Spec C ships when Spec B is live, then the `console.log` is removed as part of Spec C's `answer-question` patch.
- **Required by Spec D** in spirit: chunking changes must be evaluated. The acceptance criteria for Spec D will reference baseline metrics computed from `qa_logs` data collected over Spec C's first 1–2 weeks live.
