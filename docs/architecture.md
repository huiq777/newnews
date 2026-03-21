# Architecture

This document records every significant technical decision made during design. When you encounter something that looks non-obvious — a table structure, a workflow split, an API choice — the reason is here.

---

## Tool Choices

### Supabase (not Firebase)
Supabase runs on PostgreSQL, which means `pgvector` is a native extension rather than a bolt-on. Vector similarity search, relational joins, RLS policies, and Auth all live in one system. Firebase would require a separate vector database, a separate hosting layer for functions, and much more glue code.

### Cloudflare Workers (not n8n, not Lambda / Cloud Functions)
All external API calls — RSS fetching, Groq summarization, Cohere embedding — run inside Cloudflare Workers, not inside Supabase Edge Functions. Reasons:

1. **Secrets never reach the client.** Workers hold `GROQ_API_KEY`, `COHERE_API_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` as encrypted environment variables via `wrangler secret put`. Edge Functions hold only the keys they need for user-facing calls.
2. **Free and reliable cron scheduling.** Cloudflare Cron Triggers are first-class, execute on time, and are free up to 100,000 invocations/day. The entire pipeline triggers ~300 times/day — 0.3% of the limit. GitHub Actions was considered and rejected: its cron jobs can drift 30–90 minutes under load, and the 2,000 free minutes/month is exhausted by the 15-minute processing workflow alone.
3. **TypeScript native.** No context switch from the rest of the stack. Workers use the same language as the Supabase Edge Functions and the Expo frontend.

**Critical implementation pattern — always use `Promise.all()` for batch API calls:**
Workers have a 30-second wall-clock time limit per invocation. Processing articles sequentially (one Groq call, wait, next Groq call, wait...) at 5 seconds per call means 20 articles = 100 seconds — which exceeds the limit. With `Promise.all()`, 20 Groq calls fire simultaneously and all complete in ~5 seconds total.

```typescript
// Wrong: sequential — will timeout at scale
for (const article of articles) {
  await callGroq(article)
}

// Correct: parallel — all 20 calls complete in ~5 seconds
await Promise.all(articles.map(article => callGroq(article)))
```

Note: network I/O (fetch API calls) does not count against the 10ms CPU time limit. Only JavaScript execution counts. Parsing RSS XML and building JSON payloads is microseconds of CPU. The CPU limit is not a concern for this workload.

### Groq (Llama 3 70B) for summarization
Speed. Groq's hardware delivers LLM inference at throughputs that make batch article processing feasible within a tight cron window. The summarization task (3 bullet points from article text) doesn't require reasoning depth — it requires speed and reliability.

### Cohere embed-english-v3.0 for embeddings
The model produces 1024-dimensional embeddings, which directly defines the `vector(1024)` column in `daily_news`. The model supports an `input_type` parameter that distinguishes between indexing and querying — this distinction is load-bearing for retrieval quality (see below). It is available from both Cloudflare Workers (for indexing) and Supabase Edge Functions (for query-time embedding), keeping the embedding symmetric.

### Groq for both chatbots (MVP)
Both chatbots use Groq's free API tier in the MVP. Groq hosts open-source models on their inference hardware — the model weights are the same as running locally.

- **Chatbot 1 (`chat-live`):** `llama-3.3-70b-versatile` — general assistant. No live web search in MVP.
  - **Upgrade path:** swap to Perplexity Sonar ($5/mo) or add Tavily search (free, 1K/mo) for live web results. One URL + one model name change.
- **Chatbot 2 (`chat-rag`):** `deepseek-r1-distill-llama-70b` — reasoning model for RAG over stored articles. Exposes chain-of-thought reasoning via the `reasoning_content` field in the streaming response, which powers the "View reasoning" collapsible accordion in the UI.
  - **Upgrade path:** swap to DeepSeek API directly (`deepseek-reasoner`, ~$0.55/1M tokens) for the full model. Same API format, same response structure.

---

## The Decoupled Ingestion Queue

The pipeline does **not** fetch articles and summarize them in a single workflow. It uses two separate workflows with `raw_ingestion` as the buffer between them.

```
Workflow 1 (daily)        Workflow 2 (every 15 min)
─────────────────         ──────────────────────────
RSS feeds                 raw_ingestion (pending rows)
    │                              │
    ▼                              ▼
raw_ingestion              Groq summarization
(status: pending)                  │
                                   ▼
                             daily_news
                          (status: done)
```

