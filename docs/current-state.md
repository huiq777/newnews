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
| `ingest-rss` | ✅ Deployed | Every hour | Now fetches `source_type IN (rss, wechat, reddit)` — fixes WeChat and Reddit ingestion. Batch insert; ON CONFLICT DO NOTHING |
| ~~`process-queue`~~ | ❌ Deleted | — | Migrated to Supabase Edge Function (2026-04-21); CF Worker directory deleted 2026-04-23 |
| `ingest-builders` | ✅ Deployed | Daily 6am UTC | Reads feed-x.json (tweets) + feed-podcasts.json (episodes); bio extraction via Groq; metadata={likes,retweets}; **missing podcast source no longer kills arXiv/Reddit/etc** (early return → else branch) |
| `embed-batch` | ✅ Deployed | Every 5 min | Cohere embed-english-v3.0, 1024-dim; populates daily_news.embedding |
| `send-digest` | ✅ Deployed | Daily 00:30 UTC | **Trend-brief-only** delivery. Feishu (ZH) + optional Slack/Discord/Telegram (EN) + optional **WeCom (ZH)** + optional **Notion (EN, archival database row per day)**. Anchor date = `today_utc - 1` so the brief covers the just-closed UTC day. Per-channel-per-day idempotency via `digest_sent` (`ON CONFLICT DO NOTHING RETURNING`). Freshness gate on `trend_briefs.generated_at >= today 00:00 UTC`. Empty brief → `skipped_empty_brief`, no send. **Per-channel rendering** (Phase 8): Feishu `lark_md`, Slack `mrkdwn` (`**X**` → `*X*`), Discord stdlib MD, Telegram HTML mode (`<b>X</b>`), WeCom plain markdown (≤4096 bytes UTF-8 per chunk; sequential await), Notion structured-blocks via `markdownToBlocks()` (≤100 children per POST). Long briefs chunk at paragraph boundaries (Slack ≤ 2900/block, Discord ≤ 4000/embed, Telegram ≤ 3500/message, WeCom ≤ 3500 bytes/message; Telegram + WeCom chunks send sequentially to preserve order). |
| `ingest-x` | ❌ Deleted | — | Removed to free Cloudflare cron slot (5-trigger free tier limit); X API costs $100/mo |

### Supabase Edge Functions

| Function | Status | Notes |
|---|---|---|
| `answer-question` | ✅ Deployed | RAG active — Cohere query embed → match_articles RPC → top 3 related → Groq SSE streaming |
| `refresh-questions` | ✅ Deployed | On-demand question regeneration; no RAG dependency |
| `ingest-apify-tweets` | ✅ Deployed | Webhook receiver for Apify `RUN_SUCCEEDED`; `--no-verify-jwt` required |
| `generate-trend-brief` | ✅ Deployed | Cross-window trend synthesis (all categories); SSE streaming; `trend_briefs` 6h TTL cache; llama-3.3-70b-versatile; two-pass clustering; historical enrichment via match_articles RPC. **pg_cron pre-warm at 00:25 UTC** (`generate-trend-brief-daily`) via `pg_net.http_post`, 5 min before `send-digest`. |
| `process-queue` | ✅ Deployed | **1 LLM call per article (TokenRouter `qwen/qwen3.6-plus` primary 120s → OpenRouter secondary → Groq tertiary)**; atomic `claim_pending_batch` RPC; pre-LLM keyword gate for tweets; summary + QUESTIONS_EN + QUESTIONS_ZH combined; max_tokens 2000; `parseJsonSection` parser; triggered by pg_cron `*/5 * * * *` |
| `redeem-invite` | ✅ Deployed | Closed-beta auth gate (Round 1); `verify_jwt = true` (default); CORS allowlist includes `apikey, x-client-info`; atomic claim + idempotent recovery branch for network-partition retries; writes `app_metadata.is_beta_user` via service-role `auth.admin.updateUserById` |

### Supabase Tables & RPC

| Component | Status | Notes |
|---|---|---|
| `sources` | ✅ Live | 12 rows (rss + wechat + github_feed + podcast); source_type + metadata JSONB columns active |
| `raw_ingestion` | ✅ Live | State machine: pending → processing → done/error; metadata JSONB column active |
| `daily_news` | ✅ Live | article_content, questions JSONB, title_en/zh, summary_en/zh, embedding, engagement JSONB all populated |
| `match_articles` RPC | ✅ Live | pgvector cosine similarity; HNSW index; used by answer-question and generate-trend-brief |
| `raw_ingestion.metadata` JSONB | ✅ Live | Stores `{likes, retweets}` for builder tweets; NULL for RSS/WeChat |
| `daily_news.engagement` JSONB | ✅ Live | `{likes, retweets}` for tweets; NULL for RSS (HN source disabled); NULL for WeChat |
| `trend_briefs` | ✅ Live | TTL cache for Trend Brief synthesis; key: (anchor_date, step_days); 6h TTL; index on (anchor_date, step_days, expires_at); columns `synthesis_en` + `synthesis_zh` |
| `digest_sent` | ✅ Live | Per-channel per-day delivery accounting for `send-digest`. UNIQUE (channel, anchor_date) gives idempotent claim via `ON CONFLICT DO NOTHING RETURNING`. Statuses: `pending | sent | failed | skipped_empty_brief`. |
| `beta_invites` | ✅ Live | Round 1 closed-beta invite-link redemption table. RLS enabled with **no anon/authenticated policies** — only `redeem-invite` (service role) reads/writes. Columns: `code` PK, `display_name`, `default_lang`, `email` (nullable, reserved for Round 2 magic-link), `expires_at`, `used_at`, `user_id` FK to `auth.users` (`on delete set null`). Operator mints rows via Supabase SQL Editor. |
| `is_beta_user()` | ✅ Live | `security definer` SQL helper (returns boolean). Queries `beta_invites` for the current `auth.uid()`. One-line gate for future user-scoped table RLS: `using (is_beta_user() and user_id = auth.uid())`. |

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
- **Closed-beta auth gate** at app root ([news-app/lib/auth.ts](../news-app/lib/auth.ts), [news-app/components/BetaGateScreen.tsx](../news-app/components/BetaGateScreen.tsx)). Blocks every data effect in `App.tsx` until `app_metadata.is_beta_user === true`. Bilingual gate UI; default language carries over from invite metadata. Anonymous Supabase user under the hood — Round 2 will upgrade to email-bound via `updateUser({ email })` while preserving `auth.uid()`.

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
- **trend_briefs columns:** `id, anchor_date, step_days, synthesis_en, synthesis_zh, sources_json JSONB, model, tokens_used, generated_at, expires_at`
- **digest_sent columns:** `id, channel, anchor_date, status, last_error, created_at, updated_at` — UNIQUE (channel, anchor_date) for idempotent claim

