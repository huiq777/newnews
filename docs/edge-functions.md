# Edge Functions

Supabase Edge Functions serve as the secure bridge between the frontend and AI providers. They are stateless and operate on public article data accessible via the anon key. The `ingest-apify-tweets` function is the exception — it is webhook-triggered (not called by the frontend) and requires a custom Bearer token.

**No `supabase.functions.invoke()` for streaming.** It buffers the full response. Use native `fetch` with `ReadableStream` instead — see the streaming pattern below.

---

## `answer-question` — Inline RAG Q&A

### Purpose
Takes a user's question about a specific article, embeds the question with Cohere, finds related articles via `match_articles_prefer_analysis` RPC, and streams the answer back. Decomposed into `route()` → `retrieve()` → `generate()` → `orchestrateAnswer()` stages. Every call writes a `qa_logs` row and a linked RAG trace (`rag_retrieval_runs`, candidate rows when available, injected-context rows) with `request_id`, timings, tokens, abort flag, retriever inputs, ranked candidates/scores, and exact prompt context. User 👍/👎 feedback is written back by the `AnswerFeedback` component.

### Request

```
POST /functions/v1/answer-question
Authorization: Bearer <user_jwt>
apikey: <supabase_anon_key>
Content-Type: application/json

{
  "article_id": "uuid",
  "question": "string",
  "lang": "en" | "zh",
  "deep_think": false,
  "force_refresh": false
}
```

`deep_think: true` routes to `qwen/qwen3.6-plus` (thinking model); default uses `QA_LLM_MODEL` (e.g. `qwen/qwen3.5-flash`).

### Response

```
Content-Type: text/event-stream

data: {"type": "thinking", "content": "..."}   ← deep_think only
data: {"type": "content", "content": "Based on the article,"}
data: {"type": "content", "content": " OpenAI reduced prices..."}
data: {"type": "meta", "qa_log_id": "uuid", "feedback": null}
data: [DONE]
```

### Internal Flow

```
1. route()    — resolve article, check cache, select LLM model (deep_think vs default)
2. retrieve() — Cohere embed question (input_type='search_query' ← ASYMMETRIC, load-bearing)
               → match_articles_prefer_analysis(query_embedding, match_count=4) → top 3 related (excluding primary)
               → write trace rows for retriever input, candidates, scores, and injected context
3. generate() — TokenRouter streaming SSE (primary → OpenRouter → Groq fallback)
               — deep_think: stream type:thinking chunks before type:content
4. orchestrateAnswer() — wire abort propagation, persist qa_logs row with request_id + timing + rag_retrieval_run_id
```

### Retrieval Behavior Guardrail

The 2026-05-31 trace completeness work did not change retrieval or model behavior. Production `answer-question` still uses article-level dense `match_articles_prefer_analysis`, preferring ready Deep Analysis vectors and falling back to article embeddings. Dense/lexical/hybrid/chunk experiments live in offline eval scripts only until a later metric-gated production plan.

### Required Secrets
- `TOKENROUTER_API_KEY`
- `QA_LLM_MODEL` (default path model, e.g. `qwen/qwen3.5-flash`)
- `GROQ_API_KEY` (fallback)
- `COHERE_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

### Deploy
```bash
supabase functions deploy answer-question
supabase secrets set TOKENROUTER_API_KEY=... COHERE_API_KEY=... QA_LLM_MODEL=qwen/qwen3.5-flash --project-ref <ref>
```

---

## `refresh-questions` — On-Demand Question Regeneration

### Purpose
Regenerates 3 EN + 3 ZH questions for an article on demand. Called when the user taps `↻` on an article card (or when `questions` is null).

### Request

```
POST /functions/v1/refresh-questions
Authorization: Bearer <supabase_anon_key>
Content-Type: application/json

