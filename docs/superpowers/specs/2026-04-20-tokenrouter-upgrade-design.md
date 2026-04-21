# Design Spec: TokenRouter Upgrade — 5-System Overhaul

**Date:** 2026-04-20  
**Status:** Approved  
**Author:** Architect role

---

## Context

The project has been running on Groq's free tier (100K tokens/day). This cap causes ~60% of daily ingested articles to queue overnight unprocessed — only ~40 of ~155 daily items clear. A $1,000 TokenRouter credit (1-month expiry) eliminates this bottleneck entirely.

This spec covers five coupled changes: provider upgrade, delivery pipeline redesign, automated trend brief scheduling, multi-channel delivery expansion, and X tweet noise reduction.

---

## Scope Summary

| # | System | Change |
|---|---|---|
| 1 | LLM Provider | TokenRouter as primary, OpenRouter as secondary fallback, Groq as tertiary |
| 2 | Processing throughput | Automatically resolves when TPD cap is removed |
| 3 | Auto trend brief | pg_cron triggers generation at 00:00 UTC daily |
| 4 | Multi-channel delivery | `send-feishu-digest` → `send-digest` with Feishu + Slack + Discord + Notion |
| 5 | X tweet limiting | Top-3 net-new per author, quality-gated, at ingestion time |

---

## 1. Provider Chain (Three-Tier Fallback)

### Fallback order

```
TokenRouter (primary) → OpenRouter (secondary) → Groq (tertiary)
```

Fallback triggers: `AbortError` (timeout, no headers), TCP rejection, `429`, or **JSON parse failure** from the active provider. Non-2xx non-429 errors fail immediately with no fallback.

**JSON parse failure as a provider failure:** A provider returning 200 with malformed JSON or prose instead of structured output is a cognitive failure, not a success. It must trigger the fallback chain immediately — not bubble up to `processArticle`'s outer catch, which only increments `retry_count` and terminates the row for that run. Falling to the outer catch wastes a 15-minute retry slot; falling to the next provider heals in real-time.

Required change in `callLLM()` (TokenRouter tier) — replace the inline parse with:
```typescript
let parsed: Record<string, unknown>
try {
  parsed = JSON.parse(extractFirstJson(textContent))
} catch (err) {
  console.log(`[TokenRouter] JSON parse failed: ${(err as Error).message}. Payload: ${textContent.substring(0, 100)}. Falling back to OpenRouter.`)
  return await callOpenRouterFallback(isTweet, content, env)
}
return normalizeGemmaResponse(parsed, env.LLM_MODEL)
```

Apply the same pattern symmetrically in `callOpenRouterFallback()` — JSON parse failure there routes to `callGroqFallback()`.

### New secrets (Cloudflare Workers)

| Secret | Scope | Notes |
|---|---|---|
| `TOKENROUTER_API_KEY` | All LLM workers + edge functions | New — primary provider |
| `LLM_MODEL` | All LLM workers + edge functions | `qwen/qwen3.6-plus` for summarization |
| `TREND_BRIEF_MODEL` | `generate-trend-brief` only | `anthropic/claude-opus-4.7` |
| `OPENROUTER_API_KEY` | Existing — promoted to secondary fallback | Previously was primary |
| `OPENROUTER_MODEL` | Existing — used on OpenRouter fallback | Unchanged |
| `GROQ_API_KEY` | Existing — tertiary last resort | Unchanged |

Base URLs are constants in code (not secrets — they are public endpoints):
- TokenRouter: `https://api.tokenrouter.com/v1`
- OpenRouter: `https://openrouter.ai/api/v1`
- Groq: `https://api.groq.com/openai/v1`

### Affected files

- `workers/process-queue/src/index.ts` — primary LLM call + fallback chain
- `workers/ingest-builders/src/index.ts` — bio extraction call
- `supabase/functions/generate-trend-brief/index.ts` — trend brief generation
- `supabase/functions/answer-question/index.ts` — Q&A
- `supabase/functions/refresh-questions/index.ts` — question refresh

### Token budget impact

| Model | Task | Cost/1M tokens | Est. monthly volume | Est. monthly cost |
|---|---|---|---|---|
| `qwen/qwen3.6-plus` | Summarization | $0.54 in / $3.21 out | ~8.4M | ~$13.60 |
| `anthropic/claude-opus-4.7` | Trend brief | $5.00 in / $25.00 out | ~200K | ~$2.60 |
| `anthropic/claude-haiku-4.5` | Q&A / refresh | $1.00 in / $5.00 out | ~400K | ~$3 |
| **Total** | | | | **~$20/month** |

