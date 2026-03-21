# News Aggregator

An AI-powered news aggregator that ingests articles from English tech media and Chinese WeChat public accounts, summarizes them with LLMs, and surfaces them through a mobile-first feed with two AI chatbots — one for general questions, one for reasoning over your stored news.

Everything runs on free tiers.

---

## System Architecture

```
Sources
  ├── RSS feeds (TechCrunch, Ars Technica, HN, Founder Park, GeekPark, WeChat via wechat2rss)
  └── X/Twitter accounts (requires X API Basic — disabled in free MVP)
          │
          ▼
  [ingest-rss]  ──────────────────────────────┐
  [ingest-x]    (Cloudflare Workers, cron)     │
                                               ▼
                                       raw_ingestion
                                       (Supabase, status=pending)
                                               │
                                               ▼
                                       [process-queue]
                                       (every 15 min)
                                       • strips HTML
                                       • fetchPageTitle
                                       • Groq: 3-bullet summary
                                               │
                                               ▼
                                         daily_news
                                       (title + summary + url)
                                               │
                                               ▼
                                       [embed-batch]
                                       (every 5 min)
                                       • Cohere embed-english-v3.0
                                       • 1024-dim vectors
                                               │
                                               ▼
                                      article_embeddings
                                       (pgvector in Supabase)
                                               │
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                        [chat-live]                       [chat-rag]
                    Groq Llama 3.3 70B             Cohere embed → pgvector
                    General assistant              → DeepSeek-R1 distill
                    SSE stream                     Thinking + answer stream
                              │                                 │
                              └────────────────┬────────────────┘
                                               ▼
                                         Expo App
                                   (news feed + dual chatbots)
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Database | Supabase (PostgreSQL + pgvector) | Auth, RLS, vector search, REST API — one system |
| Ingestion | Cloudflare Workers (`ingest-rss`, `ingest-x`) | Cron-triggered, secrets stay server-side |
| Processing | Cloudflare Worker (`process-queue`) | Groq summarization, HTML stripping, title extraction |
| Embeddings | Cloudflare Worker (`embed-batch`) | Cohere batch API, 45 articles per invocation |
| Chatbots | Supabase Edge Functions (`chat-live`, `chat-rag`) | Deno runtime, SSE streaming |
| Summarization | Groq — `llama-3.3-70b-versatile` | Free tier, fast enough for cron batches |
| RAG reasoning | Groq — `deepseek-r1-distill-llama-70b` | Exposes `reasoning_content` field |
| Embeddings model | Cohere `embed-english-v3.0` | 1024-dim, asymmetric input types |
| Frontend | React Native / Expo | Paginated feed, click-through to source, chat tabs |

---

## Data Pipeline

### 1. Ingestion (`ingest-rss` — daily at 7am UTC)
Fetches configured RSS and Atom feeds. Batch-inserts all items into `raw_ingestion` in a single Supabase POST (`ON CONFLICT DO NOTHING` on URL). Stays well under Cloudflare's 50-subrequest free-tier limit.

WeChat sources use [wechat2rss.xlab.app](https://wechat2rss.xlab.app) as an RSS bridge — no WeChat credentials required.

### 2. Processing (`process-queue` — every 15 min)
Picks up 5 `pending` articles per run. For each:
- Marks `status=processing` (pessimistic lock, prevents double-processing)
- Strips HTML tags and encoded entities from raw content
- Fetches real `<title>` from the article URL (skips X/Twitter — no login)
- If content < 300 chars: stores directly; if longer: calls Groq for 3-bullet summary
- Writes to `daily_news`; on failure increments `retry_count` (max 3 retries before `status=error`)

### 3. Embedding (`embed-batch` — every 5 min)
Finds up to 45 `daily_news` articles with no embedding. Sends all to Cohere in a single batch call (`input_type=search_document`). Upserts 1024-dim vectors into `article_embeddings`.

---

## Chatbots

### chat-live — General Assistant
`POST /functions/v1/chat-live` → SSE stream

Forwards user prompt to Groq Llama 3.3 70B. No retrieval. Suitable for general AI questions. Streams using native `fetch` + `ReadableStream` (not `supabase.functions.invoke`, which buffers).

### chat-rag — News-Grounded Reasoning
`POST /functions/v1/chat-rag` → SSE stream (`type: "thinking"` + `type: "content"`)

1. Verifies Supabase JWT
2. Embeds user question with Cohere (`input_type=search_query`)
3. pgvector cosine similarity search against `article_embeddings`
4. Injects top-k articles as context into DeepSeek-R1 prompt
5. Streams reasoning trace and final answer separately

---

## Free Tier Usage

| Service | Free Limit | Estimated Usage |
|---|---|---|
| Supabase | 500MB database | <50MB |
| Cloudflare Workers | 100K requests/day | ~300/day |
| Groq | Rate-limited (12K TPM) | ~50–100 calls/day |
| Cohere | 1K calls/month trial | ~30/month |
| Render.com | 1 free web service | WeWe RSS instance |
| wechat2rss.xlab.app | Public free service | WeChat RSS bridge |

---

## Project Structure

```
News Project/
├── docs/
│   ├── architecture.md       # All major technical decisions with rationale
│   ├── schema.md             # Database schema
│   ├── ingestion-pipeline.md # Ingestion worker detail
│   ├── edge-functions.md     # chat-live and chat-rag full spec
│   └── api-keys-and-env.md   # Every secret, where it lives, why
├── workers/
│   ├── ingest-rss/           # RSS + Atom feed fetcher
│   ├── ingest-x/             # X API user timeline fetcher
│   ├── process-queue/        # Groq summarization worker
│   └── embed-batch/          # Cohere embedding worker
├── supabase/
│   └── functions/
│       ├── chat-live/        # General chatbot Edge Function
│       └── chat-rag/         # RAG chatbot Edge Function
├── news-app/                 # Expo React Native app
├── keep-in-mind.md           # Operational gotchas and recovery SQL
└── README.md
```

---

## Setup

### Prerequisites
- Supabase project (free tier)
- Cloudflare account (free tier)
- Groq API key (free at console.groq.com)
- Cohere API key (free trial at dashboard.cohere.com)

### 1. Database
Run the migration SQL in Supabase SQL Editor (see `docs/schema.md`). Enable pgvector extension.

### 2. Cloudflare Workers
```bash
cd workers/<worker-name>
npm install
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# worker-specific keys:
wrangler secret put GROQ_API_KEY       # process-queue
wrangler secret put COHERE_API_KEY     # embed-batch
wrangler secret put X_BEARER_TOKEN    # ingest-x
wrangler deploy
```

### 3. Supabase Edge Functions
```bash
supabase functions deploy chat-live
supabase functions deploy chat-rag
```
Add `GROQ_API_KEY` and `COHERE_API_KEY` in Supabase Dashboard → Edge Functions → Manage Secrets.

### 4. Expo App
```bash
cd news-app
cp .env.local.example .env.local   # fill in EXPO_PUBLIC_SUPABASE_URL + ANON_KEY
npm install
npx expo start
```

---

## Key Design Decisions

Full rationale in [`docs/architecture.md`](docs/architecture.md). Summary:

- **Supabase over Firebase** — pgvector is native to PostgreSQL; no separate vector DB needed
- **Cloudflare Workers over Lambda** — free cron triggers, secrets stay server-side, TypeScript native, 50 subrequest/invocation limit shapes batch sizes
- **Groq over OpenAI** — free tier sufficient for batch summarization at this scale; same upgrade path (swap base URL + model)
- **Decoupled queue** — `raw_ingestion` as a buffer between fetching and summarization enables retry logic, audit trail, and independent scaling
- **Polling for embeddings** — database triggers cause fan-out and rate limit spikes; a cron worker batches cleanly
- **Asymmetric Cohere input_type** — `search_document` at index time, `search_query` at retrieval time; swapping these silently degrades recall

---

## Upgrade Paths

| Component | Current (Free) | Paid Upgrade |
|---|---|---|
| X ingestion | Disabled (402 — credits depleted) | X API Basic ($100/mo) |
| chat-live web search | None | Perplexity Sonar ($5/mo) or Tavily (1K/mo free) |
| chat-rag reasoning | Groq DeepSeek-R1 distill | DeepSeek API direct (~$0.55/1M tokens) |
| Cohere embeddings | 90-day trial | Pay-as-you-go (~negligible at this scale) |

Each upgrade is a one-line change (base URL + model constant) per component.
