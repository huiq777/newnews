# News Project

A daily-refreshed news aggregator with two AI chatbots: one that searches the live web, and one that reasons over your curated news feed using RAG.

Built web-first with React Native (Expo), designed to compile to iOS in a future phase.

---

## Tech Stack

| Tool | Role |
|---|---|
| **Supabase** | PostgreSQL database, Auth (email/password), pgvector for embeddings, Edge Functions for AI proxying |
| **Cloudflare Workers** | All automation — RSS ingestion, X API ingestion, Groq summarization, Cohere embedding. Free cron triggers, TypeScript runtime, holds all backend API secrets via `wrangler secret`. |
| **Groq (Llama 3 70B)** | Summarizes raw article text into 3 bullet points during ingestion |
| **Cohere embed-english-v3.0** | Generates 1024-dimension embeddings for articles and user queries |
| **Groq llama-3.3-70b-versatile** | Powers Chatbot 1 — general AI assistant (MVP, free tier) |
| **Groq deepseek-r1-distill-llama-70b** | Powers Chatbot 2 — contextual reasoning over the stored news feed (RAG, MVP, free tier) |
| **React Native + Expo** | Frontend — web-first, iOS later |
| **Expo Router** | File-based navigation for web-compatible routing |
| **Vercel** | Hosts the Expo web build |

---

## Directory Structure

```
News Project/
├── project-structure.md        ← You are here. Start here.
├── docs/
│   ├── architecture.md         ← All technical decisions and rationale
│   ├── schema.md               ← PostgreSQL schema, indexes, and RLS policies
│   ├── ingestion-pipeline.md   ← Cloudflare Workers specifications (4 workers)
│   ├── edge-functions.md       ← Supabase Edge Function API contracts
│   ├── api-keys-and-env.md     ← Every secret and exactly where it lives
│   └── frontend.md             ← Expo setup, screen specs, streaming, deploy
├── workers/
│   ├── ingest-rss/             ← Cloudflare Worker: daily RSS fetch → raw_ingestion
│   ├── ingest-x/               ← Cloudflare Worker: hourly X API fetch → raw_ingestion
│   ├── process-queue/          ← Cloudflare Worker: Groq summarization every 15 min
│   └── embed-batch/            ← Cloudflare Worker: Cohere embeddings every 5 min
├── supabase/
│   └── functions/
│       ├── chat-live/          ← Edge Function: Groq general assistant (Chatbot 1)
│       └── chat-rag/           ← Edge Function: Groq RAG chatbot (Chatbot 2)
└── app/                        ← Expo Router app directory
    ├── (auth)/
    │   └── login.tsx
    └── (app)/
        ├── feed.tsx
        └── chat.tsx
```

---

## Start Here

Follow this sequence to get the project running:

1. **Supabase** — Create a project, run the migration from [docs/schema.md](docs/schema.md), enable Auth
2. **Cloudflare Workers** — Install Wrangler CLI, deploy the 3 workers from [docs/ingestion-pipeline.md](docs/ingestion-pipeline.md), add secrets via `wrangler secret put`
3. **Supabase Edge Functions** — Deploy `chat-live` and `chat-rag` using the contracts in [docs/edge-functions.md](docs/edge-functions.md), add secrets
4. **Expo** — Install dependencies, configure env vars per [docs/api-keys-and-env.md](docs/api-keys-and-env.md), run locally
5. **Vercel** — Build and deploy the web output per [docs/frontend.md](docs/frontend.md)

---

## Documentation Index

| File | What it answers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Why each tool was chosen; all key design decisions with rationale |
| [docs/schema.md](docs/schema.md) | The exact SQL to run; what each table does; RLS and index strategy |
| [docs/ingestion-pipeline.md](docs/ingestion-pipeline.md) | How Cloudflare Workers fetches, processes, and embeds articles (3 workers) |
| [docs/edge-functions.md](docs/edge-functions.md) | Request/response contracts for both AI chatbot endpoints |
| [docs/api-keys-and-env.md](docs/api-keys-and-env.md) | Every API key, where to get it, and where it must be configured |
| [docs/frontend.md](docs/frontend.md) | Expo project setup, screen inventory, streaming implementation, deploy |

---

## Descoped in v1

These features were considered and explicitly cut to reduce risk and complexity:

- **X/Twitter scraping** — Direct scraping via Puppeteer violates X ToS. Instead, `workers/ingest-x/` uses the official X API v2 free tier to pull posts from specific accounts via the user timeline endpoint. Free tier limit: 500K tweet reads/month.
- **Row-level trigger for embeddings** — Firing an Edge Function on every `INSERT` into `daily_news` creates a fan-out spike that hits rate limits immediately under batch ingestion. Embeddings are handled by a polling Cloudflare Worker instead.
- **n8n** — Has no permanently free cloud tier. Replaced by Cloudflare Workers, which provides free cron-triggered TypeScript execution with 100,000 requests/day on the free tier.
- **iOS build** — The Expo project is configured for web only in v1. React Native for Web covers all required UI primitives. iOS compilation is a Phase 2 concern.
