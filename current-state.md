# Current State — 2026-03-20

This document is the single source of truth for where the project stands. Read this first in every new session before touching any code.

---

## What Phase We Are In

**Phase 2.1 (Auto-Questions) is mostly complete. RAG enhancement for `answer-question` is the active remaining task.**

The frontend is fully built. All infrastructure is deployed. The one pending code change is adding RAG to `answer-question` so it can reference related articles when the primary article's summary lacks enough detail.

---

## Phase 2.1 — What It Is

Every article card surfaces 3 pre-generated questions inline. The user clicks a question → `llama-3.3-70b-versatile` streams an answer directly on the card. No login. No separate chat screen. Questions are generated at ingestion time by `process-queue` and stored as JSONB in `daily_news.questions`.

> **Note:** DeepSeek-R1 (`deepseek-r1-distill-llama-70b`) was decommissioned by Groq. Replaced with `llama-3.3-70b-versatile`. This model does not emit `reasoning_content`, so thinking blocks are not shown — only `type:content` SSE events are emitted.

---

## Deployed State of Every Component

### Cloudflare Workers

| Worker | Status | Schedule | Notes |
|---|---|---|---|
| `ingest-rss` | ✅ Deployed | Daily 7am UTC | RSS + Atom feeds, batch insert, ON CONFLICT DO NOTHING |
| `process-queue` | ⚠️ Deployed (old prompts) | Every 15 min | Question prompts upgraded locally — **must redeploy** |
| `ingest-x` | ✅ Deployed (disabled) | Hourly | X API requires $100/mo; sources set is_active=false |
| `embed-batch` | ✅ Deployed | Every 5 min | Cohere embed-english-v3.0, 1024-dim; populates daily_news.embedding |

### Supabase Edge Functions

| Function | Status | Notes |
|---|---|---|
| `answer-question` | ✅ Deployed | Uses `llama-3.3-70b-versatile`; streams `type:content` only; RAG not yet added |
| `refresh-questions` | ✅ Deployed | Returns new questions JSON; upgraded analytical prompts |

### Supabase Tables

| Table | Status |
|---|---|
| `sources` | ✅ 10 rows (rss + wechat + x_api); public_read_sources RLS policy active |
| `raw_ingestion` | ✅ Working |
| `daily_news` | ✅ `questions JSONB` column added; `embedding` column being populated by embed-batch |
| `match_articles` RPC | ❌ SQL not run yet — needed for RAG |

### Expo Frontend (`news-app/App.tsx`)

**Phase 2.1 UI complete.**

Working features:
- Paginated feed (20/page, page number nav)
- EN/中 language toggle — bilingual titles + summaries
- Source label: `公众号 - Founder Park` (WeChat) or `TechCrunch` (RSS)
- `ArticleCard` standalone component with per-card state
- `? 3 Questions` pill (top-right) — only shows when `questions` non-null
- Questions expand/collapse; `↻` refresh regenerates questions via `refresh-questions`
- Click question → streams answer via `answer-question` SSE
- `Thinking...` indicator while streaming, answer renders word-by-word with `▌` cursor
- Language toggle resets open answers; switching language shows questions in correct language
- `Read more →` is the only tap target that opens URL (card body tap disabled)
- SSE parsed with line buffer (handles split chunks); `res.ok` check before stream read

---

## Immediate Next Steps (in order)

### 1. Redeploy `process-queue` (upgraded question prompts not yet live)
```bash
cd workers/process-queue && wrangler deploy
```

### 2. Run `match_articles` SQL (needed for RAG)
In Supabase SQL Editor:
```sql
CREATE OR REPLACE FUNCTION match_articles(
  query_embedding vector(1024),
  match_count     int DEFAULT 5
)
RETURNS TABLE (id UUID, title TEXT, summary TEXT, score FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT id, title, summary,
         1 - (embedding <=> query_embedding) AS score
  FROM daily_news
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

### 3. Add `COHERE_API_KEY` to Supabase Edge Function secrets
Supabase Dashboard → Edge Functions → Manage Secrets → add `COHERE_API_KEY`

### 4. Update `answer-question` with RAG + redeploy
Update `supabase/functions/answer-question/index.ts` to:
1. Embed the question via Cohere (`input_type: search_query`)
2. Call `match_articles` RPC → top 3 related articles (excluding primary)
3. Append related summaries to system prompt as supplementary context

Then: `supabase functions deploy answer-question`

### 5. Trigger embed-batch to backfill existing articles
```bash
cd workers/embed-batch
wrangler dev --remote --test-scheduled
# second terminal:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
Verify: `SELECT COUNT(*) FROM daily_news WHERE embedding IS NOT NULL`

