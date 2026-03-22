# AI SWE Skill — News Project

> Read this at the start of any session before touching code.
> This is the technical counterpart to AI-PM-skill.md (product strategy).
> Update after any significant architectural change.

---

## Role Definition

When operating as AI SWE on this project:
- Think at FAANG engineer level: correctness first, then performance, then elegance
- Fix root causes, not symptoms — no workarounds over real fixes
- Validate before claiming done: use `superpowers:verification-before-completion`
- Debug systematically: use `superpowers:systematic-debugging` before guessing
- Look up library APIs with `context7` before writing code from memory
- Use `superpowers:brainstorming` before designing any non-trivial feature
- Use `superpowers:writing-plans` for multi-step implementation work

---

## Stack Overview

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Expo (React Native) + TypeScript | Web-first; iOS via EAS is Phase 3 |
| Ingestion | Cloudflare Workers (cron-triggered) | Free tier; 30s wall-clock hard limit |
| LLM | Groq `llama-3.3-70b-versatile` | Free tier: 12K TPM, **100K TPD** |
| Embeddings | Cohere `embed-english-v3.0` | 1024-dim; 512 tokens ≈ 2000 chars max |
| Vector DB | Supabase pgvector (HNSW index) | Cosine distance via `<=>` operator |
| DB | Supabase PostgreSQL | PostgREST REST API; RLS enforced |
| Auth (Workers) | Service role key | Never expose to frontend |
| Auth (Frontend) | Anon key + RLS | Public read on `daily_news` and `sources` |

---

## Current Implementation State (as of 2026-03-21)

| Component | Status | Notes |
|-----------|--------|-------|
| RSS ingestion | ✅ Live | Every 4h (`0 */4 * * *`); 10 sources |
| Full article scraping | ✅ Live | HTMLRewriter in process-queue; 8s timeout; paywall fallback |
| LLM summarization | ✅ Live | Groq llama-3.3-70b-versatile; bilingual EN+ZH |
| Question generation | ✅ Live | 3 EN + 3 ZH per article; all-or-nothing |
| Cohere embeddings | ✅ Live | embed-batch; 2000-char input; article_content preferred |
| RAG Q&A | ✅ Live | match_articles RPC; top 3 related; Groq streaming SSE |
| article_content column | ✅ Live | daily_news.article_content TEXT; NULL for WeChat (bridge handles) |
| match_articles RPC | ✅ Live | pgvector cosine similarity; HNSW index active |
| `ingest-builders` worker | ✅ Live | Daily 6am UTC; 32 builder tweets from follow-builders feed-x.json; GROQ_API_KEY required |
| `send-feishu-digest` worker | ✅ Live | Daily 12pm EST (17:00 UTC); Chinese (summary_zh + title_zh); `X - @handle - role` format |
| AI bio extraction | ✅ Live | Batch Groq call in ingest-builders; verbatim role extraction; cached in sources.metadata |
| `sources.metadata` JSONB | ✅ Live | Stores `bio_map: {handle: "role"}` — shared by Feishu + App.tsx |
| `ingest-x` worker | ❌ Deleted | Removed to free Cloudflare cron slot (5-trigger free tier limit hit) |
| Engagement data pipeline | ✅ Live | `raw_ingestion.metadata JSONB` + `daily_news.engagement JSONB`; tweets: `{likes, retweets}`; RSS: `{hn_score, hn_comments}` via HN Algolia API |
| Upgraded summary prompt | ✅ Live | 2-3 sentences per bullet; specific metrics required; no vague generalizations |
| Engagement UI badges | ✅ Live | App.tsx: 🔥 N likes (amber pill) or ▲ N HN (yellow pill); `fmtNum()` K-suffix formatting |
| Feishu all 3 ZH bullets | ✅ Live | Was showing 2 bullets; now all 3 from summary_zh |
| Web deployment | ❌ Dev only | Cloudflare Pages deployment is Stage 4 |
| iOS build | ❌ Not started | Expo EAS is Stage 5 |