{
  "article_id": "uuid"
}
```

### Response

```json
{
  "en": ["Question 1?", "Question 2?", "Question 3?"],
  "zh": ["问题一？", "问题二？", "问题三？"]
}
```

Non-streaming JSON response. Fast enough that streaming isn't needed.

### Internal Flow

```
1. Fetch article's summary_en and summary_zh from daily_news
2. Groq llama-3.3-70b-versatile → 3 EN questions (2 parallel Groq calls: EN + ZH)
3. Groq llama-3.3-70b-versatile → 3 ZH questions (parallel with step 2)
4. PATCH daily_news SET questions = {en: [...], zh: [...]} WHERE id = article_id
5. Return the new questions as JSON
```

Note: `refresh-questions` still uses 2 separate Groq calls (EN + ZH parallel). Only `process-queue` was consolidated to 1 call. This is intentional — refresh-questions operates on existing summaries and the 2-call approach keeps question quality high for on-demand regeneration.

### Required Secrets
- `GROQ_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Deploy
```bash
supabase functions deploy refresh-questions
```

---

## `ingest-apify-tweets` — Apify Webhook Receiver

### Purpose
Receives POST webhooks from Apify when a scheduled actor run completes (`RUN_SUCCEEDED`). Fetches the tweet dataset, maps items to `raw_ingestion` rows, and batch-inserts. Decouples Apify's external scheduling from the processing pipeline — Workers can't receive inbound HTTP triggers, so an Edge Function is required.

### Flow
```
1. Validate Authorization: Bearer <APIFY_WEBHOOK_SECRET> → 401 if wrong
2. Parse body → extract body.resource.defaultDatasetId (falls back to body.eventData.datasetId)
3. GET https://api.apify.com/v2/datasets/{datasetId}/items?token={APIFY_API_KEY}
4. SELECT sources WHERE source_type='apify_tweet' AND is_active=true → source.id
5. Map each tweet item → raw_ingestion row:
   - url: item.url
   - raw_content: "@{item.author.userName}: {item.text}"
   - metadata: { likes: item.likeCount ?? 0, retweets: item.retweetCount ?? 0 }
   - source_id, status: 'pending'
6. Batch POST /rest/v1/raw_ingestion with Prefer: resolution=ignore-duplicates
7. Return 200 { inserted: N }
```

### Secrets Required
- `APIFY_API_KEY` — Apify account token
- `APIFY_WEBHOOK_SECRET` — shared secret set in Apify webhook Headers template
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — standard

### Deploy
```bash
# MUST use --no-verify-jwt — Apify sends a custom Bearer token, not a Supabase JWT
supabase functions deploy ingest-apify-tweets --no-verify-jwt
supabase secrets set APIFY_API_KEY=apify_xxxx --project-ref <ref>
supabase secrets set APIFY_WEBHOOK_SECRET=your-secret --project-ref <ref>
```

### Apify Webhook Config
- Event: `RUN_SUCCEEDED`
- URL: `https://<project-ref>.supabase.co/functions/v1/ingest-apify-tweets`
- Headers template (JSON): `{"Authorization": "Bearer your-secret"}`

### Critical Gotchas
- **`--no-verify-jwt` is required.** Without it, Supabase validates the Authorization header as a JWT and returns 401 before the function code runs.
- **Test payload has no datasetId.** Apify's "Send test notification" button sends a fake payload (Chuck Norris joke). The function returns 400 on test — this is expected. Only real `RUN_SUCCEEDED` events carry `resource.defaultDatasetId`.
- **Downstream:** `process-queue` picks up inserted rows every 5 min. `isTweet=true` detection (via `x.com/status` URL) routes to `TWEET_SYSTEM_PROMPT` instead of `ARTICLE_SYSTEM_PROMPT`.

### Diagnostic Logs
```bash
supabase functions logs ingest-apify-tweets --tail
```

---

## `redeem-invite` — Closed-Beta Auth Gate (Round 1)

