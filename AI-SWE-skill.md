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
| RSS ingestion | ✅ Live | Daily 7am UTC; 10 sources |
| Full article scraping | ✅ Live | HTMLRewriter in process-queue; 8s timeout; paywall fallback |
| LLM summarization | ✅ Live | Groq llama-3.3-70b-versatile; bilingual EN+ZH |
| Question generation | ✅ Live | 3 EN + 3 ZH per article; all-or-nothing |
| Cohere embeddings | ✅ Live | embed-batch; 2000-char input; article_content preferred |
| RAG Q&A | ✅ Live | match_articles RPC; top 3 related; Groq streaming SSE |
| article_content column | ✅ Live | daily_news.article_content TEXT; NULL for WeChat (bridge handles) |
| match_articles RPC | ✅ Live | pgvector cosine similarity; HNSW index active |
| Web deployment | ❌ Dev only | Vercel deployment is Tier 2 |
| iOS build | ❌ Not started | Expo EAS is Phase 3 |

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
      2. POST to Groq → bilingual title + 3-bullet summary (uses full content)
      3. POST to Groq ×2 parallel → 3 EN + 3 ZH questions
      4. INSERT INTO daily_news (article_content, summaries, questions)
      5. PATCH daily_news.article_content for existing URLs (duplicate URL = silent no-op on INSERT)
      6. PATCH raw_ingestion status='done'
  → error: increment retry_count; status='error' after 3 failures (no backoff)

Every 5 min
embed-batch Worker
  → SELECT 45 articles WHERE embedding IS NULL
  → POST to Cohere batch (input_type='search_document', 2000-char input)
  → prefer article_content; fall back to summary
  → PATCH daily_news.embedding for each article

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

---

## Database Schema Quick Reference

```sql
-- raw_ingestion: ingestion queue (service role only; no client RLS)
id, source_id, url (UNIQUE), raw_content (raw RSS HTML),
status (pending/processing/done/error), retry_count, last_error,
fetched_at, processed_at

-- daily_news: product table (public read via RLS)
id, source_id, raw_ingestion_id, url (UNIQUE),
title, summary,                          -- language fallback
title_en, summary_en,                    -- English
title_zh, summary_zh,                    -- Chinese
article_content TEXT,                    -- scraped full text; NULL for WeChat (bridge handles)
questions JSONB ({en: string[], zh: string[]}),
embedding vector(1024),                  -- HNSW cosine index
created_at TIMESTAMPTZ

-- sources: feed registry (public read via RLS)
id, name, rss_url (UNIQUE), source_type (rss/x_api/wechat), is_active

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
| `workers/ingest-x/src/index.ts` | X/Twitter → raw_ingestion | Disabled (is_active=false; $100/mo) |
| `workers/process-queue/src/index.ts` | Scrape + summarize + questions → daily_news | `fetchArticleContent()`, `processArticle()`, `generateQuestions()`, `insertAndMarkDone()`, `stripHtml()` |
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

### Stage 1 — Source Quality Audit

**Problem:** Unknown which feeds produce high-signal vs low-signal content. Need data before deciding to add/remove sources.

**No code changes — SQL + manual review.**

```sql
SELECT
  s.name,
  s.source_type,
  COUNT(dn.id) AS articles,
  AVG(length(dn.article_content)) AS avg_scraped_chars,
  AVG(length(dn.summary_en)) AS avg_summary_chars,
  COUNT(dn.id) FILTER (WHERE dn.article_content IS NULL) AS scrape_failures
FROM daily_news dn
JOIN sources s ON s.id = dn.source_id
GROUP BY s.name, s.source_type
ORDER BY avg_scraped_chars DESC NULLS LAST;
```

**Decision criteria:**
- `avg_scraped_chars` < 500 and `scrape_failures` high → source is paywalled or bot-blocked
- `avg_summary_chars` consistently thin → RSS bridge not extracting enough content
- Disable low-signal sources: `UPDATE sources SET is_active = false WHERE name = '...';`

---

### Stage 2 — UI Polish

**Gate:** Intelligence layer (scraping + RAG) validated solid first.

**Mandatory:** Use `superpowers:brainstorming` then `frontend-design` skill before writing any code. Do not design ad-hoc.

**File:** `news-app/App.tsx`

**Known pain points (priority order):**
1. **Article card design** — functional but sparse; needs visual hierarchy
2. **Answer rendering** — streams as plain text; Markdown bold/bullets should render
3. **Source label + filter** — show source clearly; consider filter-by-source pill at top
4. **Language toggle UX** — toggle resets open answers; consider persisting answer across switch
5. **Empty states** — no questions / no articles shows blank; needs placeholder UI

**Constraint:** Expo web + React Native — StyleSheet only, no CSS. Use `context7` before adding any library.

---

### Stage 3 — Web Deployment (Cloudflare Pages)

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

### Stage 4 — iOS Build (Expo EAS)

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
| `docs/schema.md` outdated | Not updated as columns were added | Always verify schema against deployed DB |
| WeChat scraping always fails | WeChat blocks external HTTP | Expected; RSS bridge is the ceiling |