---

## Pipeline Control Flow

```
Daily @ 7am UTC
ingest-rss Worker
  → fetch all RSS feeds in parallel (Promise.all)
  → extract <link> + <description>/<content:encoded>/<summary> from each item
  → INSERT INTO raw_ingestion (status='pending') ON CONFLICT url DO NOTHING

Every 15 min
process-queue Worker
  → SELECT 5 pending rows from raw_ingestion
  → PATCH all 5 to status='processing' (pessimistic lock)
  → Promise.all(5x processArticle):
      1. fetchArticleContent(url) → HTMLRewriter (8s AbortController timeout)
         fallback: stripHtml(raw_content) if scraped < 500 chars
      2. Determine engagement:
         - x.com/status URL → read article.metadata → {likes, retweets}
         - other URLs → fetchHNEngagement() via HN Algolia API → {hn_score, hn_comments} or null
      3. POST to Groq → bilingual title + 3-bullet summary (2-3 sentences/bullet; specific metrics required)
      4. POST to Groq ×2 parallel → 3 EN + 3 ZH questions
      5. INSERT INTO daily_news (article_content, summaries, questions, engagement)
      6. PATCH daily_news.article_content for existing URLs (duplicate URL = silent no-op on INSERT)
      7. PATCH raw_ingestion status='done'
  → error: increment retry_count; status='error' after 3 failures (no backoff)
  (subrequest count: ~41/50 — monitor; approaching limit)

Daily @ 6am UTC
ingest-builders Worker (requires GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  → GET sources WHERE source_type='github_feed' → get source.id
  → fetch feed-x.json from GitHub (public, no auth)
  → extractAccounts(rawData) → [{handle, bio, tweets:[]}]  (reads data.x array)
  → ONE batch Groq call: extractBioMap() — all bios in one prompt
      system prompt: verbatim extraction; people = role @ company; products = "Name is X @Co"
      response: flat JSON {"handle": "role"} — JSONL fallback parser handles both formats
  → PATCH sources.metadata = {bio_map: {...}} for source.id
  → flatMap(accounts → tweets) → filter valid (id + text + url)
  → INSERT raw_ingestion (url=tweet.url, raw_content="@handle: tweet text",
      metadata={likes, retweets}) ON CONFLICT DO NOTHING
  (subrequest count: ~36/50 — do NOT add per-tweet batch ops or limit will be exceeded)

Every 5 min
embed-batch Worker
  → SELECT 45 articles WHERE embedding IS NULL
  → POST to Cohere batch (input_type='search_document', 2000-char input)
  → prefer article_content; fall back to summary
  → PATCH daily_news.embedding for each article

Daily @ 12pm EST (17:00 UTC)
send-feishu-digest Worker (requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FEISHU_WEBHOOK_URL)
  → Promise.all: fetch daily_news (last 24h, limit 10, select includes summary_zh/title_zh)
                + fetch sources (select id, name, metadata)
  → build sourceMap + bioMap from sources.metadata.bio_map
  → buildFeishuCard(): msg_type="interactive", header template="blue", content in Chinese
    → per article:
        xHandle = url.match(/x\.com\/([^/]+)\/status\//)
        sourceName = xHandle ? "X - @handle - role" : sourceMap[source_id]
        title = title_zh || title_en
        bullets = all 3 bullets from summary_zh
        engagement badge = "🔥 N likes" (tweets) or "▲ N HN" (RSS) if engagement exists
  → POST to FEISHU_WEBHOOK_URL
  → always sends (even if 0 articles — sends "No articles today")

On user question (Supabase Edge Function)
answer-question
  → GET article from daily_news (title, summary_en/zh, article_content)
  → use article_content if available, else summary (fallback)
  → POST question to Cohere (input_type='search_query')  ← ASYMMETRIC — do not change
  → RPC match_articles(query_embedding, match_count=4) → top 3 related (excluding primary)
  → POST to Groq streaming with full context + related articles
  → SSE stream: { type: 'content', content: string } chunks + data: [DONE]
```