### Purpose
Atomically claims a [`beta_invites`](schema.md#beta_invites) row, ties it to the caller's `auth.uid()`, and writes server-only `app_metadata.is_beta_user = true` so the frontend gate can let the user through. The companion of [news-app/lib/auth.ts](../news-app/lib/auth.ts)'s `useAuthGate` hook.

This is the only Edge Function in the project that needs both a per-request user-bound client AND a service-role client in the same request — the design exists to keep the privileged write (metadata) strictly server-side while still attributing the action to the verified caller.

### Request
```
POST /functions/v1/redeem-invite
Authorization: Bearer <user JWT>           ← gateway pre-validates signature
apikey: <SUPABASE_ANON_KEY>                ← supabase-js adds this automatically
Content-Type: application/json

{ "code": "<invite-code>" }
```

The Supabase API gateway runs the JWT signature check before the function executes (`verify_jwt = true`). Inside, `auth.getUser()` extracts the verified `userId` — there is no manual `jose` import.

### Response
```json
// Success
200 { "ok": true,  "display_name": "Wang Lei", "default_lang": "zh" }

// Documented business failures (HTTP 200 — `ok: false` is the contract)
200 { "ok": false, "error": "invalid" }    // unknown code
200 { "ok": false, "error": "used" }       // already redeemed by someone else
200 { "ok": false, "error": "expired" }    // expires_at <= now()

// Auth failures (gateway or function-level)
401 { "ok": false, "error": "invalid" }    // missing/invalid JWT or anon-key only
405 { "ok": false, "error": "invalid" }    // wrong method
500 { "ok": false, "error": "invalid" }    // metadata write failed; client should retry
```

### Internal Flow (with the load-bearing invariants)
```
1. CORS preflight: respond to OPTIONS with allowlist
   ['authorization', 'apikey', 'content-type', 'x-client-info']
   ← supabase-js adds apikey + sometimes x-client-info; the spec's original
     allowlist of just 'authorization, content-type' fails the preflight.

2. Per-request supabase client (anon key + caller's Authorization header)
   → auth.getUser() → verified userId. Anon-key-only JWTs return null user → 401.

3. Service-role client for the privileged writes that follow.

4. ATOMIC CLAIM (race-safe): single conditional UPDATE
     update beta_invites
     set used_at = now(), user_id = caller
     where code = ? and used_at is null
       and (expires_at is null or expires_at > now())
     returning display_name, default_lang
   Postgres serializes the row update — exactly one caller wins on a race.
   .maybeSingle() — empty result must fall through, not throw.

5. IDEMPOTENT RECOVERY (network-partition safety):
   If the atomic claim returned no row, look it up:
   - row missing             → ok:false invalid
   - row used_at IS NULL     → ok:false expired (the .or() filter rejected it)
   - row used_at IS NOT NULL AND user_id == caller
     → treat as success, fall through to step 6
     ← this is THE branch that prevents a dropped first-attempt response
       from permanently bricking a beta user. Without it, the second
       click sees "used by someone else" and the invite is dead forever.
   - row used_at IS NOT NULL AND user_id != caller → ok:false used

6. Set app_metadata via auth.admin.updateUserById:
     { is_beta_user: true, display_name, default_lang }
   ← app_metadata, NOT user_metadata. user_metadata is client-writable
     via supabase.auth.updateUser({ data: ... }); app_metadata is
     service-role only and is what the gate trusts.

7. Return ok:true with display_name and default_lang.
```

### Required Secrets
None set manually — Supabase auto-injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` into deployed functions.

### Deploy
```bash
supabase functions deploy redeem-invite
# Default verify_jwt = true is correct. Do NOT pass --no-verify-jwt —
# this function relies on the gateway pre-validating user JWTs.
```

---

## `unsubscribe-email` — Email Digest Unsubscribe

### Purpose
Unauthenticated one-click unsubscribe for email digest subscribers. Visited directly from an unsubscribe link embedded in digest emails.

### Deploy
```bash
supabase functions deploy unsubscribe-email --no-verify-jwt
```

### Request
```
GET /functions/v1/unsubscribe-email?id=<subscriber-uuid>
```

### Flow
1. Extract `id` from query params; return 400 if missing.
2. PATCH `email_subscribers` where `id = ?` and `unsubscribed_at IS NULL`, setting `unsubscribed_at = now()` (service role, PostgREST REST call).
3. Return an HTML confirmation page (200) regardless of whether the row existed — idempotent.

### Notes
- `--no-verify-jwt` required: unsubscribe links in emails are clicked by unauthenticated users.
- Service role key used internally; never exposed to the caller.

### Project-Level Pre-Reqs
The function alone is not enough. Three Supabase project settings must be in place — see [keep-in-mind.md](keep-in-mind.md#1-anonymous-sign-ins-are-off-by-default-in-newer-supabase-projects) for the full diagnosis of each:
1. Authentication → Sign In / Sign Up → **Anonymous Sign-Ins ON**.
2. Authentication → Attack Protection → **Captcha protection OFF** (or wire a widget — not in scope for invite-only beta).
3. Any `on_auth_user_created` trigger on `auth.users` must early-return on `new.is_anonymous` (otherwise public-table inserts in the trigger fail for anonymous redemptions, surfacing as HTTP 500 "Database error creating anonymous user").

### Frontend Caller
```ts
// supabase-js attaches the user JWT and apikey automatically.
const { data, error } = await supabase.functions.invoke('redeem-invite', {
  body: { code },
})
// On success: await supabase.auth.refreshSession() — without this, the
// persisted JWT in localStorage stays stale and reload re-shows the gate.
```

### Diagnostic Logs
```bash
supabase functions logs redeem-invite --tail
```

---

## Frontend Integration Pattern

Use `fetch` with `ReadableStream` for streaming. Do NOT use `supabase.functions.invoke()` — it buffers the entire response before returning.

```typescript
const response = await fetch(
  `${supabaseUrl}/functions/v1/answer-question`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ article_id, question, lang }),
  }
)