$1,000 credit → ~50× safety margin over 1 month.

### Groq retention rationale

Groq stays hardcoded as the tertiary fallback. It is the only provider with sub-second cold-start for small payloads and is the fastest recovery path for transient upstream outages.

---

## 2. Processing Throughput

The batch size of 5 articles per run and 15-minute cron schedule remain unchanged.

With the Groq 100K TPD cap removed as the primary constraint:
- Theoretical capacity: 5 × 96 runs = 480 articles/day
- Current ingestion demand: ~155 items/day
- All articles process same-day

The 429 → OpenRouter → Groq fallback chain handles any TokenRouter rate limits transparently.

**Timeout change in `process-queue`:** The current 15s AbortController fires before `qwen/qwen3.6-plus` returns headers, causing every call to fall through to OpenRouter. Raise to **25s** in `process-queue` only. Rationale: 5 parallel calls run concurrently via `Promise.all()` — wall-clock = slowest single call, not the sum. If qwen responds in ~20–24s, the batch resolves inside CF's 30s wall-clock limit.

**Wall-clock monitoring (first 48h):** If `Worker exceeded time limit` errors appear in the Cloudflare dashboard, lower batch size from `limit=5` to `limit=3`. At 3 articles/run × 96 runs/day = 288/day — still clears the 155/day ingestion demand. If timeouts persist at limit=3, fall back to migrating `process-queue` to a Supabase Edge Function (no wall-clock constraint, frees one CF cron slot).

---

## 3. Auto Trend Brief (pg_cron — Zero Cloudflare Slots Consumed)

### Problem

All 5 Cloudflare cron slots are used. Calling `generate-trend-brief` from a Cloudflare Worker is unsafe — the edge function can exceed the 30s wall-clock limit during generation.

### Solution

**pg_cron** (Postgres extension, available in Supabase) schedules a nightly call to the edge function from within the database. No Cloudflare slot consumed.

`net.http_post` is **fire-and-forget**: it schedules the HTTP request and returns immediately. The `cron.job_run_details` table will always report success once the HTTP call is scheduled — even if the Edge Function returns 500. Monitoring the nightly job health must be done exclusively via **Supabase Edge Function logs**, not cron status.

### Edge function change: `?trigger=true` mode

Add a branch to `generate-trend-brief` that:
1. Is authenticated via `SUPABASE_SERVICE_ROLE_KEY` (Bearer token) — **not** via JWT user auth
2. Skips SSE streaming entirely
3. Generates `synthesis_en` and `synthesis_zh` **in parallel** using `Promise.all([invokeClaude(enPrompt), invokeClaude(zhPrompt)])` — sequential calls with `anthropic/claude-opus-4.7` would take 60–90s and risk Edge Function timeout; parallel halves execution time to ~30–45s
4. Writes completed row to `trend_briefs` table
5. Returns `{ "status": "ok", "tokens_used": N }` as plain JSON

The existing streaming SSE path is **unchanged** — `?trigger=true` is additive.

Uses `TREND_BRIEF_MODEL` (`anthropic/claude-opus-4.7`) via TokenRouter.

**Timeout note:** The current codebase uses a 15s AbortController timeout for LLM calls. `anthropic/claude-opus-4.7` on TokenRouter exceeds this (time-to-first-header >15s). The `?trigger=true` branch must use a **60s timeout** for its TokenRouter calls. This is safe — Supabase Edge Functions have no 30s wall-clock constraint. The 15s timeout stays unchanged in `process-queue` (CF Worker, hard 30s wall-clock limit; `qwen/qwen3.6-plus` responds within that window).

### pg_cron setup (one-time SQL, run in Supabase SQL editor)