---

## Source Behavior by Type

| Source | Scraping | Raw Content | Notes |
|--------|----------|-------------|-------|
| TechCrunch, Ars Technica, The Verge | ✅ Scrapes well | RSS snippet ~200-500 chars | Full prose 3000-15000 chars |
| Hacker News | ⚠️ Scrapes HN page, not linked article | RSS discussion text ~6000 chars | HN = link aggregator; no article body |
| Founder Park (wechat2rss) | ❌ WeChat blocks fetch | Bridge HTML ~23K raw → ~2600 stripped | stripHtml() gives usable Chinese text |
| 极客公园 (wechat2rss) | ❌ WeChat blocks fetch | Bridge HTML ~42K raw → ~6000 stripped | Better bridge extraction |
| Short WeChat URLs (mp.weixin.qq.com/s/...) | ❌ Blocked | Sometimes empty raw_content | SKIP (empty) — expected behavior |
| follow-builders (github_feed) | ❌ Not attempted | Tweet text ~280 chars via `@handle: text` | Groq summarizes tweet directly; quality lower than articles; bio extracted separately |

WeChat scraping will always fail. RSS bridge content after `stripHtml()` is the ceiling. Do not attempt to fix this — it is by design.

---

## Groq Rate Limits (Free Tier)

| Limit | Value | Impact |
|-------|-------|--------|
| TPM (tokens per minute) | 12,000 | Hit during parallel processing; retry after 1 min |
| TPD (tokens per day) | **100,000** | Hit when batch-reprocessing all articles; stops the pipeline |
| Tokens per article | ~1500–2500 | 1 summary call + 2 question calls |
| Max articles/day | ~40–65 | At 1500-2500 tokens per article |

**When you hit 429 TPD:** Stop processing immediately. Retrying burns retry_count. The limit resets at midnight UTC. Failed articles will be automatically retried next day via the 15-min scheduler.

Do not bulk-reprocess articles during the same day — spread reprocessing across multiple days.

---

## Critical Technical Gotchas

### 1. HTMLRewriter is streaming, not a query engine
- One pass over the document — you cannot "try selector A, fall back to B"
- `.remove()` MUST go in the `element` handler, not `text`
- Must consume output: `await rewriter.transform(res).text()` — or nothing runs
- Cannot inspect removed elements after removal

### 2. Cohere `input_type` asymmetry is load-bearing
- Indexing: `input_type: 'search_document'` (embed-batch)
- Querying: `input_type: 'search_query'` (answer-question)
- Using the same type for both silently degrades retrieval — never "fix" this

### 3. pgvector HNSW index requires raw `<=>` in ORDER BY
```sql
ORDER BY embedding <=> query_embedding        -- CORRECT: uses HNSW index
ORDER BY 1 - (embedding <=> query_embedding)  -- WRONG: sequential scan
ORDER BY score DESC                           -- WRONG: sequential scan
```

### 4. Cloudflare Workers 30s wall-clock limit
- Network I/O (fetch, Groq, Cohere) does NOT count toward CPU time
- But real elapsed time IS hard-capped at 30s
- 5 articles via Promise.all: wall clock = max(individual times)
- Each article: 8s fetch + ~5s Groq = ~13s worst case — within 30s
- Always use AbortController + timeout on outbound fetches

### 5. Duplicate URL insert is a silent no-op
- `daily_news` insert uses `Prefer: resolution=ignore-duplicates`
- PostgREST silently skips on URL conflict — no error, no update
- For backfill of `article_content` on existing rows: use a separate PATCH after insert

### 6. `wrangler dev` has no secrets
- `wrangler dev` (plain) has undefined env vars — Supabase fetches silently fail in 3ms
- Always use `wrangler dev --remote --test-scheduled` for real testing
- Then in a second terminal: `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`

### 7. Stuck `processing` rows need manual recovery
```sql
UPDATE raw_ingestion
SET status = 'pending', retry_count = 0, last_error = NULL
WHERE status = 'processing' AND processed_at IS NULL;
```

