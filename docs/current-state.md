# Current State — 2026-04-18

This document is the single source of truth for where the project stands. Read this first in every new session before touching any code.

---

## What Phase We Are In

**Stages 2.5, 3, and Trend Brief (generate-trend-brief Edge Function) are complete. Stage 4 (web deployment) and Stage 4.5 (Apify tweet ingestion) are in progress. Stage 2 source quality audit is still pending — run once daily_news has 50+ articles.**

All Cloudflare Workers, Supabase Edge Functions, and RAG are live. The pipeline runs fully automatically. Frontend has been fully redesigned (warm editorial aesthetic, MarkdownText, answer Markdown rendering, scroll position fix).

---

## Deployed State of Every Component

### Cloudflare Workers

| Worker | Status | Schedule | Notes |
|---|---|---|---|
| `ingest-rss` | ✅ Deployed | Every 4 hours | Now fetches `source_type IN (rss, wechat, reddit)` — fixes WeChat and Reddit ingestion. Batch insert; ON CONFLICT DO NOTHING |
| `process-queue` | ✅ Deployed | Every 15 min | **1 LLM call per article (OpenRouter primary, Groq fallback)**; pre-LLM keyword gate for tweets (zero-cost NOT_AI_RELEVANT filter); summary + QUESTIONS_EN + QUESTIONS_ZH combined; max_tokens 2000; `parseJsonSection` parser |
| `ingest-builders` | ✅ Deployed | Daily 6am UTC | Reads feed-x.json (tweets) + feed-podcasts.json (episodes); bio extraction via Groq; metadata={likes,retweets}; **missing podcast source no longer kills arXiv/Reddit/etc** (early return → else branch) |
| `embed-batch` | ✅ Deployed | Every 5 min | Cohere embed-english-v3.0, 1024-dim; populates daily_news.embedding |
| `send-feishu-digest` | ✅ Deployed | Daily 17:00 UTC (12pm EST) | Queries daily_news last 24h; Chinese content; X - @handle - role format; all 3 ZH bullets; 🔥 likes badge for tweets only (HN badge disabled) |
| `ingest-x` | ❌ Deleted | — | Removed to free Cloudflare cron slot (5-trigger free tier limit); X API costs $100/mo |

### Supabase Edge Functions

| Function | Status | Notes |
|---|---|---|
| `answer-question` | ✅ Deployed | RAG active — Cohere query embed → match_articles RPC → top 3 related → Groq SSE streaming |
| `refresh-questions` | ✅ Deployed | On-demand question regeneration; no RAG dependency |
| `ingest-apify-tweets` | ✅ Deployed | Webhook receiver for Apify `RUN_SUCCEEDED`; `--no-verify-jwt` required |
| `generate-trend-brief` | ✅ Deployed | Cross-window trend synthesis (all categories); SSE streaming; `trend_briefs` 6h TTL cache; llama-3.3-70b-versatile; two-pass clustering; historical enrichment via match_articles RPC |

### Supabase Tables & RPC

| Component | Status | Notes |
|---|---|---|
| `sources` | ✅ Live | 12 rows (rss + wechat + github_feed + podcast); source_type + metadata JSONB columns active |
| `raw_ingestion` | ✅ Live | State machine: pending → processing → done/error; metadata JSONB column active |
| `daily_news` | ✅ Live | article_content, questions JSONB, title_en/zh, summary_en/zh, embedding, engagement JSONB all populated |
| `match_articles` RPC | ✅ Live | pgvector cosine similarity; HNSW index; used by answer-question and generate-trend-brief |
| `raw_ingestion.metadata` JSONB | ✅ Live | Stores `{likes, retweets}` for builder tweets; NULL for RSS/WeChat |
| `daily_news.engagement` JSONB | ✅ Live | `{likes, retweets}` for tweets; NULL for RSS (HN source disabled); NULL for WeChat |
| `trend_briefs` | ✅ Live | TTL cache for Trend Brief synthesis; key: (anchor_date, step_days); 6h TTL; index on (anchor_date, step_days, expires_at) |

### Expo Frontend (`news-app/App.tsx`)

**Stage 3 UI redesign complete.**

Working features:
- Warm editorial aesthetic: `#F7F6F2` background, `#1A1A1A` accent/pills, `#E0DDD6` borders
- `MarkdownText` component: renders `• **Label:** text` bullets with indent + bold inline
- Paginated feed (20/page, page number nav)
- EN/中 language toggle — bilingual titles + summaries; proportional scroll position preserved
- Source label: `公众号 - Founder Park` (WeChat) or `TechCrunch` (RSS)
- `? Questions` pill (top-right) — only shows when `questions` non-null; `↻` pill when null
- Questions expand/collapse; `↻` refresh regenerates via `refresh-questions`
- Click question → streams answer via `answer-question` SSE with RAG context
- Answer renders with Markdown (bullets + bold via `MarkdownText`); `▌` cursor; `Thinking...` while streaming
- `Read more →` is the only tap target that opens URL (card body tap disabled)
- SSE parsed with line buffer (handles split chunks)
- Engagement badges: 🔥 N likes (amber pill) for tweets only; K-suffix formatting via `fmtNum()`
- Upgraded summaries: 2-3 sentences per bullet; specific metrics required; no vague generalizations
- Empty state message when no articles loaded
- **`dateRange` now initializes eagerly to today** — no flash of all articles on first load
- **Auto-fallback to 3D when Today returns 0 articles** — `DrumWheelSidebar` exposes `switchTo(days)` control; App calls it automatically
- Title bracket-stripping rule added to both prompts — prevents `[Title]` formatting artifacts