---

## Key Technical Facts

- **LLM (summaries + questions):** OpenRouter primary (`OPENROUTER_MODEL` secret, swappable without redeploy) → Groq `llama-3.3-70b-versatile` fallback (AbortError/TCP/429 only)
- **LLM (bio extraction):** Groq `llama-3.3-70b-versatile` directly (ingest-builders; no OpenRouter)
- **LLM (answer streaming):** Groq `llama-3.3-70b-versatile` — only `type:content` SSE events (no reasoning)
- **Cohere model (embeddings):** `embed-english-v3.0` — 1024-dim; `input_type: search_document` at index time, `input_type: search_query` for RAG — asymmetry is load-bearing, do not change
- **process-queue LLM calls per article:** 1 (TokenRouter `qwen/qwen3.6-plus` primary 120s → OpenRouter secondary → Groq tertiary; summary + QUESTIONS_EN + QUESTIONS_ZH combined; `parseJsonSection` extracts JSON arrays)
- **process-queue tweet pre-filter:** keyword gate (EN regex + ZH substring) fires before LLM call — zero-cost NOT_AI_RELEVANT for tweets with no AI signal
- **ingest-builders Groq calls per run:** 1 batch call for all bios; subrequest count ~38/50 (tweets + podcasts)
- **ingest-builders podcast handling:** feed-podcasts.json schema `{podcasts:[{source,name,title,url,transcript}]}`; batch INSERT in one PostgREST call
- **Cloudflare cron limit:** 5 triggers (free tier hard limit) — **4/5 slots used**; ingest-x deleted to make room; process-queue migrated to Supabase Edge Function (pg_cron) freeing one slot
- **Stuck rows:** `UPDATE raw_ingestion SET status='pending' WHERE status='processing' AND processed_at IS NULL;`
- **send-digest:** Trend-brief-only delivery. Feishu (ZH `synthesis_zh`) + optional Slack / Discord / Telegram (EN `synthesis_en`) + optional WeCom (ZH `synthesis_zh`) + optional Notion (EN `synthesis_en`, one database row per day). Anchor date = `today_utc - 1`. Per-channel idempotency via `digest_sent`. CommonMark from the LLM is converted per-channel: Feishu `lark_md` passthrough, Slack `**X**`→`*X*`, Discord stdlib MD passthrough, Telegram `parse_mode: 'HTML'` with `<b>X</b>`, WeCom plain markdown passthrough, Notion structured-blocks via `markdownToBlocks()`. Long briefs chunk at `\n\n` boundaries; Telegram + WeCom chunks send sequentially.
- **answer-question SSE events:** `{ type: "content", content: "..." }` chunks then `data: [DONE]`
- **Streaming in Expo:** use `fetch` + `ReadableStream` with line buffer — do NOT use `supabase.functions.invoke()` (buffers entire response)
- **PostgREST join staleness:** always fetch sources separately and join client-side — do not use embedded joins

---

## Key Files

| File | Purpose |
|---|---|
| `workers/ingest-rss/src/index.ts` | RSS fetcher — every 4h |
| `supabase/functions/process-queue/index.ts` | Scrape + bilingual summarize + questions + engagement propagation (Edge Function; node-html-parser) |
| `workers/ingest-builders/src/index.ts` | feed-x.json (tweets) + feed-podcasts.json (podcasts) → raw_ingestion; bio extraction; engagement metadata |
| `workers/embed-batch/src/index.ts` | Cohere embeddings — every 5 min |
| `workers/send-digest/src/index.ts` | Daily digest — 00:30 UTC; Feishu (ZH) + optional Slack/Discord/Notion (EN); includes trend brief |
| `supabase/functions/answer-question/index.ts` | Streaming RAG answer — deployed with RAG |
| `supabase/functions/refresh-questions/index.ts` | On-demand question refresh |
| `news-app/App.tsx` | Expo frontend — Stage 3 redesign complete (warm editorial, MarkdownText, scroll fix) |
| `AI-SWE-skill.md` | Full technical reference — read before any code change |
| `keep-in-mind.md` | Hard-won lessons — read before debugging anything |
| `docs/architecture.md` | All major technical decisions with rationale |
| `docs/api-keys-and-env.md` | Every secret and where it lives |