### 8. DeepSeek-R1 was decommissioned by Groq
- `answer-question` has dead code for `reasoning_content` (thinking blocks)
- `llama-3.3-70b-versatile` never emits `reasoning_content`
- Do not remove until a reasoning model replaces it

### 9. `questions` is all-or-nothing
- `generateQuestions()` returns null if either EN or ZH call fails
- Article inserts with `questions: null` — no pill shown in UI
- Use the ↻ refresh button to regenerate after TPD resets

### 10. Supabase timestamps are always UTC
- `TIMESTAMPTZ` stored in UTC internally
- Display with `AT TIME ZONE 'America/New_York'` or `SET timezone = 'America/New_York'`
- Never hardcode `EST` — use `America/New_York` for automatic DST handling

### 11. Fresh reprocessing requires delete-then-reset order
```sql
-- 1. Delete daily_news FIRST (raw_ingestion has ON DELETE RESTRICT)
DELETE FROM daily_news;
-- 2. Then reset raw_ingestion
UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL, processed_at=NULL
WHERE status IN ('done', 'error');
```

### 13. Cloudflare Workers subrequest limit: 50 per invocation
- Free tier hard cap: **50 subrequests** per Worker invocation (scheduled or fetch trigger)
- Count every outbound `fetch()`: DB reads, DB writes, Groq, Cohere, GitHub, HN Algolia, etc.
- **ingest-builders** current count: 1 (sources GET) + 1 (feed-x.json) + 1 (Groq bio) + 1 (PATCH sources.metadata) + 32 (raw_ingestion INSERTs) = **36/50**
- **process-queue** current count: 1 (SELECT) + 5 (PATCH processing) + 5×(1 scrape + 1 HN + 1 Groq summary + 2 Groq questions + 1 INSERT + 1 PATCH content + 1 PATCH done) = **~41/50**
- When limit is hit: Worker throws immediately — no partial completion, no error row written
- Do NOT add per-item batch loops (e.g., 32 PATCH calls) — they blow the limit instantly
- Upgrade path: Cloudflare Workers Paid ($5/mo) raises limit to 1,000 subrequests

### 12. Groq format inconsistency in structured output
- Groq may return JSONL (newline-delimited objects `{"handle": "karpathy", "role": "Director"}`) instead of a flat JSON object `{"karpathy": "Director"}` even when the system prompt explicitly specifies flat JSON
- Always implement both parsers: try `JSON.parse(content)` first, then split on newlines and parse each line as fallback
- Affected in: `workers/ingest-builders/src/index.ts` → `extractBioMap()`
- Mitigation: keep prompt examples explicit (`{"karpathy": "...", "swyx": "..."}`); set `temperature: 0`

---

## Database Schema Quick Reference

```sql
-- raw_ingestion: ingestion queue (service role only; no client RLS)
id, source_id, url (UNIQUE), raw_content (raw RSS HTML),
status (pending/processing/done/error), retry_count, last_error,
fetched_at, processed_at,
metadata JSONB   -- {likes: N, retweets: N} for builder tweets; NULL for RSS

-- daily_news: product table (public read via RLS)
id, source_id, raw_ingestion_id, url (UNIQUE),
title, summary,                          -- language fallback
title_en, summary_en,                    -- English
title_zh, summary_zh,                    -- Chinese
article_content TEXT,                    -- scraped full text; NULL for WeChat (bridge handles)
questions JSONB ({en: string[], zh: string[]}),
embedding vector(1024),                  -- HNSW cosine index
engagement JSONB,                        -- {likes, retweets} for tweets | {hn_score, hn_comments} for RSS
created_at TIMESTAMPTZ

-- sources: feed registry (public read via RLS)
id, name, rss_url (UNIQUE), source_type (rss/x_api/wechat/github_feed), is_active,
metadata JSONB   -- {bio_map: {handle: "role"}} for github_feed sources; NULL for others

-- match_articles RPC
FUNCTION match_articles(query_embedding vector(1024), match_count int DEFAULT 5)
RETURNS TABLE (id uuid, title text, summary text, score float)
-- ORDER BY embedding <=> query_embedding (raw <=> required for HNSW index)
```