---

## Active Next Steps

### Deploy Pending Workers ✅ COMPLETE (2026-04-15)

All three workers deployed: `ingest-rss`, `process-queue`, `ingest-builders`. Groq consolidation savings (34% per article, 51% per tweet) are now live in production.

Remaining follow-up if not yet done:
- Reset 429-errored rows so they reprocess with the improved token budget:
```sql
UPDATE raw_ingestion SET status = 'pending', retry_count = 0
WHERE status = 'error' AND last_error LIKE 'Groq 429%';
```
- Update Reddit sources to use RSS (bypasses Cloudflare IP block on Reddit JSON API):
```sql
UPDATE sources SET rss_url = 'https://www.reddit.com/r/MachineLearning.rss', source_type = 'rss' WHERE name = 'Reddit r/MachineLearning';
UPDATE sources SET rss_url = 'https://www.reddit.com/r/cscareerquestions.rss', source_type = 'rss' WHERE name = 'Reddit r/cscareerquestions';
UPDATE sources SET rss_url = 'https://www.reddit.com/r/layoffs.rss', source_type = 'rss' WHERE name = 'Reddit r/layoffs';
```

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

### Stage 2.5 — Podcast Ingestion ✅ COMPLETE

- `ingest-builders` now fetches both `feed-x.json` AND `feed-podcasts.json`
- Schema: `{podcasts:[{source,name,title,videoId,url,publishedAt,transcript}]}`
- Batch INSERT to `raw_ingestion`; `podcast` source_type; `process-queue` handles automatically
- Subrequest count: 36 → 38/50

### Stage 3 — UI Redesign ✅ COMPLETE

- Full warm editorial redesign (`#F7F6F2` bg, `#1A1A1A` pills, `#E0DDD6` borders)
- `MarkdownText` component for bullet+bold rendering in summaries and answers
- Answer Markdown rendering with streaming cursor
- `↻` pill when questions null; proportional scroll position on lang toggle
- Empty states; HN engagement badge removed (HN source disabled)

### Stage 4 — Web Deployment (Cloudflare Pages) ← ACTIVE

```bash
cd news-app
npx expo export --platform web          # outputs to dist/
npx wrangler pages deploy dist --project-name news-app
```

`EXPO_PUBLIC_*` vars are baked at build time — must be set in `.env.local` before building, or in Pages CI dashboard for GitHub integration.

### AI Relevance Filter Hardening ✅ COMPLETE (2026-04-18)

Pre-LLM keyword gate deployed in `process-queue`. Tweets with zero AI signal (EN word-boundary regex + ZH substring list) are filtered at zero token cost before any LLM call. Both tweet prompt constants updated: "content not sender" rule, @paulg concrete examples, FAILURE MODE tightened to explicit Chinese AI lab names. All four prompt constants updated (Change C).

### Stage 4.5 — Apify Tweet Ingestion ✅ COMPLETE

Edge Function `ingest-apify-tweets` deployed. Receives `RUN_SUCCEEDED` webhook from Apify, fetches dataset, batch-inserts to `raw_ingestion`. Downstream handled by existing `process-queue`.

### Stage 5 — Trend Brief ✅ COMPLETE

**Trend Brief feature is live.** `generate-trend-brief` Edge Function deployed; `trend_briefs` table live; `TrendBriefCard` in `App.tsx`; `embed-batch` already has recency sort.

**Note:** "Today" returns 204 (no articles) when zero articles have `created_at` in the UTC calendar day. This is correct — articles from the morning ET ingest land at Apr 1 UTC. Next UTC day's articles will populate Today correctly. Use 3D/7D to see the card in action.

### Stage 6 — iOS via Expo EAS

Packaging step only — do last. Requires Apple Developer account ($99/yr).

---

## Active RSS Sources

