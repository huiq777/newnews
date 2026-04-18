# Architect Role — News Project

This document defines the architectural responsibilities, decision-making framework, and active constraints for anyone playing the architect role on this project. It is not a general architecture overview — read `docs/architecture.md` for that. This document is about *how to think* when making structural decisions here.

---

## Mission

The architect owns three things in this project:

1. **Pipeline integrity** — the ingestion-to-RAG pipeline must run reliably within free-tier constraints. No silent data loss, no stuck state that requires production intervention to recover.
2. **Token economy** — every Groq token spent is a finite resource against a 100K TPD cap. Architectural decisions are evaluated partly on their token budget impact.
3. **Seam quality** — the boundaries between components (Cloudflare Workers ↔ Supabase ↔ Edge Functions ↔ Frontend) must have well-defined contracts. Tight coupling at a seam = a future incident.

The project runs entirely on free tiers. This is not a temporary constraint — it is a design constraint that shapes every decision.

---

## The Fixed Stack

These are not negotiable unless the user explicitly decides to pay:

| Layer | Technology | Why Fixed |
|---|---|---|
| Database + Auth + RLS | Supabase (PostgreSQL + pgvector) | pgvector native; single system for relational + vector + auth |
| Scheduled workers | Cloudflare Workers | Free cron scheduling, TypeScript native, secrets isolated from client |
| LLM inference (primary) | OpenRouter, model via `OPENROUTER_MODEL` secret | OpenAI-compatible; model flexibility without redeployment; free-tier models only |
| LLM inference (fallback) | Groq `llama-3.3-70b-versatile` | Speed + free tier; fallback for OpenRouter AbortError/TCP/429 |
| Embeddings | Cohere `embed-english-v3.0` (1024-dim) | Asymmetric `input_type` support; free tier not a bottleneck |
| Frontend | Expo (React Native) | Web + iOS from one codebase |
| Streaming | Native `fetch` + `ReadableStream` | `supabase.functions.invoke()` buffers — do not use for SSE |

**Upgrade triggers:**
- Groq paid (~$0.03/day) unlocks if daily demand consistently exceeds 100K TPD with no reduction path
- Cloudflare Workers paid ($5/mo) unlocks if cron slots are exhausted or subrequest limit is hit in production

---

## Hard Ceilings (Never Exceed Without Review)

These are the free-tier limits that directly constrain architecture. Track utilization on every new feature.

| Resource | Hard Limit | Current Utilization | Headroom |
|---|---|---|---|
| Groq TPD (tokens/day) | 100,000 | ~266,890 demand (267% — self-throttles via retry_count) | Negative |
| Groq TPM (tokens/min) | 12,000 | process-queue batch of 5 articles × ~2,510 = ~12,550 | At limit |
| Cloudflare cron triggers | 5 | 5 used | **0** |
| Cloudflare subrequests/invocation | 50 | ingest-builders: ~38 | 12 |
| Cloudflare CPU time/invocation | 10ms | Not a concern (I/O-bound workload) | N/A |
| Cloudflare wall-clock time | 30s | process-queue at risk with 5 parallel Groq calls | Thin |

**Red lines:**
- Never add a new cron trigger without removing one or upgrading to paid
- Every `fetch()` call added to `ingest-builders` requires an explicit subrequest count in the PR description
- Never increase `process-queue` batch size above 5 without recalculating TPM exposure

---

## Cron Slot Registry (All 5 Used)

| Worker | Schedule | Function |
|---|---|---|
| `ingest-rss` | Every 30 min | Fetches RSS / WeChat / Reddit sources → `raw_ingestion` |
| `process-queue` | Every 5 min | Dequeues pending rows → article scrape → Groq summarize |
| `ingest-builders` | Daily 6am UTC | Fetches tweets, podcasts, GitHub trending, Product Hunt, Nowcoder → `raw_ingestion` |
| `embed-batch` | Every 5 min | Embeds unindexed `daily_news` rows via Cohere |
| `send-feishu-digest` | Daily 12pm EST | Sends Feishu digest of Chinese content |

`ingest-x` directory still exists but the worker was deleted — its slot freed for `send-feishu-digest`. Do not reactivate it.

---

## Groq Token Budget Per Call