const reader = response.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''   // keep incomplete line for next chunk
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const event = JSON.parse(line.slice(6))
      if (event.type === 'content') {
        // append event.content to answer state
      }
    }
  }
}
```

The line buffer (splitting on `\n`, keeping the incomplete tail) is required because SSE chunks can arrive mid-line. See `news-app/App.tsx` → `handleAsk()` for the live implementation.

---

## `process-queue` — Scrape, Summarize, and Queue Articles

### Purpose
Pulls batches of `pending` rows from `raw_ingestion`, scrapes article content, runs bilingual summary + question generation via TokenRouter, and writes clean articles to `daily_news`. Triggered by pg_cron every 5 min via Supabase Vault service role key.

### Internal Flow

```
1. claim_pending_batch(batch_size=5) RPC — atomic batch claim; MVCC guard against double-processing
2. Per article:
   a. is_ai_relevant RPC — keyword gate (fail-open); skip → pipeline_events step=keyword_gate status=skip
   b. Scrape article URL (node-html-parser) — tweets and WeChat use raw_content directly
   c. 1 TokenRouter LLM call: title_en/zh + summary_en/zh + questions_en/zh combined prompt
      Primary: qwen/qwen3.6-plus (120s) → OpenRouter secondary → Groq tertiary
   d. parseJsonSection extracts JSON arrays from LLM response
   e. INSERT into daily_news; propagate engagement from raw_ingestion.metadata
   f. Write pipeline_events rows: keyword_gate, llm, insert, llm_category_mismatch
3. run_id UUID stamped on raw_ingestion + daily_news rows for full pipeline trace
```

### Required Secrets
- `TOKENROUTER_API_KEY`
- `GROQ_API_KEY` (tertiary fallback)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `service_role_key` in Supabase Vault (for pg_cron invocation)

### Deploy
```bash
supabase functions deploy process-queue
supabase secrets set TOKENROUTER_API_KEY=... GROQ_API_KEY=... --project-ref <ref>
```

### pg_cron trigger
```sql
select cron.schedule('process-queue-every-5min', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/process-queue',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
$$);
```

---

## Diagnostic Logs

```bash
# Tail live logs
supabase functions logs answer-question --tail
supabase functions logs refresh-questions --tail
supabase functions logs ingest-apify-tweets --tail
supabase functions logs generate-trend-brief --tail
supabase functions logs process-queue --tail
```

---

## `generate-trend-brief` — Cross-Window Trend Synthesis ✅ Live

### Purpose
Fetches all articles in a selected time window (ALL categories), clusters them by semantic similarity, selects up to 12 representative articles, enriches with historically related articles via pgvector, and streams a synthesis analysis via TokenRouter (`TREND_BRIEF_MODEL` secret, default `anthropic/claude-opus-4.7`) SSE. The other language is generated in parallel as a non-streaming call and written to DB on completion. Result cached in `trend_briefs` for 6 hours. Only called on cache miss — cache hit renders immediately from the DB.

### Request

```
GET /functions/v1/generate-trend-brief?anchor_date=2026-03-28&step_days=7
Authorization: Bearer <supabase_anon_key>
```

Query params:
- `anchor_date` — ISO date (upper bound of window, inclusive)
- `step_days` — window width in days (1, 7, 30, 90)

### Response

```
Content-Type: text/event-stream

