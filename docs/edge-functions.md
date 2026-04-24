# Edge Functions

Supabase Edge Functions serve as the secure bridge between the frontend and AI providers. They are stateless and operate on public article data accessible via the anon key. The `ingest-apify-tweets` function is the exception — it is webhook-triggered (not called by the frontend) and requires a custom Bearer token.

**No `supabase.functions.invoke()` for streaming.** It buffers the full response. Use native `fetch` with `ReadableStream` instead — see the streaming pattern below.

---

## `answer-question` — Inline RAG Q&A

### Purpose
Takes a user's question about a specific article, embeds the question with Cohere, finds related articles via `match_articles` RPC, and streams the answer back via Groq.

### Request

```
POST /functions/v1/answer-question
Authorization: Bearer <supabase_anon_key>
Content-Type: application/json

{
  "article_id": "uuid",
  "question": "string",
  "lang": "en" | "zh"
}
```

### Response

```
Content-Type: text/event-stream

data: {"type": "content", "content": "Based on the article,"}
data: {"type": "content", "content": " OpenAI reduced prices..."}
data: [DONE]
```

Only `type: "content"` events are emitted. `reasoning_content` dead code exists for DeepSeek-R1 (decommissioned) — do not remove until a reasoning model replaces it.

### Internal Flow

```
1. Fetch article from daily_news (title, summary_en/zh, article_content)
2. Use article_content if available, else summary (fallback)
3. POST question to Cohere (input_type='search_query')  ← ASYMMETRIC — do not change
4. RPC match_articles(query_embedding, match_count=4) → top 3 related (excluding primary)
5. POST to Groq llama-3.3-70b-versatile streaming with full context + related articles
6. SSE stream: { type: 'content', content: string } chunks + data: [DONE]
```

### Required Secrets
- `GROQ_API_KEY`
- `COHERE_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Deploy
```bash
supabase functions deploy answer-question
supabase secrets set GROQ_API_KEY=... COHERE_API_KEY=... --project-ref <ref>
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

## Diagnostic Logs

```bash
# Tail live logs
supabase functions logs answer-question --tail
supabase functions logs refresh-questions --tail
supabase functions logs ingest-apify-tweets --tail
supabase functions logs generate-trend-brief --tail
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
supabase secrets set GROQ_API_KEY=... --project-ref <ref>
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