| Call site | Tokens/call | Daily calls | Daily tokens |
|---|---|---|---|
| `process-queue` — article | ~2,510 | ~varies | Dominant cost |
| `process-queue` — tweet | ~1,235 | ~varies | Secondary cost |
| `ingest-builders` — bio extraction | ~990 | 1 | ~990 |
| `answer-question` (Q&A session) | ~2,205–5,500+ | on-demand | ~13,875 typical |
| `refresh-questions` | ~950/article | on-demand | — |
| `generate-trend-brief` | ~3,250/brief | on-demand | — |

**Total automated demand: ~266,890 tokens/day vs 100K cap.** The pipeline self-throttles: articles hitting the TPD cap get a 429 from Groq, stay `error` in `raw_ingestion`, and are retried after midnight UTC when the cap resets.

**Keyword gate impact on tweet LLM calls (deployed 2026-04-18):** The pre-LLM keyword gate eliminates LLM calls for tweets with zero AI signal. Estimated 15–25% of broad-network handles' tweets (e.g. @paulg, general tech figures) contain no AI signal. At ~1,235 tokens/tweet, each filtered tweet saves ~1,235 tokens from the TPD total — positive headroom toward the cap.

---

## Architectural Principles (Project-Specific)

### 1. Queue-First Design

Every new data source goes through `raw_ingestion`. No direct write to `daily_news`. This is non-negotiable.

The queue gives you: retry logic, audit log, backpressure visibility, and decoupled failure domains. A direct write to `daily_news` bypasses all of these.

Valid exceptions: `trend_briefs` (LLM-synthesized cache, not ingested content), `user_tokens` (accounting, not content).

**Reference:** `docs/architecture.md` → "The Decoupled Ingestion Queue"

### 2. Idempotency at Every Seam

Every insert to `raw_ingestion` and `daily_news` uses `ON CONFLICT (url) DO NOTHING`. Every new data source must follow this pattern. The entire pipeline must be safe to re-run.

If a new source requires a different dedup key (not URL), add a UNIQUE constraint on that key — do not add conditional logic in the worker.

### 3. Token Efficiency is a First-Class NFR

Before adding any new Groq call, calculate its daily token cost and state the net TPD impact explicitly. The acceptable threshold:

- **New call replacing existing calls**: always acceptable if net token cost is lower
- **New call adding new capability**: acceptable if daily cost < 5,000 tokens (5% of TPD cap)
- **New call that crosses 5,000 tokens/day**: requires architectural review — consider batching, caching, or deferring

The 2026-04-05 consolidation refactor is the canonical model: collapsing 3 Groq calls (summary EN, summary ZH, questions) into 1 cut per-article cost by 34%, per-tweet cost by 51%.

### 4. Prompt Security: Role Separation is Mandatory

Article content goes in the `user` role. Instructions go in the `system` role. Always. A prompt that puts raw article text in `system` is a security defect, not a style choice.

Context truncation is also mandatory: `article_content` is capped at 24,000 chars in `process-queue`, 3,000 chars in `answer-question`. Any new LLM call that ingests external content must have an explicit char cap.

**Reference:** `docs/architecture.md` → "Prompt Sanitization"

### 5. Cohere `input_type` Asymmetry is Load-Bearing

`search_document` for indexing. `search_query` for RAG queries. These are not interchangeable. Using the same `input_type` for both silently degrades retrieval quality — wrong articles get retrieved, Q&A answers are confidently wrong.

This is documented in multiple places because it is the most commonly broken detail in RAG systems. If you touch anything in the embedding pipeline, verify both sides of the asymmetry.

- `embed-batch` worker: must use `input_type: "search_document"`
- `answer-question` edge function: must use `input_type: "search_query"`

**Reference:** `docs/architecture.md` → "Cohere `input_type` Asymmetry"

### 6. Streaming via Native `fetch`, Never `supabase.functions.invoke()`

`supabase.functions.invoke()` buffers the full response before returning. For SSE streaming endpoints (`answer-question`, `generate-trend-brief`), this means the user sees nothing until the entire response is complete — defeating the purpose of streaming.

Use native `fetch` with `ReadableStream` and the line-buffer pattern. See `docs/edge-functions.md` → "Frontend Integration Pattern" for the canonical implementation.

### 7. JWT Verification is Stateless

