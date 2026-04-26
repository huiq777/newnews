# News Project

An AI-powered bilingual (EN + ZH) news aggregator with daily Feishu digest and inline RAG Q&A. Everything runs on free tiers.

---

## System Architecture

```
Sources
  ├── RSS feeds (TechCrunch, Ars Technica, The Verge)
  ├── WeChat via wechat2rss bridge (Founder Park, GeekPark, 36氪, etc.)
  ├── Builder tweets via follow-builders/feed-x.json (GitHub, no X API cost)
  └── AI podcasts via follow-builders/feed-podcasts.json (YouTube transcripts)
          │
          ▼
  [ingest-rss]       hourly — RSS + Atom + WeChat + Reddit
  [ingest-builders]  daily 6am UTC — tweets + podcast episodes; bio extraction
          │
          ▼
    raw_ingestion  (Supabase, status=pending)
          │
          ▼
    [process-queue]  Supabase Edge Function, pg_cron */5 * * * *
    • scrape full article content (node-html-parser on Deno; 8s timeout)
    • bilingual summarize + 3 EN + 3 ZH questions in one combined LLM call
    • LLM routing: TokenRouter `qwen/qwen3.6-plus` (120s) → OpenRouter → Groq fallback
    • engagement metadata (tweet likes/retweets from raw_ingestion.metadata)
          │
          ▼
      daily_news  (bilingual titles + summaries + questions + engagement)
          │
          ▼
    [embed-batch]  every 5min
    • Cohere embed-english-v3.0, 1024-dim
          │
          ▼
    daily_news.embedding  (pgvector HNSW index)
          │
          ▼
    [answer-question]  Supabase Edge Function (on user tap)
    • Cohere query embed → match_articles RPC → top 3 related
    • Groq streaming SSE → inline answer on article card
          │
    [generate-trend-brief]  pg_cron 00:25 UTC
    • cross-window trend synthesis → trend_briefs (synthesis_en + synthesis_zh)
          │
          ▼
    [send-digest]  daily 00:30 UTC
    • today's trend brief → Feishu (ZH), Slack/Discord/Telegram (EN)
    • per-day per-channel idempotency via digest_sent
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Database | Supabase (PostgreSQL + pgvector) | RLS; REST API; HNSW cosine index |
| Ingestion | Cloudflare Workers (cron-triggered) + Supabase Edge Functions (pg_cron) | Free tier; secrets stay server-side; 50 subreq/invocation on CF |
| LLM (primary) | TokenRouter `qwen/qwen3.6-plus` | 120s timeout; summarization + questions in one call; model-flexible without redeploy |
| LLM (fallback) | OpenRouter → Groq `llama-3.3-70b-versatile` | AbortError / TCP / 429 fallback chain |
| Embeddings | Cohere `embed-english-v3.0` | 1024-dim; asymmetric input_type (search_document vs search_query) |
| Q&A | Supabase Edge Functions | `answer-question` (streaming RAG), `refresh-questions` (on-demand) |
| Frontend | React Native / Expo | Single-file `App.tsx`; warm editorial aesthetic; web-first |
| Delivery | Feishu / Slack / Discord / Telegram webhooks | Daily trend brief at 00:30 UTC (8:30 PM EDT); Feishu = ZH, others = EN |

---

## Data Pipeline

### 1. Ingestion
- `ingest-rss` (hourly): RSS + Atom + WeChat + Reddit → `raw_ingestion`
- `ingest-builders` (daily 6am UTC): builder tweets + podcast episodes → `raw_ingestion`; bio extraction via OpenRouter
- `ingest-apify-tweets` (Edge Function webhook): Apify `RUN_SUCCEEDED` → `raw_ingestion`

### 2. Processing (`process-queue` — Supabase Edge Function, pg_cron `*/5 * * * *`)
For each pending article (5 in parallel via atomic `claim_pending_batch` RPC):
- node-html-parser scraping (8s timeout; `stripHtml()` fallback)
- One combined LLM call → bilingual title + 3-bullet summary + 3 EN + 3 ZH questions
- LLM routing: TokenRouter `qwen/qwen3.6-plus` (primary, 120s) → OpenRouter → Groq `llama-3.3-70b-versatile`
- Pre-LLM AI keyword gate for tweets (token efficiency)
- Propagate engagement: tweet likes/retweets from `raw_ingestion.metadata`
- Insert into `daily_news`

### 3. Embedding (`embed-batch` — every 5 min)
- Up to 45 articles per run; prefers `article_content`; falls back to `summary`
- Cohere `embed-english-v3.0` batch call → `daily_news.embedding`

### 4. Q&A (`answer-question` Edge Function — on user tap)
- Cohere query embedding (`search_query`) → `match_articles` RPC → top 3 related
- Groq streaming SSE → inline answer rendered word-by-word on article card

---

## Project Structure

```
News Project/
├── AI-SWE-skill.md              ← Technical reference (read before any code change)
├── AI-PM-skill.md               ← Product strategy + roadmap
├── current-state.md             ← Live deployment status
├── keep-in-mind.md              ← Hard-won lessons
├── docs/
│   ├── architecture.md          ← Technical decisions + rationale
│   ├── schema.md                ← DB schema, indexes, RLS
│   ├── ingestion-pipeline.md    ← Worker-by-worker deployment guide
│   ├── edge-functions.md        ← answer-question + refresh-questions API
│   ├── api-keys-and-env.md      ← Every secret and where it lives
│   └── frontend.md              ← Expo setup + Cloudflare Pages deployment
├── workers/
│   ├── ingest-rss/              ← RSS/Atom ingestion
│   ├── ingest-builders/         ← Tweets + podcasts + bio extraction
│   ├── process-queue/           ← Scrape + summarize + questions + engagement
│   ├── embed-batch/             ← Cohere embeddings
│   └── send-digest/             ← Daily trend-brief delivery (Feishu/Slack/Discord/Telegram)
├── supabase/
│   └── functions/
│       ├── answer-question/     ← Streaming RAG Q&A
│       └── refresh-questions/   ← On-demand question regeneration
└── news-app/
    └── App.tsx                  ← Full frontend
```

---

## Key Design Decisions

Full rationale in [`docs/architecture.md`](docs/architecture.md). Summary:

- **Supabase over Firebase** — pgvector is native to PostgreSQL; no separate vector DB needed
- **Cloudflare Workers over Lambda** — free cron triggers; secrets stay server-side; TypeScript native
- **Decoupled queue** — `raw_ingestion` as buffer between fetching and summarization enables retry logic + audit trail
- **follow-builders for tweets** — reads public GitHub-hosted JSON feeds; zero X API cost; no scraping
- **Single `ingest-builders` worker for tweets + podcasts** — all 5 cron slots are in use; merging avoids needing a 6th
- **Polling for embeddings** — database triggers cause fan-out and rate limit spikes; a cron worker batches cleanly
- **Asymmetric Cohere input_type** — `search_document` at index time, `search_query` at retrieval time; swapping silently degrades recall
