# Design Spec: Migrate `process-queue` to Supabase Edge Function

**Date:** 2026-04-21  
**Status:** Approved  
**Author:** Architect role  
**Related spec:** `2026-04-20-tokenrouter-upgrade-design.md`

---

## Context

`process-queue` runs as a Cloudflare Worker on a 15-minute cron schedule. Cloudflare Workers have a hard 30-second wall-clock limit. `qwen/qwen3.6-plus` via TokenRouter takes >25s to return headers, causing every LLM call to timeout and fall through to OpenRouter/Groq — defeating the entire TokenRouter integration.

Extending the AbortController timeout to 25s was attempted and is insufficient. The only viable fix without switching to a lower-quality model is to remove the 30s wall-clock constraint entirely.

**Solution:** Migrate `process-queue` to a Supabase Edge Function triggered by pg_cron every 5 minutes. Supabase Edge Functions have no wall-clock limit. This also frees one Cloudflare cron slot (all 5 are currently used), and the tighter cron interval (up from the current `*/15`) gives 3x throughput headroom for demand spikes.

---

## What Changes

| | Before | After |
|---|---|---|
| Runtime | Cloudflare Worker | Supabase Edge Function |
| Trigger | CF cron (`*/15 * * * *`) | pg_cron → `net.http_post` every **5 min** |
| Cron interval | 15 min (96 runs/day, 480 items max) | **5 min** (288 runs/day, 1,440 items max) |
| LLM timeout | 25s AbortController (still times out) | 60s AbortController (qwen fits comfortably) |
| Execution model | Synchronous (response = completion) | **Fire-and-forget** (200 returned instantly, processing via background execution) |
| CF cron slots used | 5/5 | **4/5** (one freed) |
| Code logic | Unchanged | Ported with atomic batch claim + background execution pattern |

---

## Architecture

### Trigger chain

```
pg_cron (every 5 min)
└── net.http_post → /functions/v1/process-queue
    ├── Auth: service role Bearer token (--no-verify-jwt)
    ├── Return 200 immediately (pg_net connection released)
    └── Background execution (via EdgeRuntime.waitUntil):
        ├── RPC claim_pending_batch(5) — atomic SELECT+LOCK+UPDATE
        ├── Promise.all(5 articles)
        │   ├── Scrape article content
        │   ├── callLLM() → TokenRouter [60s timeout]
        │   │              → OpenRouter fallback [15s timeout]
        │   │              → Groq fallback [30s timeout — explicit, no CF kill net]
        │   └── insertAndMarkDone() / retry_count++
        └── Console.log({ processed: N })
```

### pg_cron job (run once in Supabase SQL editor after deployment)

```sql
SELECT cron.schedule(
  'process-queue-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/process-queue',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);
```

**`timeout_milliseconds := 5000`:** This is the pg_net HTTP timeout — how long pg_net's background worker waits for the HTTP response before closing the connection. The Edge Function returns 200 within milliseconds (auth check only), so 5s is generous. The actual batch processing runs in the background via `EdgeRuntime.waitUntil()` and is unaffected by this timeout.

`app.supabase_url` and `app.service_role_key` are already set in Postgres config from the trend brief pg_cron setup. No additional `ALTER DATABASE` commands needed if that was done first.

### Deployment flag

Must be deployed with `--no-verify-jwt` — pg_cron's `net.http_post` sends a service role Bearer token, not a user JWT. Without this flag, Supabase's gateway rejects the request with a 401 before the function runs.

```bash
supabase functions deploy process-queue --no-verify-jwt
```

---

## Code Changes

### New file: `supabase/functions/process-queue/index.ts`

Port the entire logic from `workers/process-queue/src/index.ts` with these targeted changes:

**1. Entry point — replace CF Worker `scheduled()` handler with Deno HTTP handler:**
```typescript
// Before (CF Worker)
export default {
  async fetch() { return new Response('ok') },
  async scheduled(_event: ScheduledEvent, env: Env) { ... }
}

// After (Edge Function — fire-and-forget with background execution)
import { timingSafeEqual } from "jsr:@std/crypto/timing-safe-equal"

Deno.serve(async (req) => {
  // SECURITY: --no-verify-jwt exposes this endpoint publicly.
  // Verify service role key programmatically to prevent unauthorized LLM spend.
  // NOTE: Do NOT use crypto.subtle.timingSafeEqual — that is Node.js only.
  // The Web Crypto API (Deno's crypto.subtle) does not implement timingSafeEqual.
  // Using it would throw TypeError on every invocation, killing the pipeline.
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const expected = new TextEncoder().encode(`Bearer ${SERVICE_KEY}`)
  const actual = new TextEncoder().encode(req.headers.get('Authorization') ?? '')
  if (expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Return 200 immediately — pg_net's connection is released.
  // Heavy processing runs in the background via EdgeRuntime.waitUntil().
  // This prevents pg_net timeout from killing the execution context.
  // Catch top-level rejections from processBatch() to prevent unhandled promise
  // rejection from crashing the Deno isolate and terminating overlapping tasks.
  EdgeRuntime.waitUntil(processBatch().catch(err => console.error('[processBatch] unhandled rejection:', err)))
  return new Response(JSON.stringify({ status: 'accepted' }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

async function processBatch() {
  // same body as scheduled() — claim batch, process articles, mark done
  // All console.log output is visible in Supabase Edge Function logs
}
```

**2. Environment variables — replace `env.*` with `Deno.env.get()`:**
```typescript
// Before
env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.LLM_MODEL, ...

// After
Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, ...
```

**Note:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are **auto-injected** by the Supabase Edge Function runtime — do not set them manually in the dashboard (they are reserved system variables and attempting to set them will error). Only `TOKENROUTER_API_KEY`, `LLM_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and `GROQ_API_KEY` need to be set as secrets.

**3. TokenRouter timeout — raise from 25s to 60s:**
```typescript
// Before
setTimeout(() => controller.abort(), 25000)

// After
setTimeout(() => controller.abort(), 60000)
```

**4. Log message fix — update hardcoded stale message:**
```typescript
// Before (line 401 — stale message from before the 25s change)
console.log('[TokenRouter] 8s timeout — no headers received, falling back to OpenRouter')

// After
console.log('[TokenRouter] 60s timeout — no headers received, falling back to OpenRouter')
```

**5. JSON parse fallback — already specced in tokenrouter-upgrade-design.md, apply here:**
```typescript
// In callLLM() — TokenRouter tier
let parsed: Record<string, unknown>
try {
  parsed = JSON.parse(extractFirstJson(textContent))
} catch (err) {
  console.log(`[TokenRouter] JSON parse failed: ${(err as Error).message}. Payload: ${textContent.substring(0, 100)}. Falling back to OpenRouter.`)
  return await callOpenRouterFallback(isTweet, content, env)
}
return normalizeGemmaResponse(parsed, env.LLM_MODEL)

// In callOpenRouterFallback() — same pattern routes to callGroqFallback()
```

**6. Groq fallback timeout — add explicit AbortController (REQUIRED):**

In the CF Worker, a hung Groq socket would be killed by Cloudflare's 30s wall-clock limit. On a Supabase Edge Function with no wall-clock kill, a Groq API hang (socket open, no response) stalls the `processBatch()` background task indefinitely. Rows remain locked in `processing`, and every subsequent pg_cron invocation piles up until Supabase's concurrent execution limit is hit.

```typescript
// Before (callGroqFallback — no timeout, relies on CF wall-clock)
const groqRes = await fetch(GROQ_API, { method: 'POST', headers: {...}, body: ... })