```
TechCrunch:    https://techcrunch.com/feed/                                           (rss)      ✅ active
The Verge:     https://www.theverge.com/rss/index.xml                                (rss)      ✅ active
Ars Technica:  https://feeds.arstechnica.com/arstechnica/index                       (rss)      ✅ active
Hacker News:   https://news.ycombinator.com/rss                                      (rss)      ❌ DISABLED (captures comment threads, not articles)
Founder Park:  https://wechat2rss.xlab.app/feed/e95ec80...xml                        (wechat)   ✅ active — fetched by ingest-rss
极客公园:       https://wechat2rss.xlab.app/feed/1a5aec9...xml                        (wechat)   ✅ active — fetched by ingest-rss
财联社:         https://wewe-rss-latest-oau3.onrender.com/feeds/...atom               (wechat)   ❌ DISABLED (empty raw_content)
中国新闻社:     https://wewe-rss-latest-oau3.onrender.com/feeds/...atom               (wechat)   ❌ DISABLED (empty raw_content)
36氪:          https://wewe-rss-latest-oau3.onrender.com/feeds/...atom               (wechat)   ❌ DISABLED (empty raw_content)
Reddit r/MachineLearning: https://www.reddit.com/r/MachineLearning.rss               (rss)      ✅ active (switched from JSON API to RSS)
Reddit r/cscareerquestions: https://www.reddit.com/r/cscareerquestions.rss           (rss)      ✅ active (switched from JSON API to RSS)
Reddit r/layoffs: https://www.reddit.com/r/layoffs.rss                               (rss)      ✅ active (switched from JSON API to RSS)
arXiv cs.AI:   https://export.arxiv.org/api/query?search_query=cat:cs.AI             (arxiv)    ✅ active — fetched by ingest-builders
arXiv cs.LG:   https://export.arxiv.org/api/query?search_query=cat:cs.LG             (arxiv)    ✅ active — fetched by ingest-builders
follow-builders: https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json (github_feed) ✅ active
follow-builders-podcasts: https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json (podcast) ✅ active
apify-tweets:  https://api.apify.com/v2/acts/...                                     (apify_tweet) ✅ active (webhook)
GitHub Trending: https://github.com/trending                                          (github_trending) ✅ active
Nowcoder Hot:  https://gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc            (nowcoder) ✅ active
Product Hunt:  https://api.producthunt.com/v2/api/graphql                            (producthunt) ✅ active (requires PRODUCTHUNT_API_TOKEN)
```

WeChat RSS bridges (wewe-rss, wechat2rss) return the RSS envelope but content quality varies. wechat2rss bridges (Founder Park, 极客公园) have real content. wewe-rss bridges (财联社, 中国新闻社, 36氪) return empty raw_content — disabled. Do not attempt to fix wewe-rss — RSS bridge is the ceiling.

---

## Supabase Info

- **Project URL:** `https://exjbwdcxyrkxsmzaowkx.supabase.co`
- **sources columns:** `id, name, rss_url (UNIQUE), is_active, created_at, source_type, metadata JSONB`
- **raw_ingestion columns:** `id, source_id, url (UNIQUE), raw_content, fetched_at, status, retry_count, last_error, processed_at, metadata JSONB`
- **daily_news columns:** `id, source_id, raw_ingestion_id, url (UNIQUE), title, summary, title_en, summary_en, title_zh, summary_zh, article_content, questions JSONB, embedding vector(1024), engagement JSONB, created_at`
- **trend_briefs columns (planned):** `id, anchor_date, step_days, synthesis, sources_json JSONB, model, tokens_used, generated_at, expires_at`

---

## Key Technical Facts

- **LLM (summaries + questions):** OpenRouter primary (`OPENROUTER_MODEL` secret, swappable without redeploy) → Groq `llama-3.3-70b-versatile` fallback (AbortError/TCP/429 only)
- **LLM (bio extraction):** Groq `llama-3.3-70b-versatile` directly (ingest-builders; no OpenRouter)
- **LLM (answer streaming):** Groq `llama-3.3-70b-versatile` — only `type:content` SSE events (no reasoning)
- **Cohere model (embeddings):** `embed-english-v3.0` — 1024-dim; `input_type: search_document` at index time, `input_type: search_query` for RAG — asymmetry is load-bearing, do not change
- **process-queue LLM calls per article:** 1 (OpenRouter/Groq; summary + QUESTIONS_EN + QUESTIONS_ZH combined; `parseJsonSection` extracts JSON arrays)
- **process-queue tweet pre-filter:** keyword gate (EN regex + ZH substring) fires before LLM call — zero-cost NOT_AI_RELEVANT for tweets with no AI signal
- **ingest-builders Groq calls per run:** 1 batch call for all bios; subrequest count ~38/50 (tweets + podcasts)
- **ingest-builders podcast handling:** feed-podcasts.json schema `{podcasts:[{source,name,title,url,transcript}]}`; batch INSERT in one PostgREST call
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
| `workers/process-queue/src/index.ts` | Scrape + bilingual summarize + questions + engagement propagation |
| `workers/ingest-builders/src/index.ts` | feed-x.json (tweets) + feed-podcasts.json (podcasts) → raw_ingestion; bio extraction; engagement metadata |
| `workers/embed-batch/src/index.ts` | Cohere embeddings — every 5 min |
| `workers/send-feishu-digest/src/index.ts` | Daily Feishu card — 17:00 UTC, Chinese |
| `supabase/functions/answer-question/index.ts` | Streaming RAG answer — deployed with RAG |
| `supabase/functions/refresh-questions/index.ts` | On-demand question refresh |
| `news-app/App.tsx` | Expo frontend — Stage 3 redesign complete (warm editorial, MarkdownText, scroll fix) |
| `AI-SWE-skill.md` | Full technical reference — read before any code change |
| `keep-in-mind.md` | Hard-won lessons — read before debugging anything |
| `docs/architecture.md` | All major technical decisions with rationale |
| `docs/api-keys-and-env.md` | Every secret and where it lives |
