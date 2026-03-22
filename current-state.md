# Current State — 2026-03-22

This document is the single source of truth for where the project stands. Read this first in every new session before touching any code.

---

## What Phase We Are In

**Stage 2 data accumulation in progress (DB wiped 2026-03-22 — run audit after 3+ days). Stage 2.5 (podcast ingestion) is the active implementation target.**

All Cloudflare Workers, Supabase Edge Functions, and RAG are live. The pipeline runs fully automatically. Current focus: extend ingest-builders for podcast ingestion while waiting for sufficient data to run the source quality audit.

---

## Deployed State of Every Component

### Cloudflare Workers

| Worker | Status | Schedule | Notes |
|---|---|---|---|
| `ingest-rss` | ✅ Deployed | Every 4 hours | RSS + Atom feeds; batch insert; ON CONFLICT DO NOTHING |
| `process-queue` | ✅ Deployed | Every 15 min | Groq llama-3.3-70b-versatile; bilingual summarize + questions; full article scraping; HN Algolia engagement enrichment; subrequest count ~41/50 |
| `ingest-builders` | ✅ Deployed | Daily 6am UTC | Reads follow-builders feed-x.json (GitHub); bio extraction via Groq; stores metadata={likes,retweets} in raw_ingestion; subrequest count ~36/50 |
| `embed-batch` | ✅ Deployed | Every 5 min | Cohere embed-english-v3.0, 1024-dim; populates daily_news.embedding |
| `send-feishu-digest` | ✅ Deployed | Daily 17:00 UTC (12pm EST) | Queries daily_news last 24h; Chinese content; X - @handle - role format; all 3 ZH bullets; engagement badge (🔥 likes or ▲ HN) |
| `ingest-x` | ❌ Deleted | — | Removed to free Cloudflare cron slot (5-trigger free tier limit); X API costs $100/mo |

### Supabase Edge Functions

| Function | Status | Notes |
|---|---|---|
| `answer-question` | ✅ Deployed | RAG active — Cohere query embed → match_articles RPC → top 3 related → Groq SSE streaming |
| `refresh-questions` | ✅ Deployed | On-demand question regeneration; no RAG dependency |

### Supabase Tables & RPC

| Component | Status | Notes |
|---|---|---|
| `sources` | ✅ Live | 11 rows (rss + wechat + github_feed); source_type + metadata JSONB columns active |
| `raw_ingestion` | ✅ Live | State machine: pending → processing → done/error; metadata JSONB column active |
| `daily_news` | ✅ Live | article_content, questions JSONB, title_en/zh, summary_en/zh, embedding, engagement JSONB all populated |
| `match_articles` RPC | ✅ Live | pgvector cosine similarity; HNSW index; used by answer-question |
| `raw_ingestion.metadata` JSONB | ✅ Live | Stores `{likes, retweets}` for builder tweets; NULL for RSS/WeChat |
| `daily_news.engagement` JSONB | ✅ Live | `{likes, retweets}` for tweets; `{hn_score, hn_comments}` for RSS; NULL for WeChat |

### Expo Frontend (`news-app/App.tsx`)

**Phase 2.2 UI complete.**

Working features:
- Paginated feed (20/page, page number nav)
- EN/中 language toggle — bilingual titles + summaries
- Source label: `公众号 - Founder Park` (WeChat) or `TechCrunch` (RSS)
- `? 3 Questions` pill (top-right) — only shows when `questions` non-null
- Questions expand/collapse; `↻` refresh regenerates via `refresh-questions`
- Click question → streams answer via `answer-question` SSE with RAG context
- Answer renders word-by-word with `▌` cursor; `Thinking...` indicator while streaming
- Language toggle resets open answers
- `Read more →` is the only tap target that opens URL (card body tap disabled)
- SSE parsed with line buffer (handles split chunks)
- Engagement badges: 🔥 N likes (amber pill) for tweets, ▲ N HN score (yellow pill) for RSS; K-suffix formatting via `fmtNum()`
- Upgraded summaries: 2-3 sentences per bullet; specific metrics required; no vague generalizations

---

## Active Next Steps

### Stage 2 — Source Quality Audit ⏳ Pending (run after 2026-03-25)

DB wiped 2026-03-22. Run audit SQL once `daily_news` has 50+ articles across sources (3+ days of ingest).

```sql
SELECT
  s.name,
  s.source_type,
  COUNT(dn.id) AS articles,
  ROUND(AVG(length(dn.article_content))) AS avg_scraped_chars,
  ROUND(AVG(length(dn.summary_en))) AS avg_summary_chars,
  COUNT(dn.id) FILTER (WHERE dn.article_content IS NULL) AS scrape_failures
FROM daily_news dn
JOIN sources s ON s.id = dn.source_id
GROUP BY s.name, s.source_type
ORDER BY avg_scraped_chars DESC NULLS LAST;
```

Per-source strategy:
- **RSS** (TechCrunch, Ars, Verge): `avg_scraped_chars` + `scrape_failures` → keep or disable
- **Hacker News**: disable regardless — scraper captures comment threads, not article text (structural, not quality)
- **WeChat**: `avg_summary_chars` only; disable sources with empty `raw_content`
- **Builder tweets**: no audit — KOL curation is the quality filter

### Stage 2.5 — Podcast Ingestion (feed-podcasts.json) ← next code task