---

## File Reference

| File | Purpose | Key Functions |
|------|---------|---------------|
| `workers/ingest-rss/src/index.ts` | Daily RSS fetch → raw_ingestion | `parseRSS()`, `extract()` |
| `workers/ingest-x/src/index.ts` | **Deleted** — freed cron slot; was disabled anyway ($100/mo X API) | — |
| `workers/ingest-builders/src/index.ts` | follow-builders feed-x.json → raw_ingestion + bio extraction + engagement metadata | `extractAccounts()`, `extractBioMap()`, `extractAuthor()` |
| `workers/send-feishu-digest/src/index.ts` | daily_news → Feishu webhook card | Daily 12pm EST (17:00 UTC); all 3 ZH bullets; engagement badge; FEISHU_WEBHOOK_URL required |
| `workers/process-queue/src/index.ts` | Scrape + summarize + questions + engagement → daily_news | `fetchArticleContent()`, `fetchHNEngagement()`, `processArticle()`, `generateQuestions()`, `insertAndMarkDone()`, `stripHtml()` |
| `workers/embed-batch/src/index.ts` | Cohere batch embed → daily_news.embedding | Scheduled handler |
| `supabase/functions/answer-question/index.ts` | Streaming RAG Q&A | RAG + Groq SSE |
| `supabase/functions/refresh-questions/index.ts` | On-demand question regeneration | No RAG dependency |
| `news-app/App.tsx` | Full Expo frontend | `handleAsk()`, pagination, bilingual toggle |
| `docs/architecture.md` | Design decisions + rationale | Read before changing patterns |
| `docs/schema.md` | DB schema (partially outdated — verify against deployed) | Reference for migrations |
| `current-state.md` | Live deployment status | Update after every deploy |
| `AI-PM-skill.md` | Product strategy + roadmap | Read for prioritization |

---

## Deployment Commands

```bash
# Deploy a Cloudflare Worker
cd workers/<worker-name> && wrangler deploy

# Test Worker cron locally with real secrets (--remote required)
wrangler dev --remote --test-scheduled
# Second terminal:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
# plain `wrangler dev` has undefined secrets — fetches silently fail in 3ms

# Deploy Supabase Edge Function
supabase functions deploy <function-name>

# Add Edge Function secret
supabase secrets set KEY=value --project-ref <project-ref>
supabase secrets list

# Tail Worker logs (live)
wrangler tail <worker-name>

# Tail Edge Function logs
supabase functions logs answer-question --tail
```

---

## Useful Diagnostic SQL

```sql
-- Pipeline health
SELECT status, COUNT(*) FROM raw_ingestion GROUP BY status;

-- Article content quality check
SELECT url, length(article_content) AS chars, left(article_content, 200) AS preview
FROM daily_news WHERE article_content IS NOT NULL LIMIT 5;

-- WeChat stripped text quality check
SELECT length(regexp_replace(regexp_replace(raw_content,'<[^>]+>',' ','g'),'\s+',' ','g')) AS stripped
FROM raw_ingestion WHERE url LIKE '%mp.weixin.qq.com%' LIMIT 3;

-- Embedding progress
SELECT
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
  COUNT(*) FILTER (WHERE embedding IS NULL) AS pending
FROM daily_news;

-- Stuck processing rows
SELECT COUNT(*) FROM raw_ingestion WHERE status = 'processing' AND processed_at IS NULL;

-- Fresh reprocess (delete daily_news first, then reset raw_ingestion)
DELETE FROM daily_news;
UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL, processed_at=NULL
WHERE status IN ('done','error');

-- Timestamps in Eastern Time
SET timezone = 'America/New_York';
-- Or per-query: created_at AT TIME ZONE 'America/New_York'
```

---

## Next Implementation Stages