// After — explicit 30s AbortController
async function callGroqFallback(isTweet: boolean, content: string, env: Env): Promise<LLMResult> {
  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), 30000)
  try {
    const groqRes = await fetch(GROQ_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ... }),
      signal: controller.signal,
    })
    clearTimeout(timerId)
    // ... rest of response handling unchanged
  } catch (fetchErr: unknown) {
    clearTimeout(timerId)
    // AbortError or TCP failure — Groq is the last fallback, so throw to outer catch
    throw new Error(`Groq unreachable: ${(fetchErr as Error).message}`)
  }
}
```

Everything else (all LLM routing, scraping, parsing, DB writes, retry logic, keyword gate, engagement propagation) is **ported verbatim**.

### HTMLRewriter — explicit import required (CRITICAL)

`process-queue` uses `HTMLRewriter` to strip article DOM elements during scraping. In Cloudflare Workers, `HTMLRewriter` is a global — no import needed. **In Deno (Supabase Edge Functions), it is NOT a global.** A verbatim copy of the Worker code will crash in production with `ReferenceError: HTMLRewriter is not defined`.

Add this import at the top of `supabase/functions/process-queue/index.ts`:
```typescript
import { HTMLRewriter } from "https://deno.land/x/html_rewriter@v0.1.0-pre.17/mod.ts"
```

No other code changes needed — the API surface is identical once imported.

### HTMLRewriter validation gate (MUST PASS BEFORE MIGRATION PROCEEDS)

The Deno `html_rewriter` package wraps a WASM binary (`lol-html`). Supabase Edge Functions run on Deno Deploy, which has restrictions on WASM execution. **If WASM is blocked, `fetchArticleContent()` is completely broken — not degraded, broken.** No articles get scraped, no summaries get generated.

**Step 0 (before any other implementation work):** Deploy a minimal validation Edge Function:

```typescript
import { HTMLRewriter } from "https://deno.land/x/html_rewriter@v0.1.0-pre.17/mod.ts"