```sql
-- Ensure extensions are enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Store connection config (run once)
ALTER DATABASE postgres SET app.supabase_url = '<your-supabase-url>';
ALTER DATABASE postgres SET app.service_role_key = '<your-service-role-key>';

-- Schedule daily trend brief at 00:00 UTC (7PM EST / 8AM Beijing next day)
SELECT cron.schedule(
  'generate-daily-trend-brief',
  '0 0 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url')
           || '/functions/v1/generate-trend-brief'
           || '?trigger=true'
           || '&anchor_date=' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
           || '&step_days=1',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

### Failure mode

If trend brief generation fails (TokenRouter down, etc.), the `trend_briefs` row is not written. `send-digest` checks for the row at 00:30 UTC — if absent, digest sends without a trend brief section (graceful degradation, not a crash).

---

## 4. Multi-Channel Delivery (`send-digest`)

### Worker rename

`workers/send-feishu-digest` → `workers/send-digest`

Directory rename only. `wrangler.toml` name changes from `send-feishu-digest` to `send-digest`.

### Cron change

`0 17 * * *` (17:00 UTC / 12PM EST) → `0 30 0 * *` (00:30 UTC / 7:30PM EST)

30-minute buffer after trend brief generation at 00:00 UTC ensures the trend brief is written before the digest reads it.

> **Timing note:** Feishu now receives the digest at 7:30PM EST = 8:30AM Beijing. This is better alignment for the Beijing morning briefing than the previous noon-EST send.

### Delivery logic

```
1. Fetch top 10 articles (last 24h) from daily_news
2. Fetch today's trend_briefs row (anchor_date = today, step_days = 1)
3. Promise.all([sendFeishu(), sendSlack(), sendDiscord(), sendNotion()])
4. Each channel: skip silently if its secret is absent
5. Each channel delivery is independently try/caught — one failure does not block others
```

### Per-channel content

| Channel | Language | Article content | Trend brief |
|---|---|---|---|
| Feishu | Chinese | `title_zh` + `summary_zh` bullets | `synthesis_zh` appended |
| Slack | English | `title_en` + `summary_en` bullets | `synthesis_en` appended |
| Discord | English | Same as Slack (embed format) | `synthesis_en` appended |
| Notion | English | Full article list as page content | `synthesis_en` as page header |

Feishu card format is unchanged from `send-feishu-digest` (title_zh preferred, engagement badge, source role from bio_map).

### New Wrangler secrets

| Secret | Required | Notes |
|---|---|---|
| `FEISHU_WEBHOOK_URL` | Yes | Existing — unchanged |
| `SLACK_WEBHOOK_URL` | Optional | Slack Incoming Webhook URL |
| `DISCORD_WEBHOOK_URL` | Optional | Discord channel webhook URL |
| `NOTION_API_KEY` | Optional | Notion integration token |
| `NOTION_DATABASE_ID` | Optional | Target Notion database for new pages |

### Notion delivery note

Notion requires creating a new page in a database, not posting to a webhook. The worker uses the Notion REST API (`POST /v1/pages`) with `NOTION_API_KEY` in the `Authorization` header. Page title is the date; body is the trend brief + article list.

---

## 5. X Tweet Limiting with Grading

### Rule

**Maximum 3 net-new tweets per author per ingestion run**, selected by:
1. Keyword gate (same EN regex + ZH substring list as `process-queue`)
2. Sort surviving net-new tweets by `likes + retweets` descending
3. Keep top 3

**"Net-new" is required:** An author's feed contains older tweets with higher cumulative engagement. Without pre-filtering known URLs, the grading step selects already-ingested older tweets, the DB `DO NOTHING` fires, and today's new tweet (lower engagement because it's recent) is silently dropped.

### Bulk deduplication pattern (mandatory — no N+1 queries)

Both `ingest-builders` and `ingest-apify-tweets` must use this sequence:

```
1. Extract ALL tweet URLs from the entire incoming payload (all authors combined)
2. Chunk the URL list into batches of 100
   (PostgREST url=in.(...) GET hits HTTP 414 URI Too Long beyond ~100 URLs / ~4-8KB)
3. Promise.all() the chunked url=in.(...) GET requests to raw_ingestion concurrently
4. Merge results into a single in-memory Set<string> of knownUrls
5. Per-author grouping, filtering, and grading runs locally against knownUrls — zero additional network calls
```

**Subrequest budget:** ~500 total URLs / 100 per chunk = 5 concurrent subrequests. `ingest-builders` is currently at 38/50 — adds 5, reaching 43/50. Within the 12-slot headroom.

### Per-author pipeline (runs locally after bulk dedup)

```
1. Filter: remove URLs present in knownUrls Set
2. Keyword gate: keep tweets matching EN AI regex OR ZH substring list
3. Sort: descending by likes + retweets (from metadata field)
4. Truncate: keep top 3
5. Insert survivors via ON CONFLICT (url) DO NOTHING
```

### Implementation sites

- **`workers/ingest-builders/src/index.ts`** — apply before the existing DB insert loop
- **`supabase/functions/ingest-apify-tweets/index.ts`** — apply to incoming Apify dataset items before any inserts; group by `item.author.userName`

### No schema changes

Author is already embedded in `raw_content` (`@handle: text`) and engagement in `metadata.likes` + `metadata.retweets`. Author handle extracted from URL regex `/x\.com\/([^/]+)\/status\//`.