data: {"type": "content", "content": "The AI inference cost war"}
data: {"type": "content", "content": " is accelerating faster..."}
data: [DONE]
```

Frontend AbortController fires on window change — `req.signal` is propagated to the upstream Groq fetch, killing generation within ~1s. Returns HTTP 499 on abort; writes to `trend_briefs` only on full completion.

### Internal Flow

```
1. Check trend_briefs cache (anchor_date, step_days, expires_at > now())
   → HIT: return synthesis directly (no generation)
   → MISS: proceed

2. Fetch all daily_news rows in window (published_at BETWEEN anchor_date-step_days AND anchor_date)
   Include: id, title, summary_en, published_at, embedding, engagement JSONB

3. Two-pass clustering in Deno memory (effectiveTarget = min(totalArticles, 12)):
   PASS 1 — cosine_similarity > 0.82 grouping; engagement DESC tiebreak (likes→votes→score→0)
   PASS 2 — proportional slot allocation:
     dominantCap (≥20% of total) = ceil(effectiveTarget × 0.40)
     mediumCap   (≥5% of total)  = ceil(effectiveTarget × 0.20)
     smallCap    (all others)    = 1

4. Historical enrichment: for each selected article WITH embedding:
   → match_articles(embedding, match_count=5)
   → post-query filter: exclude published_at within current window, score < 0.82
   → deduplicate across seeds
   → result: 5–10 historical articles (title + published_at + bullet 1 only)
   Articles WITHOUT embedding: included in prompt as text, skip historical retrieval

5. Compress articles for prompt:
   Current:    [N] title | date | bullet1 | bullet2 | bullet3
   Historical: [N] title | date | bullet1

6. Primary language: TokenRouter streaming SSE with TREND_BRIEF_MODEL; secondary language: TokenRouter non-streaming (parallel, 25s timeout) — both written to DB on completion
   System prompt: ruthless senior tech analyst; structural shift + blast radius + weak signals + citations + catalyst

7. On full completion: INSERT into trend_briefs (synthesis, sources_json, tokens_used, expires_at = now() + 6h)
   On abort (AbortError): log { event: 'client_disconnected', ... }, return 499; do NOT write to DB

8. Stream SSE back to frontend
```

### Structured Logging

```ts
// Success
{ event: 'brief_generated', duration_ms, tokens_used, source_count, historical_count, anchor_date, step_days }
// Abort
{ event: 'client_disconnected', duration_ms, chars_streamed, anchor_date, step_days }
// Rate limit
{ event: 'rate_limited_429', anchor_date, step_days }
```

### Required Secrets
- `TOKENROUTER_API_KEY` — all LLM calls (synthesis + streaming SSE)
- `TREND_BRIEF_MODEL` — model ID for TokenRouter (default: `anthropic/claude-opus-4.7`)
- `COHERE_API_KEY` — for historical enrichment embedding
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Deploy
```bash
supabase functions deploy generate-trend-brief
supabase secrets set TOKENROUTER_API_KEY=... TREND_BRIEF_MODEL=anthropic/claude-opus-4.7 COHERE_API_KEY=... --project-ref <ref>
```

### Token Budget
| Content | ~Tokens |
|---|---|
| 12 current articles (title + 3 bullets) | ~2,000 |
| 5–8 historical articles (title + date + bullet 1) | ~400 |
| System prompt | ~300 |
| Output (synthesis prose) | ~550 |
| **Total** | **~3,250** |

`article_content` is never sent — summaries are purpose-built for this use case.