Prioritized in order. Do not skip ahead — each stage depends on the previous being stable.

---

### Stage 1 — Deploy ingest-builders + send-feishu-digest ✅ COMPLETE

**Both workers deployed and verified live.**

**Files:** `workers/ingest-builders/src/index.ts`, `workers/send-feishu-digest/src/index.ts`

**Step 1 — SQL (run once in Supabase SQL Editor):**
```sql
INSERT INTO sources (name, rss_url, source_type, is_active)
VALUES (
  'follow-builders',
  'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
  'github_feed',
  true
);
-- Confirm:
SELECT id, name, source_type FROM sources WHERE source_type = 'github_feed';
```

**Step 2 — Deploy ingest-builders:**
```bash
cd "workers/ingest-builders"
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler deploy
```

**Step 3 — Verify ingest-builders:**
```bash
cd "workers/ingest-builders"
wrangler dev --remote --test-scheduled
# second terminal:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
Expected logs: `Source: follow-builders (uuid)` → `Fetched N builder tweets` → `Attempted N inserts`

Verify SQL:
```sql
SELECT COUNT(*), status FROM raw_ingestion ri
JOIN sources s ON s.id = ri.source_id
WHERE s.source_type = 'github_feed' GROUP BY status;
```

**Step 4 — Get Feishu webhook URL:**
Feishu group → Settings → Bots → Add Bot → Custom Bot → Copy webhook URL
(`https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx`)

**Step 5 — Deploy send-feishu-digest:**
```bash
cd "workers/send-feishu-digest"
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put FEISHU_WEBHOOK_URL
wrangler deploy
```

**Step 6 — Verify send-feishu-digest:**
```bash
cd "workers/send-feishu-digest"
wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
Expected log: `Feishu digest sent: N articles for YYYY-MM-DD` → check Feishu group for blue card.

**Cron schedule after full deployment:**
| Worker | UTC Cron | Action |
|--------|----------|--------|
| ingest-rss | `0 */4 * * *` | RSS feeds → raw_ingestion |
| ingest-builders | `0 6 * * *` | Builder tweets → raw_ingestion |
| process-queue | `*/15 * * * *` | raw_ingestion → daily_news (Groq) |
| embed-batch | `*/5 * * * *` | daily_news → Cohere embeddings |
| send-feishu-digest | `0 17 * * *` | daily_news → Feishu card (12pm EST) |

**Tweet quality note:** X blocks scraping, so tweets fall back to `rawContent = "@handle: tweet text"` (280 chars). Summaries are thin but acceptable.

---

### Stage 2 — Source Quality Audit ⏳ PENDING (data wiped 2026-03-22 — re-run after 3+ days of ingest)

**Problem:** Unknown which feeds produce high-signal vs low-signal content. Need data before deciding to add/remove sources.

**No code changes — SQL + manual review. Run once `daily_news` has 50+ articles across sources.**

```sql
SELECT
  s.name,
  s.source_type,
  COUNT(dn.id) AS articles,
  ROUND(AVG(length(dn.article_content))) AS avg_scraped_chars,
  ROUND(AVG(length(dn.summary_en))) AS avg_summary_chars,
  ROUND(AVG(length(dn.article_content)::float / NULLIF(length(dn.summary_en), 0))) AS compression_ratio,
  COUNT(dn.id) FILTER (WHERE dn.article_content IS NULL) AS scrape_failures,
  COUNT(dn.id) FILTER (WHERE dn.questions IS NULL) AS questions_missing,
  COUNT(dn.id) AS total
FROM daily_news dn
JOIN sources s ON s.id = dn.source_id
GROUP BY s.name, s.source_type
ORDER BY compression_ratio DESC NULLS LAST;
```

**Decision criteria (RSS and WeChat only — do NOT apply to github_feed):**
- `avg_scraped_chars` < 500 AND `scrape_failures` > 50% → paywalled/blocked → disable
- `compression_ratio` < 3 → Groq summarized a thin snippet, not real content → lower signal
- `questions_missing` high → content too thin for Groq → lower signal
- Engagement data is the primary quality signal for builder tweets — length is irrelevant for KOLs
- Disable: `UPDATE sources SET is_active = false WHERE name = '...' AND source_type != 'github_feed';`