---

## Active RSS Sources

```
TechCrunch:    https://techcrunch.com/feed/                                          (rss)
The Verge:     https://www.theverge.com/rss/index.xml                               (rss)
Ars Technica:  https://feeds.arstechnica.com/arstechnica/index                      (rss)
Hacker News:   https://news.ycombinator.com/rss                                     (rss)
Founder Park:  https://wechat2rss.xlab.app/feed/e95ec80ad542565f0eeaf02a42c6d021a7ae51bc.xml  (wechat)
GeekPark:      https://wechat2rss.xlab.app/feed/1a5aec98e71c707c8ca092bc2c255b9d4bac477d.xml  (wechat)
财联社:         https://wewe-rss-latest-oau3.onrender.com/feeds/MP_WXS_*.atom         (wechat)
中国新闻社:     https://wewe-rss-latest-oau3.onrender.com/feeds/MP_WXS_*.atom         (wechat)
36氪:          https://wewe-rss-latest-oau3.onrender.com/feeds/MP_WXS_*.atom         (wechat)
```

WeChat detection in frontend: `item.url?.includes('mp.weixin.qq.com')` — do NOT rely on source_type join (PostgREST multi-column join issue; see keep-in-mind.md).

---

## Supabase Info

- **Project URL:** `https://exjbwdcxyrkxsmzaowkx.supabase.co`
- **sources columns:** `id, name, rss_url, is_active, created_at, source_type`
- **raw_ingestion columns:** `id, source_id, url, raw_content, fetched_at, status, retry_count, last_error, processed_at`
- **daily_news columns:** `id, source_id, raw_ingestion_id, url, title, summary, title_en, summary_en, title_zh, summary_zh, published_at, embedding, created_at, questions`

---

## Key Technical Facts

- **Groq model (summaries + questions):** `llama-3.3-70b-versatile` — 12K TPM free tier
- **Groq model (answer streaming):** `llama-3.3-70b-versatile` — DeepSeek-R1 decommissioned; only `type:content` SSE events, no thinking blocks
- **Cohere model (embeddings):** `embed-english-v3.0` — 1024-dim; `input_type: search_document` at index time, `input_type: search_query` for RAG question embedding
- **process-queue Groq calls per article:** 3 (summary + EN questions + ZH questions) — watch TPM limit
- **Groq 429 TPM:** wait 1 min, re-trigger
- **Cloudflare subrequest limit:** 50/invocation — process-queue uses ~31. Safe.
- **Stuck rows:** `UPDATE raw_ingestion SET status='pending' WHERE status='processing';`
- **answer-question SSE events:** `{ type: "content", content: "..." }` chunks then `data: [DONE]`
- **Streaming in Expo:** use `fetch` + `ReadableStream` with line buffer — do NOT use `supabase.functions.invoke()` (buffers entire response)
- **FlatList extraData:** always pass `extraData={[sourceMap, lang]}` when renderItem depends on async state
- **RAG pattern:** embed question with Cohere → call match_articles RPC → inject top 3 related summaries into system prompt; COHERE_API_KEY required as Edge Function secret

---

## Key Files

| File | Purpose |
|---|---|
| `workers/process-queue/src/index.ts` | Bilingual summary + questions generation — upgraded prompts, needs redeploy |
| `workers/ingest-rss/src/index.ts` | RSS fetcher — deployed, working |
| `workers/embed-batch/src/index.ts` | Cohere embedding worker — deployed, running every 5 min |
| `supabase/functions/answer-question/index.ts` | Streaming answer — deployed; RAG update pending |
| `supabase/functions/refresh-questions/index.ts` | On-demand question refresh — deployed, working |
| `news-app/App.tsx` | Expo frontend — Phase 2.1 complete |
| `phase2.1-auto-questions-current-task.md` | Full Phase 2.1 spec |
| `instructions.md` | Command cheatsheet for all workers |
| `keep-in-mind.md` | Hard-won lessons — read before debugging anything |
| `docs/architecture.md` | All major technical decisions with rationale |
| `docs/api-keys-and-env.md` | Every secret and where it lives |

---

## What Comes After (Phase 3)

- iOS build via Expo EAS
- Vercel deployment for web
- UI design polish
- Additional RSS sources
- Push notifications for daily digest