### Keyword gate constants

The EN regex and ZH substring array are duplicated into both `ingest-builders` and `ingest-apify-tweets` as local constants. A shared npm package is disproportionate for ~20 lines. Changes to the gate must be applied to both files.

---

## Cron Slot Registry (Post-Implementation)

All 5 slots remain fully used — no change:

| Worker | Schedule | Function |
|---|---|---|
| `ingest-rss` | Every 30 min | RSS/WeChat/Reddit → `raw_ingestion` |
| `process-queue` | Every 15 min | Dequeue → scrape → summarize |
| `ingest-builders` | Daily 6am UTC | Tweets/podcasts/GitHub → `raw_ingestion` |
| `embed-batch` | Every 5 min | Embed unindexed `daily_news` via Cohere |
| `send-digest` | Daily 00:30 UTC | Feishu + Slack + Discord + Notion delivery |

pg_cron runs inside Supabase — does not consume a Cloudflare slot.

---

## Implementation Order

1. **Provider chain** — add `TOKENROUTER_API_KEY`, update fallback logic in `process-queue` first. Validate with one manual trigger before touching other workers.
2. **Remaining provider updates** — propagate to `ingest-builders`, `answer-question`, `refresh-questions`.
3. **X tweet limiting** — update `ingest-builders` + `ingest-apify-tweets`. Low risk, isolated.
4. **`generate-trend-brief` trigger mode** — add `?trigger=true` branch + `TREND_BRIEF_MODEL` secret.
5. **pg_cron setup** — run SQL in Supabase dashboard after step 4 is deployed and tested.
6. **`send-digest` rename + multi-channel** — rename worker, add Slack/Discord/Notion delivery, update cron.

---

## Verification

### 1. Provider chain
- Manually trigger `process-queue` — confirm rows move to `done`, `last_error` absent
- Check Cloudflare Worker logs for provider label (add `console.log('[TokenRouter] calling...')` in implementation)
- Temporarily set `TOKENROUTER_API_KEY` to an invalid value → confirm logs show fallback to OpenRouter, then Groq

### 2. Qwen wall-clock monitoring (monitor first 48h post-launch)
- Check Cloudflare dashboard for `Worker exceeded CPU time limit` or `Script execution timeout` errors on `process-queue`
- **Rollback if observed:** Lower `process-queue` batch size from `limit=5` to `limit=3` (~line 473 in `index.ts`). Throughput drops from 480 to 288 articles/day — still clears the 155/day ingestion demand same-day

### 3. Tweet limiting
- Manually trigger `ingest-builders`
- Query: `SELECT SUBSTRING(raw_content FROM '@([^:]+):') AS handle, COUNT(*) FROM raw_ingestion WHERE created_at > now() - interval '2 hours' GROUP BY handle ORDER BY count DESC`
- Confirm: no handle exceeds count of 3

### 4. Trend brief trigger mode
- `POST /functions/v1/generate-trend-brief?trigger=true&anchor_date=<today>&step_days=1` with service role Bearer token
- Confirm `trend_briefs` row written with both `synthesis_en` and `synthesis_zh` non-null
- Confirm response is plain JSON `{ "status": "ok" }`, not an SSE stream

### 5. pg_cron registration
- `SELECT * FROM cron.job;` — confirm `generate-daily-trend-brief` row present
- After first nightly run: verify via **Supabase Edge Function logs** (not `cron.job_run_details` — that only confirms the HTTP call was *scheduled*, not that generation succeeded)

### 6. send-digest multi-channel
- Set all 4 channel secrets, manually trigger worker — confirm all 4 channels receive the digest
- Remove `SLACK_WEBHOOK_URL`, rerun — confirm Feishu/Discord/Notion still succeed, no crash
- Confirm digest sends without trend brief section when `trend_briefs` has no row for today (test with a future anchor_date in a manual query)