**Per-source audit strategy:**

| Source | Audit signal | Expected outcome |
|---|---|---|
| TechCrunch, Ars Technica, The Verge | `avg_scraped_chars` + `scrape_failures` | Keep — established sources, scrape well |
| Hacker News | Disable regardless of metrics | Structural problem: scrapes HN comment threads, not linked article. `article_content` is discussion text, not article body. Fix requires scraper to follow linked URL — defer to backlog. |
| WeChat (all 5) | `avg_summary_chars` only (scraping always fails by design) | Keep sources with usable stripped text; disable ones with consistently empty `raw_content` |
| Builder tweets (github_feed) | No audit — skip | KOL curation is the quality filter. Use engagement (likes/retweets) as signal. Length thresholds do not apply. |

---

### Stage 2.5 — follow-builders Podcast Ingestion (feed-podcasts.json) ← NEXT

**Gate:** After Stage 2 audit decision is made. Podcast schema must be inspected before implementing.

**Context:** AI-PM-skill.md lists 5 podcasts (Latent Space, Training Data, No Priors, etc.). follow-builders provides `feed-podcasts.json`. `ingest-builders` only fetches `feed-x.json` today — podcasts not wired.

**First step — inspect the feed schema before writing code:**
```bash
curl https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json | head -c 2000
```
The structure is unknown until fetched. Builder tweet schema (`{x: [{handle, bio, tweets}]}`) does NOT necessarily match podcast schema.

**Implementation (after schema is known):**
- Add second fetch in `ingest-builders` for `feed-podcasts.json`
- Parse episode schema (likely: title, transcript excerpt, YouTube/podcast URL, published_at)
- Insert into `raw_ingestion` under a new `podcast` source row (separate from `github_feed`) — episode transcripts are much longer than tweets, better content quality
- `process-queue` handles the rest automatically (summarize + questions + embed)
- Watch subrequest count: adding podcast inserts on top of 36 existing may approach the 50 limit

**File:** `workers/ingest-builders/src/index.ts`

---

### Stage 3 — UI Polish

**Gate:** Intelligence layer (scraping + RAG) validated solid first.

**Mandatory:** Use `superpowers:brainstorming` then `frontend-design` skill before writing any code. Do not design ad-hoc.

**File:** `news-app/App.tsx`

**Known pain points (priority order):**
1. **Answer rendering** — streams as plain text; Markdown bold/bullets should render (most impactful — summaries and answers use `**bold**` formatting that displays as raw characters)
2. **Article card design** — functional but sparse; needs visual hierarchy
3. **Source filter pills** — no way to filter by source; consider filter-by-source pill bar at top
4. **Language toggle UX** — toggle resets open answers; consider persisting answer across switch
5. **Empty states** — no questions / no articles shows blank; needs placeholder UI

**Already implemented (do not re-implement):**
- Engagement badges: 🔥 likes (amber) + ▲ HN score (yellow) — live in App.tsx
- `X - @handle - role` source label — live
- Bilingual toggle with `公众号` WeChat detection — live

**Constraint:** Expo web + React Native — StyleSheet only, no CSS. Use `context7` before adding any library.

---

### Stage 4 — Web Deployment (Cloudflare Pages)

**Prerequisite:** UI polish done; no console errors in `npx expo start --web`.

**Why Cloudflare Pages over Vercel:** Already in the Cloudflare ecosystem; `wrangler` is installed; generous free tier; no extra tooling needed.

**Critical nuance — `EXPO_PUBLIC_*` vars are baked at build time, not runtime:**
- They're inlined into the static bundle during `expo export`, like `REACT_APP_*` in CRA
- They cannot be injected by the CDN after the fact