Inspect schema first, then extend `ingest-builders`:
```bash
curl https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json | head -c 2000
```
See `AI-SWE-skill.md` Stage 2.5 for full implementation steps. Watch subrequest count (~36/50 today).

### Stage 3 — UI Polish (after Stage 2)

Use `superpowers:brainstorming` then `frontend-design` skill before touching any code.
File: `news-app/App.tsx`

Known pain points:
1. Answer Markdown rendering — streams as plain text; bold/bullets should render (most impactful)
2. Article card visual hierarchy — functional but sparse
3. Source filter pills — no way to filter by source
4. Language toggle UX — resets open answers; consider persisting
5. Empty states — no articles/no questions shows blank

### Stage 4 — Web Deployment (Cloudflare Pages)

```bash
cd news-app
npx expo export --platform web          # outputs to dist/
npx wrangler pages deploy dist --project-name news-app
```

`EXPO_PUBLIC_*` vars are baked at build time — must be set in `.env.local` before building, or in Pages CI dashboard for GitHub integration.

### Stage 5 — iOS via Expo EAS

Packaging step only — do last. Requires Apple Developer account ($99/yr).

---

## Active RSS Sources

```
TechCrunch:    https://techcrunch.com/feed/                                           (rss)
The Verge:     https://www.theverge.com/rss/index.xml                                (rss)
Ars Technica:  https://feeds.arstechnica.com/arstechnica/index                       (rss)
Hacker News:   https://news.ycombinator.com/rss                                      (rss)
Founder Park:  https://wechat2rss.xlab.app/feed/e95ec80...xml                        (wechat)
GeekPark:      https://wechat2rss.xlab.app/feed/1a5aec9...xml                        (wechat)
财联社:         https://wewe-rss-latest-oau3.onrender.com/feeds/...atom               (wechat)
中国新闻社:     https://wewe-rss-latest-oau3.onrender.com/feeds/...atom               (wechat)
36氪:          https://wewe-rss-latest-oau3.onrender.com/feeds/...atom               (wechat)
follow-builders: https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json (github_feed)
```

WeChat scraping will always fail — RSS bridge content is the ceiling. Do not attempt to fix this.

---

## Supabase Info

- **Project URL:** `https://exjbwdcxyrkxsmzaowkx.supabase.co`
- **sources columns:** `id, name, rss_url (UNIQUE), is_active, created_at, source_type, metadata JSONB`
- **raw_ingestion columns:** `id, source_id, url (UNIQUE), raw_content, fetched_at, status, retry_count, last_error, processed_at, metadata JSONB`
- **daily_news columns:** `id, source_id, raw_ingestion_id, url (UNIQUE), title, summary, title_en, summary_en, title_zh, summary_zh, article_content, questions JSONB, embedding vector(1024), engagement JSONB, created_at`

---

## Key Technical Facts

- **Groq model (summaries + questions + bio extraction):** `llama-3.3-70b-versatile` — 12K TPM free tier
- **Groq model (answer streaming):** `llama-3.3-70b-versatile` — only `type:content` SSE events (no reasoning)
- **Cohere model (embeddings):** `embed-english-v3.0` — 1024-dim; `input_type: search_document` at index time, `input_type: search_query` for RAG — asymmetry is load-bearing, do not change
- **process-queue Groq calls per article:** 3 (summary + EN questions + ZH questions)
- **ingest-builders Groq calls per run:** 1 batch call for all bios
- **Cloudflare cron limit:** 5 triggers (free tier hard limit) — all 5 slots used; ingest-x deleted to make room
- **Stuck rows:** `UPDATE raw_ingestion SET status='pending' WHERE status='processing' AND processed_at IS NULL;`
- **Feishu digest:** Chinese content (title_zh, summary_zh); X articles show as `X - @handle - role` using bio_map from sources.metadata
- **answer-question SSE events:** `{ type: "content", content: "..." }` chunks then `data: [DONE]`
- **Streaming in Expo:** use `fetch` + `ReadableStream` with line buffer — do NOT use `supabase.functions.invoke()` (buffers entire response)
- **PostgREST join staleness:** always fetch sources separately and join client-side — do not use embedded joins

---

## Key Files

| File | Purpose |
|---|---|
| `workers/ingest-rss/src/index.ts` | RSS fetcher — every 4h |
| `workers/process-queue/src/index.ts` | Scrape + bilingual summarize + questions + HN engagement enrichment |
| `workers/ingest-builders/src/index.ts` | follow-builders feed-x.json → raw_ingestion + bio extraction + engagement metadata |
| `workers/embed-batch/src/index.ts` | Cohere embeddings — every 5 min |
| `workers/send-feishu-digest/src/index.ts` | Daily Feishu card — 17:00 UTC, Chinese |
| `supabase/functions/answer-question/index.ts` | Streaming RAG answer — deployed with RAG |
| `supabase/functions/refresh-questions/index.ts` | On-demand question refresh |
| `news-app/App.tsx` | Expo frontend — Phase 2.2 complete |
| `AI-SWE-skill.md` | Full technical reference — read before any code change |
| `keep-in-mind.md` | Hard-won lessons — read before debugging anything |
| `docs/architecture.md` | All major technical decisions with rationale |
| `docs/api-keys-and-env.md` | Every secret and where it lives |