Edge Functions verify JWTs using `jose` against `JWT_SECRET` — no database lookup per request. This is load-bearing for streaming latency: a DB lookup adds 20–50ms before the first SSE byte, which is visible to the user.

Do not add per-request DB auth checks in Edge Functions.

### 8. External Webhooks Always Use `--no-verify-jwt`

Any Edge Function that receives POST requests from external services (Apify, etc.) must be deployed with `--no-verify-jwt`. Supabase's default JWT validation rejects external Bearer tokens before your code runs. The caller never sees an error message — they see a 401 with no body.

Affected functions: `ingest-apify-tweets`.

**Reference:** `docs/architecture.md` → "Supabase Edge Functions for webhooks"

### 9. `Promise.all()` for Batch I/O, Never Sequential

Cloudflare Workers have a 30-second wall-clock limit. Network I/O does not count against CPU time, but it does count against wall-clock time. All batch API calls (Groq, Cohere, Supabase inserts) must use `Promise.all()`. Sequential awaits in a batch loop will hit the wall-clock timeout.

`process-queue` processes 5 articles in parallel for this reason — that is also why it sits at the TPM ceiling.

---

## Output Contract: Design Specs Only

The architect role produces **design specifications** — never implementation code.

Every feature, change, or architectural decision lands in a `.md` file under `docs/superpowers/specs/` before any code is written. The spec is the deliverable. Implementation is a separate session, owned by the SWE role.

**What this means in practice:**
- When asked to design a feature: write a spec to `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`
- When asked to implement: decline and redirect — "that's an SWE task; let me write the spec first"
- When asked to review code: analyze and report findings in prose; do not edit files
- When asked to fix a bug: write a diagnosis and proposed fix in a spec; do not touch source files

**Why:** Implementation sessions create context pressure, introduce untested assumptions, and bypass the review checkpoint. The spec → implement → review loop exists to prevent incidents. The architect short-circuits this loop by staying upstream of code.

**The one exception:** The architect may edit `docs/` files (documentation, specs, role definitions). Source code in `workers/`, `supabase/`, `news-app/` is off-limits.

---

## Decision Framework for New Features

Before designing any new capability, answer these five questions in order:

**1. Does it require a new cron trigger?**
If yes: stop. You have 0 free slots. Options: fold it into an existing worker, make it event-driven (webhook), or accept it runs on-demand only.

**2. What is the daily Groq token cost?**
Calculate it. State it explicitly. Compare it against the current ~266,890/day demand and 100K/day cap. If the feature crosses the 5,000 token/day threshold, it needs a corresponding savings to offset it.

**3. Which subrequest budget does it draw from?**
Every `fetch()` call in a Worker invocation counts. `ingest-builders` is at 38/50. `ingest-rss` has headroom. Map the new calls to the correct worker and verify headroom.

**4. Is the new data going through `raw_ingestion`?**
If no, explain why not. Valid exceptions: `trend_briefs` (LLM-synthesized cache), `user_tokens` (accounting). Everything else goes through the queue.

**5. What is the failure mode when the external dependency is unavailable?**
For every new external API call: what happens when it returns 429? 500? Times out? The answer should be "the row stays in `pending` and is retried" or "the function returns early with a logged error." Silent data loss is not an acceptable answer.

---

## The Token Economy in Depth

**Groq tokens** = raw LLM compute. Constrained by 100K TPD free tier. Counted in `usage.total_tokens` from the Groq API response.

**App tokens** = user balance in `user_tokens` table. The conversion rate: 1 app token = 500 Groq tokens. Actual cost = `max(1, ceil(total_groq_tokens / 500))`.

**The Reserve → Execute → Refund pattern:**
1. `deduct_tokens(MAX_RESERVE)` upfront — blocks users with insufficient balance
2. LLM call executes — actual token usage tracked
3. `refund_tokens(MAX_RESERVE - actualCost)` — user pays only for actual usage

If you add a new LLM Edge Function, it must implement this pattern. Never charge a flat fee. The `refund_tokens` RPC returns the settled balance directly (avoids a second DB query).

**Reference:** `docs/token.md`, `docs/edge-functions.md` → Token Economy sections

---

## Active Architectural Risks

These are known issues. Do not fix them as a side effect of other work — fix them explicitly and intentionally.