```bash
# First-time setup
npx wrangler pages project create news-app

# Build (env vars must be available in shell before this step)
cd news-app
npx expo export --platform web   # output: news-app/dist/

# Deploy
npx wrangler pages deploy dist --project-name news-app
```

**Option A — Local deploy (simplest):**
Ensure `.env.local` has `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`, then:
```bash
npx expo export --platform web && npx wrangler pages deploy dist --project-name news-app
```

**Option B — CI/CD via GitHub:**
1. Connect repo in Cloudflare Dashboard → Pages → Create a project → Connect to Git
2. Build command: `cd news-app && npx expo export --platform web`
3. Output directory: `news-app/dist`
4. Set env vars in Pages → Settings → Environment variables → Production:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - These are injected at build time by Cloudflare Pages CI — same effect as local `.env`

**Verify:** Open Pages URL → articles load → Q&A streaming works.

---

### Stage 5 — iOS Build (Expo EAS)

**Prerequisite:** Web deployment stable. Apple Developer account ($99/yr).

```bash
npm install -g eas-cli
cd news-app
eas build:configure

# Test on simulator (no Apple account needed)
eas build --platform ios --profile preview

# App Store build
eas build --platform ios --profile production
```

**Purely a packaging step — no product or code work beyond `eas.json` config.**

---

### Backlog (no immediate priority)

| Item | Trigger |
|------|---------|
| Retry backoff in process-queue | Error rate > 10% |
| Fix questions all-or-nothing (return partial EN/ZH) | questions null rate > 20% |
| Return `article_content` from `match_articles` for richer RAG context | After Stage 2 UI done |
| Add more CN sources (少数派, 虎嗅, 晚点LatePost) | After source audit |
| Fix HN scraping to follow linked URL (not HN page) | If HN re-enabled after structural fix |
| Engagement sorting/filtering in App.tsx | After enough engagement data accumulates (1+ week) |
| HN enrichment reliability check | If `hn_score` is null for most RSS articles after 1 week |
| Cloudflare Workers Paid ($5/mo) | When subrequest count approaches 45/50 or new workers needed |
| Push notifications (daily digest) | Phase 4 |
| Remove `reasoning_content` dead code in answer-question | When reasoning model added |

---

## Skills Reference

| Skill | When to use |
|-------|-------------|
| `superpowers:brainstorming` | Before designing any non-trivial feature |
| `superpowers:writing-plans` | Before multi-step implementation (3+ files) |
| `superpowers:systematic-debugging` | When something breaks unexpectedly |
| `superpowers:verification-before-completion` | Before claiming any feature is done |
| `frontend-design` | Any UX/UI component or design decision |
| `context7` | Cloudflare Workers API, Supabase SDK, Expo, Cohere API docs |

---

## Known Issues (Do Not Re-Investigate)

| Issue | Root Cause | Status |
|-------|-----------|--------|
| `reasoning_content` never in SSE | DeepSeek-R1 decommissioned; llama-3.3-70b has no reasoning | Defer until reasoning model available |
| `questions` null on rate limit | EN+ZH generation all-or-nothing; 429 kills both | Use ↻ refresh next day |
| No retry backoff | Simple increment, no delay | Low priority |
| Stuck `processing` rows on crash | No auto-recovery | Manual SQL fix above |
| WeChat scraping always fails | WeChat blocks external HTTP | Expected; RSS bridge is the ceiling |
| Cloudflare 5 cron trigger limit reached | Free tier hard limit; ingest-x deleted to make room | Fixed; monitor if new workers added |
| Groq JSONL format in bio extraction | Groq ignores flat-JSON instruction sometimes | Handled via fallback parser in `extractBioMap()` |
| Existing builder tweets have NULL engagement | Tweets inserted before metadata column; ON CONFLICT DO NOTHING prevents re-insert | Resolves naturally as new tweets come in daily; existing rows not backfilled |
| `docs/schema.md` outdated | Not updated as columns were added (metadata, engagement, article_content, etc.) | Always verify schema against deployed DB; do not trust docs/schema.md |
