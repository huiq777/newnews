# Edge Functions

Two Supabase Edge Functions serve as the secure bridge between the frontend and AI providers. Both are stateless, article-scoped, and **require no authentication** — they read/write only public article data already accessible via the anon key.

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
2. Groq llama-3.3-70b-versatile → 3 EN questions (same prompt as process-queue)
3. Groq llama-3.3-70b-versatile → 3 ZH questions (same prompt)
4. PATCH daily_news SET questions = {en: [...], zh: [...]} WHERE id = article_id
5. Return the new questions as JSON
```

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
- **Downstream:** `process-queue` picks up inserted rows every 15 min. `isTweet=true` detection (via `x.com/status` URL) routes to `TWEET_SYSTEM_PROMPT` instead of `ARTICLE_SYSTEM_PROMPT`.

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
```