**Why the split?**
- Fetching is fast and cheap; summarization is slow (LLM call) and has API rate limits. Decoupling means a Groq timeout doesn't block the next RSS fetch.
- The queue gives you a retry mechanism for free. If Groq fails, the row stays in `pending` (or moves to `error` after 3 attempts). No article is silently lost.
- The `raw_ingestion` table is also an audit log. You can inspect every article that was ever fetched, whether it was processed successfully, and what errors occurred.

---

## Idempotency

The pipeline is designed to be safe to run multiple times without creating duplicates.

- `raw_ingestion.url` has a `UNIQUE` constraint. Inserting the same article twice results in `ON CONFLICT (url) DO NOTHING` — the second write is silently skipped.
- `daily_news.url` has the same constraint. If the processing workflow somehow runs twice on the same raw article, the second insert into `daily_news` is also a no-op.
- No SHA-256 hashing. The URL itself is the deduplication key. Hashing adds complexity with no benefit — it makes rows non-queryable by URL without pre-hashing and provides no additional collision resistance for URLs.

---

## Ingestion Status State Machine

```
         ┌─────────┐
         │ pending │  ← Initial state on RSS fetch
         └────┬────┘
              │ n8n picks up the row (sets status = 'processing')
              ▼
       ┌────────────┐
       │ processing │  ← In-flight: Groq API call in progress
       └──────┬─────┘
              │
       ┌──────┴──────┐
       │             │
       ▼             ▼
   ┌──────┐      ┌───────┐
   │ done │      │ error │  ← After 3 failed retries
   └──────┘      └───────┘
```

The `processing` status is set **before** calling Groq. This is a pessimistic lock — if the Worker crashes mid-call, the row stays in `processing` rather than being re-picked up by the next run and double-processed. A maintenance task or manual reset is required to recover stuck `processing` rows (acceptable for v1).

---

## Prompt Sanitization

Raw article text is passed directly to an LLM. Two rules apply:

1. **Truncate before calling Groq.** The Groq call uses a character limit of **24,000 characters** (~6,000 tokens at ~4 chars/token). This protects against hitting the model's context window and against unusually large HTML blobs. Implemented in the Worker as `rawContent.substring(0, 24000)`.

2. **Strict role separation.** Article content must never appear in the `system` role — only in the `user` role. A malicious article body cannot override the system prompt if they are in separate message slots.

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are a news summarizer. Output exactly 3 concise bullet points that capture the core facts of the article. Use plain text, no markdown."
    },
    {
      "role": "user",
      "content": "Summarize this article:\n\n[truncated article text]"
    }
  ]
}
```

---

## Cohere `input_type` Asymmetry

**This is the most commonly misunderstood detail of the RAG pipeline.**

`embed-english-v3.0` requires an `input_type` parameter that tells the model the purpose of the text being embedded. Using the wrong type silently degrades retrieval quality.

| Operation | Where | `input_type` |
|---|---|---|
| Indexing article summaries | Cloudflare Worker (`embed-batch`) | `search_document` |
| Embedding user's question at query time | `chat-rag` Edge Function | `search_query` |

These two values produce vectors optimized for their respective roles. Embedding both with the same `input_type` (a common mistake) means the dot product similarity scores are lower and less discriminative — the wrong articles get retrieved, and the final answer is confidently wrong.

---

## Why the Embedding Batch Job Lives in a Cloudflare Worker, Not a DB Trigger

An earlier design used a Supabase database trigger that fired an Edge Function on every `INSERT` into `daily_news`. This was rejected for three reasons:

1. **Fan-out under batch load.** Inserting 50 articles fires 50 simultaneous Edge Function invocations, immediately hitting Supabase's concurrency ceiling and Cohere's rate limit.
2. **`pg_cron` cannot call external HTTP APIs.** `pg_cron` schedules SQL — it cannot make outbound HTTP calls without `pg_net`, which adds complexity and bypasses centralized credential management.
3. **Retry logic is harder in triggers.** A failed embedding call inside a trigger is difficult to retry cleanly. In a Worker, retries are explicit TypeScript.

The Cloudflare Worker polling approach (every 5 minutes, `WHERE embedding IS NULL LIMIT 50`) handles all three concerns.