Deno.serve(async () => {
  const html = "<html><body><nav>strip me</nav><p>keep me</p></body></html>"
  const texts: string[] = []
  let rewriter = new HTMLRewriter()
  rewriter = rewriter.on('nav', { element(el) { el.remove() } })
  rewriter = rewriter.on('p', { text(chunk) { if (chunk.text.trim()) texts.push(chunk.text.trim()) } })
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } })
  await rewriter.transform(res).text()
  return new Response(JSON.stringify({ texts }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

```bash
supabase functions deploy htmlrewriter-test --no-verify-jwt
curl <SUPABASE_URL>/functions/v1/htmlrewriter-test
# Expected: {"texts":["keep me"]}
# Then delete: supabase functions delete htmlrewriter-test
```

**If validation fails:** Replace `HTMLRewriter` with `linkedom` — a **pure JavaScript** DOM implementation with zero WASM dependency. Do NOT use `deno-dom` (`deno-dom-wasm.ts`) as a fallback — it also relies on WASM and would fail for the same reason.

```typescript
import { parseHTML } from "https://esm.sh/linkedom@0.16.8"

async function fetchArticleContent(url: string): Promise<{ content: string; published_at: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timeout)
    if (!res.ok) return { content: '', published_at: null }

    const htmlText = await res.text()
    const { document } = parseHTML(htmlText)

    // Strip unwanted elements
    for (const sel of ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript']) {
      document.querySelectorAll(sel).forEach((el: Element) => el.remove())
    }

    // Extract text from content elements
    const texts: string[] = []
    document.querySelectorAll('p, h1, h2, h3').forEach((el: Element) => {
      const t = (el as unknown as { textContent: string }).textContent?.trim()
      if (t) texts.push(t)
    })

    // Extract publish date from meta tags
    let htmlPublishedAt: string | null = null
    const dataMetas = ['article:published_time', 'publishdate', 'date', 'og:article:published_time']
    for (const name of dataMetas) {
      const meta = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
      if (meta) { htmlPublishedAt = meta.getAttribute('content'); break }
    }
    if (!htmlPublishedAt) {
      const timeEl = document.querySelector('time[datetime]')
      if (timeEl) htmlPublishedAt = timeEl.getAttribute('datetime')
    }

    const result = texts.join(' ').replace(/\s+/g, ' ').trim()
    const lede = result.slice(0, 300).toLowerCase()
    if (lede.includes('subscribe') && lede.includes('sign in')) return { content: '', published_at: htmlPublishedAt }
    return { content: result, published_at: htmlPublishedAt }
  } catch {
    clearTimeout(timeout)
    return { content: '', published_at: null }
  }
}
```

**Why `linkedom` over `deno-dom`:** `deno-dom`'s import (`deno-dom-wasm.ts`) is itself WASM-based — if Deno Deploy blocks WASM for `HTMLRewriter`, it will block `deno-dom` for the same reason. `linkedom` is pure JavaScript with no native/WASM dependencies, making it a genuine fallback.

**Key difference from `HTMLRewriter`:** `linkedom` requires fetching the full HTML as a string first (`await res.text()`), then parsing. The CF `HTMLRewriter` streams and transforms in-flight. For articles capped at 24K chars this is not a performance concern — the full HTML fits in memory.

### Delete: `workers/process-queue/`

After the Edge Function is deployed and pg_cron is confirmed working, delete the entire `workers/process-queue/` directory and remove its entry from `workers/` documentation.

### Update: `workers/process-queue/wrangler.toml` → delete (not needed after migration)

---

## Cloudflare Cron Slot Registry (Post-Migration)

| Worker | Schedule | Function |
|---|---|---|
| `ingest-rss` | Every 30 min | RSS/WeChat/Reddit → `raw_ingestion` |
| `ingest-builders` | Daily 6am UTC | Tweets/podcasts/GitHub → `raw_ingestion` |
| `embed-batch` | Every 5 min | Embed unindexed `daily_news` via Cohere |
| `send-feishu-digest` | Daily 12pm EST | Sends Feishu digest of Chinese content |
| ~~`process-queue`~~ | ~~Every 15 min~~ | **Freed — now pg_cron** |

4/5 slots used. One slot available for future use. (The `send-feishu-digest` → `send-digest` rename is scoped to the TokenRouter upgrade spec, not this migration.)

---

## pg_net execution model (CRITICAL — differs from direct HTTP)

`net.http_post` is fire-and-forget: pg_cron schedules the HTTP request and returns immediately. But pg_net's **background HTTP worker** has its own timeout (`timeout_milliseconds`, default ~2s). If the Edge Function doesn't return a response before this timeout, pg_net drops the connection. On Deno Deploy, a client disconnect can abort the execution context — killing in-flight LLM calls and orphaning rows in `processing` status.

**This is why the Edge Function must return 200 immediately** and use `EdgeRuntime.waitUntil()` for batch processing (see entry point code above). The pg_cron SQL explicitly sets `timeout_milliseconds := 5000` as a safety margin — the auth check + 200 response takes <50ms.

**Monitoring (same caveat as trend brief):** `cron.job_run_details` reports success as soon as the HTTP call is scheduled, not when batch processing completes. Monitor processing health via:
- **Supabase Edge Function logs** (not cron status)
- **SQL:** `SELECT status, COUNT(*) FROM raw_ingestion GROUP BY status` — pending count should not grow unboundedly
- **Orphan detection:** `SELECT COUNT(*) FROM raw_ingestion WHERE status = 'processing' AND updated_at < now() - interval '10 minutes'` — non-zero means a batch was killed mid-flight

---

## Concurrent execution guard (REQUIRED)

**Problem:** In the CF Worker, the 30s wall-clock kill guaranteed that no invocation outlived the cron interval. With the Edge Function running in the background (via `EdgeRuntime.waitUntil`) and a 60s LLM timeout, a slow batch could still be processing when pg_cron fires the next invocation 5 minutes later. Two concurrent invocations both `SELECT ... WHERE status='pending' LIMIT 5` and can grab the **same 5 rows** before either PATCHes them to `processing`. `ON CONFLICT DO NOTHING` prevents duplicate `daily_news` rows, but the duplicated LLM calls waste tokens — up to 12,550 tokens per overlap (5 articles × ~2,510 tokens).

**Fix:** Replace the current two-step SELECT → PATCH with a single atomic RPC. Create this function in Supabase SQL editor:

```sql
CREATE OR REPLACE FUNCTION claim_pending_batch(batch_size int DEFAULT 5)
RETURNS SETOF raw_ingestion
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Restrict to service_role only. PostgREST exposes all public schema functions
  -- via /rest/v1/rpc/. Without this check, anyone with the anon key could drain
  -- the entire pending queue by calling this endpoint repeatedly.
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: service_role required';
  END IF;

  RETURN QUERY
  UPDATE raw_ingestion
  SET status = 'processing'
  WHERE id IN (
    SELECT id FROM raw_ingestion
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

-- Belt-and-suspenders: revoke public execution even with the internal check above
REVOKE EXECUTE ON FUNCTION claim_pending_batch(int) FROM PUBLIC;
```

`FOR UPDATE SKIP LOCKED` ensures that if two invocations race, the second one skips already-locked rows and claims the *next* batch (or returns empty if fewer than `batch_size` pending rows remain). No wasted LLM calls.

**Why both `SECURITY DEFINER` + `REVOKE`:** `REVOKE` alone is sufficient to block PostgREST/anon callers; the `auth.role()` check is defence-in-depth for any future path (e.g., a migration script running as a non-service role). Either alone would work; both together are belt-and-suspenders.

**Edge Function code change — replace the SELECT + PATCH block:**

```typescript
// Before (two REST calls, race-prone)
const res = await fetch(`${sbUrl}/rest/v1/raw_ingestion?status=eq.pending&limit=5&select=...`, ...)
const articles = await res.json()
await Promise.all(articles.map(a => fetch(`${sbUrl}/rest/v1/raw_ingestion?id=eq.${a.id}`, { method: 'PATCH', ... })))

// After (single atomic RPC)
const res = await fetch(`${sbUrl}/rest/v1/rpc/claim_pending_batch`, {
  method: 'POST',
  headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
  body: JSON.stringify({ batch_size: 5 }),
})
const articles = await res.json()
```

---

## Implementation Order

This migration **must happen after** the TokenRouter provider chain is wired up in the codebase (Step 1 from the main upgrade spec), since the Edge Function code depends on `TOKENROUTER_API_KEY` and `LLM_MODEL` secrets being set.

0. **Validate HTMLRewriter on Deno Deploy** — deploy the minimal test function (see "HTMLRewriter validation gate" above). If it fails, implement the `deno-dom` fallback before proceeding. **Do not skip this step.**
1. Create `claim_pending_batch` RPC in Supabase SQL editor (see "Concurrent execution guard" above)
2. Port `workers/process-queue/src/index.ts` → `supabase/functions/process-queue/index.ts` with the targeted changes above, including the atomic RPC claim and timing-safe auth
3. Set secrets in Supabase dashboard: `TOKENROUTER_API_KEY`, `LLM_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `GROQ_API_KEY` (do **not** set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` — these are auto-injected by the runtime)
4. Deploy: `supabase functions deploy process-queue --no-verify-jwt`
5. Test manually: `curl -X POST <SUPABASE_URL>/functions/v1/process-queue -H "Authorization: Bearer <SERVICE_ROLE_KEY>"` — confirm rows move from `pending` → `done`, check `llm_model` field shows `qwen/qwen3.6-plus`
6. **Disable CF Worker cron** — remove the `[triggers]` section from `workers/process-queue/wrangler.toml` and redeploy (`wrangler deploy`). The worker stays deployed but inert — no cron fires, no code deleted.
7. Register pg_cron job (SQL above)
8. Monitor for **48 hours** — confirm `pending` count drains each cycle, no concurrent execution overlap in Edge Function logs
9. Delete `workers/process-queue/` directory (only after 48h stable operation)

---

## Rollback Procedure

If the Edge Function fails in production during the 48h monitoring window:

1. **Restore CF cron trigger:** Re-add `[triggers] crons = ["*/15 * * * *"]` to `workers/process-queue/wrangler.toml` and `wrangler deploy`
2. **Unschedule pg_cron:** `SELECT cron.unschedule('process-queue-every-5min');`
3. **Verify:** `SELECT * FROM cron.job;` — confirm the `process-queue-every-5min` row is gone; CF Worker dashboard shows cron active

The CF Worker code is unchanged and still deployed — rollback is a config change, not a code revert. This is why step 9 (directory deletion) is gated on 48h stability, not on "pg_cron confirmed working."

---

## Verification

- **Provider is correct:** `SELECT llm_model, COUNT(*) FROM daily_news WHERE created_at > now() - interval '1 hour' GROUP BY llm_model` — majority should show `qwen/qwen3.6-plus`, not `llama-3.3-70b-versatile`
- **No timeout errors:** Supabase Edge Function logs show `[TokenRouter] ok (200)` without falling back
- **Throughput intact:** `SELECT status, COUNT(*) FROM raw_ingestion GROUP BY status` — `pending` count drains across the day; no unbounded growth
- **Idempotency:** Trigger the function twice in quick succession — row count in `daily_news` must not increase on the second call (existing `ON CONFLICT` logic unchanged)
- **CF slot freed:** Cloudflare Workers dashboard shows `process-queue` worker deleted; 4 workers remain