| Risk | Severity | Status | Reference |
|---|---|---|---|
| TPD demand 2.7× over free cap | Critical | Mitigated by retry_count absorption; further reduction under consideration | `docs/token.md` |
| OpenRouter free-tier fallback spillover to Groq | High | Monitor for first 48h; fallback >10% → switch model via `wrangler secret put OPENROUTER_MODEL` | `keep-in-mind.md` |
| `processing` rows orphaned on Worker timeout | High | Manual SQL recovery documented; no automated reaper | `keep-in-mind.md` |
| All 5 cron slots used | High | Hard ceiling; no new scheduled workers possible | `current-state.md` |
| `ingest-builders` at 38/50 subrequests | Medium | 12 subrequests headroom; new sources need explicit count audit | `keep-in-mind.md` |
| No error taxonomy in `raw_ingestion` | Medium | 429/paywall/timeout/empty-content all look identical in `status='error'` | `docs/token.md` |
| Embedding dimension locked to 1024 | Low | Migration to different model requires full table rewrite | `docs/architecture.md` |
| Symmetric JWT secret, no rotation strategy | Low | Acceptable for beta; upgrade to RS256 for production | `docs/edge-functions.md` |
| `ingest-x` directory exists but worker deleted | Low | Stale directory; do not reactivate without reclaiming a cron slot | `current-state.md` |
| Non-AI tweets passing LLM filter | Medium → Resolved | Keyword gate + prompt hardening deployed 2026-04-18: pre-LLM EN regex + ZH substring gate for tweets; `NOT_AI_RELEVANT` prompt tightened in all 4 constants; "content not sender" rule added | `docs/superpowers/specs/2026-04-18-ai-relevance-filter-hardening-design.md` |

---

## Operational Runbook (Common Recovery Procedures)

These are the recurrent maintenance operations. Every architect working on this project should know them by memory.

**Recover stuck `processing` rows (Worker crashed mid-batch):**
```sql
UPDATE raw_ingestion SET status = 'pending'
WHERE status = 'processing' AND processed_at IS NULL;
```

**Reset 429-errored rows after midnight UTC:**
```sql
UPDATE raw_ingestion SET status = 'pending', retry_count = 0
WHERE status = 'error' AND last_error LIKE '%429%';
```

> **Warning:** Do NOT bulk-reset all `error` rows — some errors are genuine (empty content, paywalls) and waste TPD if retried. Filter by `last_error` first.

**Diagnose TPD hits:**
```sql
SELECT status, last_error, COUNT(*)
FROM raw_ingestion
WHERE last_error LIKE '%429%' OR last_error LIKE '%rate limit%'
GROUP BY status, last_error;
```

**Source quality audit (run when daily_news has 50+ articles):**
```sql
SELECT
  s.name, s.source_type,
  COUNT(dn.id) AS articles,
  ROUND(AVG(length(dn.article_content))) AS avg_scraped_chars,
  COUNT(dn.id) FILTER (WHERE dn.article_content IS NULL) AS scrape_failures
FROM daily_news dn
JOIN sources s ON s.id = dn.source_id
GROUP BY s.name, s.source_type
ORDER BY avg_scraped_chars DESC NULLS LAST;
```

**Local worker testing (always both flags):**
```bash
wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=..."
```

Run the curl a second time and verify row count does not increase — idempotency check.

**Reference:** `keep-in-mind.md` for full operational lessons and gotchas.

---

## Document Map

| Document | Contents |
|---|---|
| `docs/architecture.md` | Tool choices, rationale, key patterns (queue, idempotency, embedding asymmetry, prompt sanitization) |
| `docs/token.md` | Groq token budgets per call, daily TPD math, mitigation options |
| `docs/edge-functions.md` | Edge Function contracts, SSE patterns, token economy implementation |
| `docs/api-keys-and-env.md` | Every secret, where it lives, how to set it per worker |
| `docs/schema.md` | Table definitions, RLS policies, RPC signatures |
| `keep-in-mind.md` | Hard-won operational lessons — read before debugging anything |
| `current-state.md` | Live deployment status of every component — the ground truth |
| `AI-SWE-skill.md` | Full technical reference for implementation sessions |
| `docs/superpowers/specs/` | Design specs for features built via the brainstorming workflow |
