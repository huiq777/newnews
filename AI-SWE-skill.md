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

## Current Implementation State (as of 2026-04-05)

| Component | Status | Notes |
|-----------|--------|-------|
| RSS ingestion | ⚠️ Needs deploy | Every 4h; now fetches `source_type IN (rss, wechat, reddit)` — WeChat and Reddit routed through ingest-rss |
| Full article scraping | ✅ Live | HTMLRewriter in process-queue; 8s timeout; paywall fallback |
| LLM summarization | ⚠️ Needs deploy | **1 Groq call per article** — summary + QUESTIONS_EN + QUESTIONS_ZH combined; max_tokens 2000; `parseJsonSection()` parser |
| Question generation | ⚠️ Needs deploy | Embedded in the single summary call; `parseJsonSection()` extracts JSON arrays; `generateQuestions()` function removed |
| Cohere embeddings | ✅ Live | embed-batch; 2000-char input; article_content preferred |
| RAG Q&A | ✅ Live | match_articles RPC; top 3 related; Groq streaming SSE |
| article_content column | ✅ Live | daily_news.article_content TEXT; NULL for WeChat (bridge handles) |
| match_articles RPC | ✅ Live | pgvector cosine similarity; HNSW index active |
| `ingest-builders` worker | ⚠️ Needs deploy | Daily 6am UTC; fetches feed-x.json + feed-podcasts.json + GH Trending + PH + Nowcoder + arXiv + Reddit; **missing podcast source no longer kills downstream sources** (early return → else block) |
| `send-feishu-digest` worker | ✅ Live | Daily 12pm EST (17:00 UTC); Chinese (summary_zh + title_zh); `X - @handle - role` format; all 3 ZH bullets |
| AI bio extraction | ✅ Live | Batch Groq call in ingest-builders; verbatim role extraction; cached in sources.metadata |
| `sources.metadata` JSONB | ✅ Live | Stores `bio_map: {handle: "role"}` — shared by Feishu + App.tsx |
| `ingest-x` worker | ❌ Deleted | Removed to free Cloudflare cron slot (5-trigger free tier limit hit) |
| Hacker News source | ❌ Disabled | `is_active=false`; content was comment threads not articles; HN Algolia engagement fetch commented out in process-queue |
| Engagement data pipeline | ✅ Live | `raw_ingestion.metadata JSONB` + `daily_news.engagement JSONB`; tweets: `{likes, retweets}`; GitHub Trending: `{stars}`; Reddit: `{score, num_comments}` — all propagated via process-queue URL-based detection |
| Engagement UI badges | ✅ Live | App.tsx: 🔥 fire SVG + N likes for tweets (amber pill); ★ FA star + N stars for GitHub Trending; HN disabled. `WebHTML` now uses `useRef` + `useEffect` → `node.innerHTML = html` (see Gotcha 15 fix) |
| Podcast ingestion | ✅ Live | `ingest-builders` fetches `feed-podcasts.json`; schema: `{podcasts:[{name,title,url,transcript}]}`; batch INSERT; `podcast` source_type |
| Stage 3 UI redesign | ✅ Live | Warm editorial aesthetic; `MarkdownText` component (bullets + bold); answer Markdown; empty states; `scrollToOffset` lang toggle |
| Drum-wheel UI integration | ✅ Live | NavBar + DrumWheelSidebar + FilterTag + ArticleCard + TrendBriefCard in `news-app/components/`; TF buttons Today/3D/7D/30D; spring-sliding indicators; infinite scroll (10/page); both scrollbar and icon bugs resolved (see Gotchas 15, 16) |
| Today eager init + 3D auto-fallback | ✅ Live | `dateRange` initializes to today on mount (no flash of all articles); auto-switches to 3D if Today returns 0 results; `DrumWheelSidebar` exposes `switchTo(days)` control |
| Trend Brief | ✅ Live | `generate-trend-brief` Edge Function + `TrendBriefCard` component + `trend_briefs` 6h TTL cache; two-pass clustering; historical enrichment via match_articles; llama-3.3-70b-versatile; SSE streaming; "Today" shows 204 when no UTC-day articles yet (correct behavior) |
| Web deployment | 🔄 In Progress | Cloudflare Pages; no longer blocked on UI |
| Apify tweet ingestion | ✅ Live | `supabase/functions/ingest-apify-tweets`; Apify webhook (RUN_SUCCEEDED); validates APIFY_WEBHOOK_SECRET; fetches dataset; batch-inserts into raw_ingestion; 6 handles: ch402, DarioAmodei, simonw, xai, paulg, emollick |
| Tweet-specific Groq prompt | ✅ Live | `process-queue` branches on `isTweet` (x.com/status URL); `TWEET_SYSTEM_PROMPT` constant at module top; title: `@handle said X` / `@original said X, retweeted by @handle`; same 3-bullet body |
| GitHub Trending ingestion | ✅ Live | Added to ingest-builders; HTML scrape of `github.com/trending?spoken_language_code=`; regex parse per `<article`; no auth |
| Product Hunt ingestion | ✅ Live | Added to ingest-builders; GraphQL API top 30 by VOTES; `PRODUCTHUNT_API_TOKEN` wrangler secret required |
| Nowcoder ingestion | ✅ Live | Added to ingest-builders; public JSON API `gw-c.nowcoder.com`; type 74 → feed detail, type 0 → discuss; no auth |
| arXiv ingestion | ✅ Live | Added to ingest-builders; cs.AI + cs.LG; top 10 per category; Atom API; no auth |
| Reddit ingestion | ⚠️ Needs SQL + deploy | Sources now use `.rss` URLs and `source_type='rss'` → routed through ingest-rss (JSON API blocked from Cloudflare IPs) |
| `published_at` pipeline | ✅ Live | All sources store `metadata.published_at` at ingestion; process-queue propagates to `daily_news.published_at`; HTML meta tag fallback for sources without API dates (Nowcoder, etc.) |
| iOS build | ❌ Not started | Expo EAS is Stage 5 |

---

## Pipeline Control Flow

```
Daily @ 7am UTC
ingest-rss Worker
  → SELECT sources WHERE source_type IN ('rss', 'wechat', 'reddit') AND is_active=true
  → fetch all feeds in parallel (Promise.all) — includes WeChat RSS bridges + Reddit .rss feeds
  → extract <link> + <description>/<content:encoded>/<summary> + <pubDate>/<published>/<dc:date> from each item
  → INSERT INTO raw_ingestion (status='pending', metadata={published_at}) ON CONFLICT url DO NOTHING

Every 15 min
process-queue Worker
  → SELECT 5 pending rows from raw_ingestion
  → PATCH all 5 to status='processing' (pessimistic lock)
  → Promise.all(5x processArticle):
      1. fetchArticleContent(url) → HTMLRewriter (8s AbortController timeout)
         returns { content, published_at } — extracts text + date from HTML meta tags
         fallback: stripHtml(raw_content) if scraped < 500 chars
      2. Determine engagement:
         - x.com/status URL → read article.metadata → {likes, retweets}
         - https://github.com/ URL → read article.metadata.stars → {stars: N}
         - reddit.com URL → read article.metadata → {score, num_comments}
         - other URLs → engagement = null (HN Algolia disabled; HN source is inactive)
      3. Resolve published_at: metadata.published_at (ingestion) → HTML meta tag (fallback) → null
      4. POST to Groq (1 call) → bilingual title + 3-bullet summary + QUESTIONS_EN JSON + QUESTIONS_ZH JSON
         parseSection() extracts text fields; parseJsonSection() extracts question arrays
      5. INSERT INTO daily_news (article_content, summaries, questions, engagement, published_at)
      7. PATCH daily_news.article_content for existing URLs (duplicate URL = silent no-op on INSERT)
      8. PATCH raw_ingestion status='done'
  → error: increment retry_count; status='error' after 3 failures (no backoff)
  (subrequest count: ~26/50 — 1 Groq call instead of 3; HN fetch removed)

Daily @ 6am UTC
ingest-builders Worker (requires GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  → GET sources WHERE source_type IN (github_feed, podcast, github_trending, producthunt, nowcoder, arxiv, reddit) AND is_active=true
      split into: builderSource + podcastSource + githubTrendingSource + arxivSources[] + redditSources[] + etc.
  → if (!podcastSource): log and SKIP podcasts block, continue to remaining sources (no longer a hard return)
  ── Builder tweets ──
  → fetch feed-x.json from GitHub (public, no auth)
  → extractAccounts(rawData) → [{handle, bio, tweets:[]}]  (reads data.x array)
  → ONE batch Groq call: extractBioMap() — all bios in one prompt
      system prompt: verbatim extraction; people = role @ company; products = "Name is X @Co"
      response: flat JSON {"handle": "role"} — JSONL fallback parser handles both formats
  → PATCH sources.metadata = {bio_map: {...}} for builderSource.id
  → filter valid tweets (id + text + url) → Promise.all INSERT one per tweet
      raw_content = "@handle: tweet text"; metadata = {likes, retweets, published_at: createdAt}; ON CONFLICT DO NOTHING
  ── Podcasts ──
  → fetch feed-podcasts.json from GitHub (public, no auth)
  → extractPodcasts(rawData) → [{name, title, url, transcript}]  (reads data.podcasts array)
  → filter episodes with url + transcript
  → ONE batch POST to raw_ingestion — all episodes in single subrequest; ON CONFLICT DO NOTHING
      raw_content = "${episode.name}: ${episode.title}\n\n${episode.transcript}"; metadata = {published_at: ep.publishedAt}
  ── GitHub Trending ──
  → fetch https://github.com/trending?spoken_language_code= (HTML, no auth)
  → split on <article; regex-extract repo path, col-9 description, stargazers count
  → fetch https://api.github.com/repos/{owner}/{repo} in parallel (no auth; 60 req/hr limit) → extract pushed_at
  → raw_content = "owner/repo: description (★ N stars today)"; metadata = {stars, published_at: pushed_at}
  ── Product Hunt ──
  → POST https://api.producthunt.com/v2/api/graphql (top 30 by VOTES; query includes createdAt)
  → headers: Authorization Bearer PRODUCTHUNT_API_TOKEN, Accept: application/json
  → raw_content = "name: tagline (△ N votes)"; metadata = {votes, published_at: node.createdAt}
  ── Nowcoder ──
  → GET gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc?size=20&_={ts}&t=
  → type 74 → nowcoder.com/feed/main/detail/{uuid}; type 0 → nowcoder.com/discuss/{id}
  → raw_content = title text
  ── arXiv ──
  → loop over all arxiv sources (cs.AI, cs.LG)
  → GET export.arxiv.org/api/query?search_query=cat:{category}&max_results=10&sortBy=submittedDate&sortOrder=descending
  → Atom XML; regex-extract <entry> blocks → id, title, summary, <published> tag
  → url = https://arxiv.org/abs/{id}; raw_content = "{title}\n\n{abstract}"; metadata = { category, published_at }
  ── Reddit ──
  → Reddit sources now have source_type='rss' and .rss URLs → handled by ingest-rss, NOT ingest-builders
  → ingest-builders Reddit code still exists but no reddit-type sources match (no-op)
  ── Combined batch INSERT ──
  → all non-tweet/podcast sources in one POST to raw_ingestion (ON CONFLICT DO NOTHING)
  (subrequest count: ~19/50 ✅ SAFE)

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
        engagement badge = "🔥 N likes" for tweets only (HN badge disabled)
  → POST to FEISHU_WEBHOOK_URL
  → always sends (even if 0 articles — sends "No articles today")

Daily @ 6:30am UTC (Apify Scheduler — external, no CF cron slot)
ingest-apify-tweets Edge Function (webhook-triggered on RUN_SUCCEEDED)
  → Apify fires POST to https://<project>.supabase.co/functions/v1/ingest-apify-tweets
  → validate Authorization: Bearer <APIFY_WEBHOOK_SECRET>
  → extract eventData.datasetId from webhook body
  → GET https://api.apify.com/v2/datasets/{datasetId}/items?token={APIFY_API_KEY}
  → SELECT sources WHERE source_type='apify_tweet' AND is_active=true → source.id
  → map each tweet: url=item.url, raw_content="@{item.author.userName}: {item.text}",
                    metadata={likes: item.likeCount, retweets: item.retweetCount, published_at: item.createdAt}
  → batch POST to raw_ingestion (Prefer: resolution=ignore-duplicates)
  → process-queue picks up rows automatically (next 15-min cycle)
      → isTweet=true → tweet-specific Groq prompt (title + 3-bullet summary)

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
| Hacker News | ❌ **Disabled** (`is_active=false`) | — | Content was HN comment threads, not linked articles. Re-enable only after fixing scraper to follow the linked URL instead of the HN discussion page |
| Founder Park (wechat2rss) | ❌ WeChat blocks fetch | Bridge HTML ~23K raw → ~2600 stripped | stripHtml() gives usable Chinese text |
| 极客公园 (wechat2rss) | ❌ WeChat blocks fetch | Bridge HTML ~42K raw → ~6000 stripped | Better bridge extraction |
| Short WeChat URLs (mp.weixin.qq.com/s/...) | ❌ Blocked | Sometimes empty raw_content | SKIP (empty) — expected behavior |
| follow-builders tweets (github_feed) | ❌ Not attempted | Tweet text ~280 chars via `@handle: text` | Groq summarizes tweet directly; quality lower than articles; bio extracted separately |
| follow-builders podcasts (podcast) | ❌ Not attempted | Full YouTube transcript (very long) | Groq summarizes transcript directly; high content quality; `process-queue` handles automatically |
| Apify-scraped tweets (apify_tweet) | ❌ Not attempted | Tweet text ~280 chars via `@handle: text`; quote-tweets include retweeted handle in title | Same `isTweet` detection via `x.com/status` URL; tweet-specific Groq prompt; engagement from `item.likeCount`/`item.retweetCount` |
| GitHub Trending (github_trending) | ❌ Not attempted | `owner/repo: description (★ N stars today)` | process-queue scrapes github.com/owner/repo for README; falls back to raw_content |
| Product Hunt (producthunt) | ❌ Not attempted | `name: tagline (△ N votes)` | process-queue scrapes producthunt.com post; raw_content is solid fallback |
| Nowcoder (nowcoder) | ❌ Not attempted | title text only | process-queue scrapes full discussion page |
| arXiv (arxiv) | ✅ process-queue scrapes abstract page | `{title}\n\n{abstract}` (~300–500 words) | High-quality academic abstracts; process-queue scrapes arxiv.org/abs/{id} for full abstract HTML |
| Reddit (now source_type='rss') | ✅ link posts scrape external URL; self-posts use title | RSS feed item description | Switched from JSON API (blocked by Cloudflare IPs) to `.rss` feeds via ingest-rss; link posts: process-queue scrapes the external article; self-posts: raw_content is ceiling |

WeChat scraping will always fail. RSS bridge content after `stripHtml()` is the ceiling. Do not attempt to fix this — it is by design.

---

## Groq Rate Limits (Free Tier)

| Limit | Value | Impact |
|-------|-------|--------|
| TPM (tokens per minute) | 12,000 | Hit during parallel processing; retry after 1 min |
| TPD (tokens per day) | **100,000** | Hit when batch-reprocessing all articles; stops the pipeline |
| Tokens per article (RSS/WeChat/arXiv) | ~2,510 | 1 combined call (summary + questions) |
| Tokens per tweet | ~1,235 | 1 combined call |
| Max articles/day (articles only) | ~40 | At ~2,510 tokens per article |
| Max tweets/day | ~81 | At ~1,235 tokens per tweet |

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
- Questions are now parsed inline from the single summary Groq response via `parseJsonSection()`
- If `QUESTIONS_EN` or `QUESTIONS_ZH` sections are missing/malformed, `questions = null`
- Article inserts with `questions: null` — no pill shown in UI
- Use the ↻ refresh button (calls `refresh-questions` Edge Function) to regenerate after TPD resets
- `generateQuestions()` function was removed from process-queue (2026-04-05)

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
- **ingest-builders** current count: 1 (sources GET) + 1 (feed-x.json) + 1 (Groq bio) + 1 (PATCH sources.metadata) + **1 (tweet batch INSERT — all tweets in one POST)** + 1 (feed-podcasts.json) + 1 (podcast batch INSERT) + 1 (GitHub Trending HTML) + 1 (Product Hunt GraphQL) + 1 (Nowcoder API) + 1 (arXiv cs.AI) + 1 (arXiv cs.LG) + 1 (Reddit r/MachineLearning) + 1 (Reddit r/cscareerquestions) + 1 (Reddit r/layoffs) + 1 (combined batch INSERT) = **~19/50 ✅ SAFE** — tweet per-item loop was replaced with a single batch POST (same pattern as podcasts); GitHub API date fetches were never in the actual code
- **process-queue** current count: 1 (SELECT) + 5 (PATCH processing) + 5×(1 scrape + 1 Groq summary + 2 Groq questions + 1 INSERT + 1 PATCH content + 1 PATCH done) = **~36/50** (HN fetch removed)
- When limit is hit: Worker throws immediately — no partial completion, no error row written
- Do NOT add per-item INSERT loops — use a single batch POST with a JSON array body (`Prefer: resolution=ignore-duplicates`)
- Upgrade path: Cloudflare Workers Paid ($5/mo) raises limit to 1,000 subrequests

### 14. Apify webhook payload structure
- Webhook body: `{ eventType: "ACTOR.RUN.SUCCEEDED", eventData: { actorId, runId, datasetId } }`
- Extract `datasetId` from `eventData`, NOT from top-level
- Dataset items endpoint: `GET /v2/datasets/{datasetId}/items?token={APIFY_API_KEY}`
- Tweet fields used: `url` (unique key), `text` (content), `author.userName` (handle), `likeCount`, `retweetCount`, `createdAt` (published date)
- Quote-tweet detection: item has `isRetweet` or `quotedTweet` field — the retweeted person's handle comes from `quotedTweet.author.userName`
- Webhook security: validate `Authorization: Bearer <APIFY_WEBHOOK_SECRET>` header — reject 401 if missing/wrong
- `include:nativeretweets: false` in Apify config means pure RTs are excluded; quote-tweets (commentary added) are included

### 15. `dangerouslySetInnerHTML` is unreliable on react-native-web `View`

**Problem:** The `WebHTML` component pattern — passing `dangerouslySetInnerHTML` as an unknown prop to a React Native `View` — does not reliably render HTML content in react-native-web. The `View` becomes a `<div>` in the DOM, but react-native-web's prop-filtering may strip or ignore the `dangerouslySetInnerHTML` attribute. Icons and SVGs passed this way render as blank.

**Attempts that failed:**
```tsx
// UNRELIABLE — prop may be stripped by react-native-web
function WebHTML({ html, style }: { html: string; style?: object }) {
  return <View style={style} {...{ dangerouslySetInnerHTML: { __html: html } } as any} />
}
```
Even with `as any` cast and correct HTML string, the icon did not appear.

**Correct fix — use `useRef` + `useEffect` to set `innerHTML` directly on the DOM node:**
```tsx
function WebHTML({ html, style }: { html: string; style?: object }) {
  const ref = useRef<any>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const node = ref.current as unknown as HTMLElement | null
    if (node) node.innerHTML = html
  }, [html])
  return <View ref={ref} style={style} />
}
```
This bypasses react-native-web's prop system entirely and writes to the DOM directly — guaranteed to work.

**Affected:** `FIRE_SVG` fire icon and Font Awesome `<i>` star icon in engagement badges. Both use `WebHTML` and both render as blank until this fix is applied.

---

### 16. CSS class rules for scrollbar hiding are overridden by react-native-web inline styles

**Problem:** react-native-web applies layout styles as inline `style` attributes directly on DOM elements. Inline styles have higher specificity than CSS class rules. This means any CSS class rule that attempts to override a react-native-web inline style (e.g., scrollbar hiding) will lose the specificity battle.

**What was tried (all failed):**
1. CSS class `.wheel-track::-webkit-scrollbar { display: none; width: 0; height: 0 }` — class rule, lower specificity than inline styles
2. `.wheel-track { scrollbar-width: none; -ms-overflow-style: none }` in injected `<style>` tag — same issue
3. `track.style.cssText = '...scrollbar-width:none;-ms-overflow-style:none;overflow-y:scroll;'` inline on the scroll track — works for Firefox (`scrollbar-width: none`) but `::-webkit-scrollbar` pseudo-element cannot be set inline; only a `<style>` rule or `!important` can target it
4. `.wheel-wrap { overflow: hidden }` — the wrap clips the content area but `track` is `position:absolute; inset:0` so it overflows the wrap entirely; `overflow:hidden` on the wrap does not clip a `position:absolute` child that fills it unless the wrap also has `position:relative` — this may not be set by react-native-web

**Root cause:** react-native-web uses inline `overflow: 'visible'` or no explicit overflow on the `View` wrapping `.wheel-track`, and the browser's native scrollbar bleeds through as two horizontal gray hairlines at the top and bottom of the scroll track (the scrollbar thumb boundary indicators).

**Correct fix options:**
- **Option A (inline style on wrap node, not track):** Get the `wrapDom` element (parent of `track`) and set `wrapDom.style.overflow = 'hidden'` — inline style on the wrap wins over react-native-web inline style since it's set after react-native-web's initial render
- **Option B (dynamic `<style>` with element ID + `!important`):**
  ```javascript
  const id = 'wt-' + Date.now()
  track.id = id
  const st = document.createElement('style')
  st.textContent = `#${id}::-webkit-scrollbar { display:none!important; width:0!important; height:0!important; }`
  document.head.appendChild(st)
  // cleanup: st.remove() in the useEffect return function
  ```
  ID-based CSS rules have higher specificity than class rules, and `!important` overrides inline styles for the `::-webkit-scrollbar` pseudo-element.
- **Option C (preferred — set overflow:hidden on wrapDom after mount):**
  ```javascript
  const wrapDom = wrapRef.current as unknown as HTMLElement
  wrapDom.style.overflow = 'hidden'  // set AFTER react-native-web initial render
  ```
  This works because you're setting inline style directly, after react-native-web has already rendered.

**Note:** Setting inline style on `track` inside `renderWheel()` already happens after mount (inside `useEffect`), so `track.style` changes win. The issue is specifically with `::-webkit-scrollbar` which cannot be set inline — only via a `<style>` element.

---

### 18. Reddit JSON API is blocked from Cloudflare Worker IPs

Reddit's `reddit.com/r/{sub}/hot.json` returns 403/429 from Cloudflare datacenter egress IPs. The `ingest-builders` code silently `continue`s on failure — no rows reach `raw_ingestion`. Reddit RSS feeds (`reddit.com/r/{sub}.rss`) work without auth and return `<item>` Atom entries readable by the existing `parseRSS()` parser. **Fix applied 2026-04-05:** Reddit source rows updated to `source_type='rss'` with `.rss` URLs; routed through `ingest-rss`.

---

### 19. `dateRange` must be initialized eagerly to prevent initial article flash

If `dateRange` starts as `null`, the feed `useEffect` runs immediately on mount with no filter → returns ALL articles. `DrumWheelSidebar` fires `onFilterChange` a frame later to set today's range → second fetch. User sees old articles flash then disappear. **Fix applied 2026-04-05:** `dateRange` lazy-initializes to today's midnight-to-midnight range via `useState(() => { ... })`. Auto-fallback: if Today returns 0 articles, calls `wheelControlsRef.current.switchTo(3)` which fires `onFilterChange(3D)` → useEffect re-runs with 3D range.

---

### 12. Groq format inconsistency in structured output
- Groq may return JSONL (newline-delimited objects `{"handle": "karpathy", "role": "Director"}`) instead of a flat JSON object `{"karpathy": "Director"}` even when the system prompt explicitly specifies flat JSON
- Always implement both parsers: try `JSON.parse(content)` first, then split on newlines and parse each line as fallback
- Affected in: `workers/ingest-builders/src/index.ts` → `extractBioMap()`
- Mitigation: keep prompt examples explicit (`{"karpathy": "...", "swyx": "..."}`); set `temperature: 0`

---

### 17. PostgREST raw `or=` URL filter requires outer parentheses

**Problem:** When building a raw PostgREST REST URL with an `or=` filter (i.e., in a Cloudflare Worker or Edge Function — NOT using supabase-js), the entire filter expression must be wrapped in outer parentheses.

**Wrong (causes `PGRST100` parse error — 502):**
```
?or=and(published_at.gte.2026-04-02,published_at.lt.2026-04-03),and(published_at.is.null,...)
```

**Correct:**
```
?or=(and(published_at.gte.2026-04-02,published_at.lt.2026-04-03),and(published_at.is.null,...))
```

```typescript
// In Edge Function or Worker — must add outer ( )
const orFilter = encodeURIComponent(
  `(and(published_at.gte.${s},published_at.lt.${e}),and(published_at.is.null,created_at.gte.${s},created_at.lt.${e}))`
)
const url = `${SUPABASE_URL}/rest/v1/daily_news?or=${orFilter}&select=...`
```

**Why supabase-js doesn't have this bug:** `.or('cond1,cond2')` in supabase-js wraps the value in `()` automatically before URL-encoding. Raw fetch calls must do this manually.

**Symptom:** `{ "code": "PGRST100", "message": "failed to parse logic tree" }` with HTTP 400. The Edge Function catches `.ok === false` and returns 502 to the frontend.

**Affected:** `supabase/functions/generate-trend-brief/index.ts` — caused the initial 502 on first deploy. Fixed 2026-04-02.

---

## Database Schema Quick Reference


```sql
-- raw_ingestion: ingestion queue (service role only; no client RLS)
id, source_id, url (UNIQUE), raw_content (raw RSS HTML),
status (pending/processing/done/error), retry_count, last_error,
fetched_at, processed_at,
metadata JSONB   -- {likes, retweets, published_at} for tweets; {stars, published_at} for GitHub;
                 -- {score, num_comments, subreddit, published_at} for Reddit; {published_at} for RSS;
                 -- {category, published_at} for arXiv; {votes, published_at} for PH; NULL for Nowcoder

-- daily_news: product table (public read via RLS)
id, source_id, raw_ingestion_id, url (UNIQUE),
title, summary,                          -- language fallback
title_en, summary_en,                    -- English
title_zh, summary_zh,                    -- Chinese
article_content TEXT,                    -- scraped full text; NULL for WeChat (bridge handles)
questions JSONB ({en: string[], zh: string[]}),
published_at TIMESTAMPTZ,               -- original publish date; from metadata or HTML meta tag fallback
embedding vector(1024),                  -- HNSW cosine index
engagement JSONB,                        -- {likes, retweets} for tweets | {stars} for GitHub | {score, num_comments} for Reddit
created_at TIMESTAMPTZ

-- sources: feed registry (public read via RLS)
id, name, rss_url (UNIQUE), source_type (rss/x_api/wechat/github_feed/podcast/apify_tweet/github_trending/producthunt/nowcoder/arxiv/reddit), is_active,
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
| `workers/ingest-rss/src/index.ts` | Daily RSS fetch → raw_ingestion | `parseRSS()` (extracts pubDate/published/dc:date → metadata.published_at), `extract()` |
| `workers/ingest-x/src/index.ts` | **Deleted** — freed cron slot; was disabled anyway ($100/mo X API) | — |
| `workers/ingest-builders/src/index.ts` | feed-x.json (tweets) + feed-podcasts.json (episodes) + GitHub Trending (HTML) + Product Hunt (GraphQL) + Nowcoder (JSON API) + arXiv (Atom API) + Reddit (JSON API) → raw_ingestion | `extractAccounts()`, `extractBioMap()`, `extractAuthor()`, `extractPodcasts()` |
| `workers/send-feishu-digest/src/index.ts` | daily_news → Feishu webhook card | Daily 12pm EST (17:00 UTC); all 3 ZH bullets; 🔥 likes badge for tweets only (GitHub star badge not added to Feishu) |
| `workers/process-queue/src/index.ts` | Scrape + summarize + questions + engagement + published_at → daily_news | `fetchArticleContent()` (returns {content, published_at}), `processArticle()`, `parseSection()`, `parseJsonSection()` (questions extraction), `insertAndMarkDone()`, `stripHtml()` — `generateQuestions()` removed; `fetchHNEngagement()` disabled |
| `workers/embed-batch/src/index.ts` | Cohere batch embed → daily_news.embedding | Scheduled handler |
| `supabase/functions/answer-question/index.ts` | Streaming RAG Q&A | RAG + Groq SSE |
| `supabase/functions/refresh-questions/index.ts` | On-demand question regeneration | No RAG dependency |
| `supabase/functions/ingest-apify-tweets/index.ts` | ✅ Live — Stage 4.5 | Apify webhook receiver; validates `APIFY_WEBHOOK_SECRET`; reads `resource.defaultDatasetId`; batch-inserts into `raw_ingestion`; deploy with `--no-verify-jwt` |
| `news-app/App.tsx` | Main Expo entry — feed orchestration; dateRange eager init (today); auto-fallback to 3D when Today empty | `wheelControlsRef` (`resetToToday` + `switchTo`), `handleAsk()`, `handleRefresh()`, `loadMoreArticles()` |
| `news-app/components/NavBar.tsx` | Top nav bar — category pills + EN/中 toggle | `NavBar()` (langAnim, langVisAnim) |
| `news-app/components/DrumWheelSidebar.tsx` | Drum-wheel date picker + TF buttons | `DrumWheelSidebar()` — exposes `{ resetToToday, switchTo(days) }` via `onMountedControls`; DOM bridge; RAF scroll; spring animate |
| `news-app/components/ArticleCard.tsx` | Article card — source label, summary, questions, answer streaming | `ArticleCard()`, `MarkdownText()`, `WebHTML()` (useRef+innerHTML, see Gotcha 15), `FIRE_SVG`, `fmtNum()` |
| `news-app/components/FilterTag.tsx` | Active date range label pill | `FilterTag()` |
| `news-app/components/TrendBriefCard.tsx` | Trend Brief card — SSE streaming synthesis | `TrendBriefCard()` |
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

-- Published_at coverage
SELECT s.name, COUNT(*) AS total,
  COUNT(dn.published_at) AS has_date,
  COUNT(*) - COUNT(dn.published_at) AS missing_date
FROM daily_news dn JOIN sources s ON s.id = dn.source_id
GROUP BY s.name ORDER BY missing_date DESC;

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

### Stage 2 — Source Quality Audit ⏳ PENDING (data wiped 2026-03-22 — re-run after 2026-03-25)

**Note: Hacker News already manually disabled** — exclude from audit. Only RSS + WeChat sources need review.

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

### Stage 2.5 — follow-builders Podcast Ingestion ✅ COMPLETE

**Schema discovered:** `{ podcasts: [{source, name, title, videoId, url, publishedAt, transcript}] }` — YouTube transcripts, full text, very long.

**What was built:**
- `ingest-builders` now fetches both `feed-x.json` AND `feed-podcasts.json` in one scheduled run
- Combined sources query: `source_type IN (github_feed, podcast)` — saves 1 subrequest vs two separate queries
- `extractPodcasts()` function reads `data.podcasts` array
- Podcast episodes batch-inserted in ONE PostgREST POST (not per-episode like tweets)
- `raw_content = "${episode.name}: ${episode.title}\n\n${episode.transcript}"`
- `process-queue` handles summarization + questions + embedding automatically — no extra code needed
- **SQL to run once:** `INSERT INTO sources (name, rss_url, source_type, is_active) VALUES ('follow-builders-podcasts', 'https://...feed-podcasts.json', 'podcast', true)`
- **Verified:** 1 episode ingested, appeared in raw_ingestion as pending, processed by process-queue

**Subrequest impact:** 36 → 38/50 (+1 for feed-podcasts.json fetch, +1 for batch INSERT, -0 because combined sources query was already 1 call)

---

### Stage 3 — UI Polish ✅ COMPLETE

**What was delivered:**
- `MarkdownText` component: handles `• **Label:** text` bullet lines with bullet character indentation + bold inline parsing — replaces old `BoldText`
- Answer content rendered with Markdown: split on `\n`, each line passed through `MarkdownText`
- Streaming cursor `▌` appended to last non-empty line during streaming
- `↻` pill in card header when `questions === null` (tap to regenerate); `? Questions` pill when questions exist
- Empty state: message shown when no articles loaded
- Full warm editorial redesign: `#F7F6F2` background, `#1A1A1A` accent/pills, `#E0DDD6` borders, `#F0EDE8` answer blocks, 18px/700 title weight, `letterSpacing: -0.3`
- Lang toggle scroll position: proportional mapping — on button press, capture `proportion = currentOffset / contentHeightRef[currentLang]`; after re-render, `onContentSizeChange` fires with new lang's height → `scrollToOffset(proportion × newHeight)`; handles first-ever toggle where new lang height is unknown until render completes; refs: `contentHeightRef`, `pendingProportionRef`, `langRef`
- HN engagement badge removed; 🔥 likes badge for tweets only

---

### Stage 4.5 — Apify Tweet Ingestion + Tweet Prompt Redesign ✅ COMPLETE

**Why after Stage 4:** Web deployment first so the app is publicly accessible before expanding sources. Stage 4.5 enriches the feed with 6 high-signal handles not covered by follow-builders.

**Problem:** All 5 Cloudflare cron slots are used. The follow-builders `feed-x.json` covers 25 AI builders but excludes key figures: Chris Olah (ch402), Dario Amodei (DarioAmodei), Simon Willison (simonw), @xai, Paul Graham (paulg), Ethan Mollick (emollick). The article Groq prompt also fails on tweet content — demands metrics/financial figures → `INSUFFICIENT_CONTENT` on 280-char posts.

**Solution parts:**
1. **`supabase/functions/ingest-apify-tweets`** — webhook receiver that inserts Apify-scraped tweets into `raw_ingestion`
2. **Tweet Groq prompt branch** in `process-queue` — dedicated prompt for `isTweet=true` rows

---

**Part 1 — `supabase/functions/ingest-apify-tweets/index.ts` (new file)**

```
POST (webhook from Apify on RUN_SUCCEEDED)
Body: { eventType: "ACTOR.RUN.SUCCEEDED", eventData: { actorId, runId, datasetId } }

Flow:
1. Validate Authorization: Bearer <APIFY_WEBHOOK_SECRET> → 401 if wrong
2. Parse body → extract eventData.datasetId
3. GET https://api.apify.com/v2/datasets/{datasetId}/items?token={APIFY_API_KEY}
4. SELECT sources WHERE source_type='apify_tweet' AND is_active=true → source.id
5. Map each tweet item to raw_ingestion row:
   - url: item.url  (e.g. https://x.com/DarioAmodei/status/...)
   - raw_content: "@{item.author.userName}: {item.text}"
   - metadata: { likes: item.likeCount ?? 0, retweets: item.retweetCount ?? 0, published_at: item.createdAt ?? null }
   - source_id: apifySource.id
   - status: 'pending'
6. Batch POST to /rest/v1/raw_ingestion
   Headers: Prefer: resolution=ignore-duplicates
   Body: array of all tweet rows (one subrequest)
7. Return 200 { inserted: N }

Secrets required:
  APIFY_API_KEY          — Apify account token
  APIFY_WEBHOOK_SECRET   — shared secret set in Apify webhook config
  SUPABASE_URL           — available as Deno.env built-in
  SUPABASE_SERVICE_ROLE_KEY — available as Deno.env built-in
```

**SQL to run once:**
```sql
INSERT INTO sources (name, rss_url, source_type, is_active, metadata)
VALUES (
  'apify-tweets',
  'https://api.apify.com/v2/acts/kwaHHHxgk6HcbRQsM',
  'apify_tweet',
  true,
  '{"handles": ["ch402", "DarioAmodei", "simonw", "xai", "paulg", "emollick"]}'
);
SELECT id, name, source_type, metadata FROM sources WHERE source_type = 'apify_tweet';
```

**Apify actor config (saved in Apify console):**
```json
{
  "filter:blue_verified": false, "filter:consumer_video": false, "filter:has_engagement": false,
  "filter:hashtags": false, "filter:images": false, "filter:links": false, "filter:media": false,
  "filter:mentions": false, "filter:native_video": false, "filter:nativeretweets": false,
  "filter:news": false, "filter:pro_video": false, "filter:quote": false, "filter:replies": false,
  "filter:safe": false, "filter:spaces": false, "filter:twimg": false, "filter:videos": false,
  "filter:vine": false, "include:nativeretweets": false,
  "lang": "en", "maxItems": 15, "queryType": "Latest",
  "searchTerms": ["from:ch402","from:DarioAmodei","from:simonw","from:xai","from:paulg","from:emollick"],
  "min_retweets": 0, "min_faves": 0, "min_replies": 0
}
```
Note: no `since`/`until` — deduplication via `ON CONFLICT (url)` handles re-fetched tweets.

**Apify one-time setup:**
1. Apify Console → actor → Input → paste config above → Save & Run (verify dataset has `url`, `text`, `likeCount`, `retweetCount`, `author.userName` fields)
2. Schedule → Add → `0 30 6 * * *` (6:30am UTC daily, 30min after ingest-rss)
3. Webhooks → Add → Event: `RUN_SUCCEEDED` → URL: `https://<project>.supabase.co/functions/v1/ingest-apify-tweets` → Header: `Authorization: Bearer <APIFY_WEBHOOK_SECRET>`

**Deploy:**
```bash
supabase functions deploy ingest-apify-tweets
supabase secrets set APIFY_API_KEY=apify_xxxx --project-ref <ref>
supabase secrets set APIFY_WEBHOOK_SECRET=your-secret --project-ref <ref>
```

---

**Part 2 — Tweet Groq prompt branch in `workers/process-queue/src/index.ts`**

The `isTweet` variable (line 238) already exists. After it's determined, select the system prompt before the Groq call (currently at line 264):

```typescript
const systemPrompt = isTweet ? TWEET_SYSTEM_PROMPT : ARTICLE_SYSTEM_PROMPT
```

**`TWEET_SYSTEM_PROMPT` (replace `ARTICLE_SYSTEM_PROMPT` block when `isTweet=true`):**

```
You are an expert tech editor. Analyze the tweet or quote-tweet and produce a bilingual title and summary for a mobile news feed.

Output EXACTLY this structure — no deviations, no extra text:

TITLE_EN: [For original tweets: "@handle said [core claim]." For quote-tweets: "@original said [original claim], retweeted by @handle [with their commentary]." Under 400 characters.]
TITLE_ZH: [原创推文："@handle 表示 [核心观点]。" 转推评论："@original 表示 [原推观点]，由 @handle 转推[并附评论]。" 400字符以内。]

SUMMARY_EN:
• **[Core Event]:** [2-3 sentences. Provide a thorough, accurate summary of what the author said — their exact perspective or reaction. If it's a quote-tweet, lead with their commentary, not the original.]
• **[Crucial Detail]:** [2-3 sentences. Extract and explain highly specific details. Include precise metrics, technical claims, or critical mechanisms mentioned in the tweet or the content being shared.]
• **[The Impact]:** [2-3 sentences. Forward-looking analysis of implications. DO NOT use vague generalizations. Explicitly state specific strategic shifts, market disruptions, or future innovations this perspective triggers.]

SUMMARY_ZH:
• **[核心事件]:** [2-3句话。全面准确总结作者所说——具体立场或反应。如为转推评论，优先呈现其评论内容。]
• **[关键细节]:** [2-3句话。提取高度具体的细节，必须包含精准数据、技术主张或核心机制。]
• **[影响]:** [2-3句话。前瞻性深度分析。严禁模糊泛谈，必须明确指出具体战略转变、市场颠覆或创新推动。]

Strict rules:
1. Start immediately with "TITLE_EN:". No intro or outro.
2. CRITICAL — never translate proper nouns, brand names, or product names.
3. The author's @handle must appear in TITLE_EN and TITLE_ZH.
4. If the tweet lacks signal (purely promotional, spam, single emoji), output: INSUFFICIENT_CONTENT
```

The `parseSection()` function (line 214) is unchanged — same TITLE_EN/ZH and SUMMARY_EN/ZH tags work for both prompts.

**Cost:** 15 tweets × 6 handles × 30 days = 2,700 tweets/month = **~$1.08/month** (well within $5 budget).

**Verify end-to-end:**
```sql
-- After Apify run + webhook fires:
SELECT COUNT(*), s.source_type
FROM raw_ingestion ri JOIN sources s ON s.id = ri.source_id
WHERE s.source_type = 'apify_tweet'
GROUP BY s.source_type;

-- After process-queue picks up rows:
SELECT url, title_en, left(summary_en, 200)
FROM daily_news dn JOIN sources s ON s.id = dn.source_id
WHERE s.source_type = 'apify_tweet'
ORDER BY created_at DESC LIMIT 5;
```

**Deployed:** 2026-03-23

**Gotchas discovered during setup:**
- Deploy must use `--no-verify-jwt` — Apify sends a custom Bearer token, not a Supabase JWT; without this flag Apify gets 401 even with the correct secret
- Apify "Send test notification" button sends a fake payload (Chuck Norris joke in `resource`, no `datasetId`) — safe to ignore; 400 on test webhook is expected
- Dataset ID is at `body.resource.defaultDatasetId` in production payloads; code also falls back to `body.eventData.datasetId` for safety
- Authorization header in Apify webhook Headers template must be JSON: `{"Authorization": "Bearer your-secret"}`

---

### Stage 4.7 — Multi-Source Feed Expansion ✅ COMPLETE

**What was added:** GitHub Trending, Product Hunt, Nowcoder — all ingested inside `ingest-builders` (no new cron slot used).

**Source categories (from `design-inspiration-log.md`):**
- GitHub Trending → Technical Frontier (open-source signal)
- Product Hunt → Industry (AI/tech launches + vote quality signal)
- Nowcoder → Developer Community (Chinese developer discussions)

**Fetch patterns (from [newsnow](https://github.com/ourongxing/newsnow) repo):**
- **GitHub Trending:** HTML scrape of `github.com/trending?spoken_language_code=`; split on `<article`; regex-extract href (repo path), `p.col-9` description, `[href$=stargazers]` star count; no Cheerio in CF Workers → raw regex on text
- **Product Hunt:** GraphQL POST to `api.producthunt.com/v2/api/graphql`; headers: `Authorization Bearer PRODUCTHUNT_API_TOKEN` + `Accept: application/json`; query top 30 by VOTES; fields: name, tagline, votesCount, url
- **Nowcoder:** GET `gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc?size=20&_={timestamp}&t=`; response at `data.result` (NOT `data.hotInfos` as newsnow source suggests — confirmed via live API); `id` is a `string`; type 74 → `/feed/main/detail/{uuid}`; type 0 → `/discuss/{id}`

**Engagement metadata stored in `raw_ingestion.metadata`:**
- GitHub Trending: `{ stars: N }` (integer; commas stripped from `"1,234"` format before `parseInt`)
- Product Hunt: `{ votes: N }`
- Nowcoder: `null` (title only; no engagement signal available)

**Secret added:** `PRODUCTHUNT_API_TOKEN` wrangler secret for `ingest-builders` (free API — register at producthunt.com → settings → API)

**Subrequest budget:** 38/50 → **42/50** (+3 fetches + 1 combined batch INSERT)

**Gotchas discovered during setup:**
- Nowcoder response key is `data.result`, not `data.hotInfos` — always `console.log` raw response keys when a new undocumented API returns 0 items
- PostgREST batch INSERT requires ALL row objects to have identical keys — if any row omits a key that others have, the entire batch fails with `PGRST102: All object keys must match`; fix by setting missing keys to `null`
- GitHub star counts are comma-formatted strings (`"1,234"`) — strip commas before `parseInt` or the value becomes `NaN`

---

### Stage 4.8 — arXiv + Reddit Sources ✅ COMPLETE

**What was added:** arXiv preprints (cs.AI + cs.LG) and Reddit community posts (r/MachineLearning, r/cscareerquestions, r/layoffs) — all ingested inside `ingest-builders` (no new cron slot used).

**Why:** Teamblind is not statically scrapeable (Next.js, no RSS, no public API — requires headless browser). arXiv covers frontier AI research (all top lab preprints from Anthropic, OpenAI, DeepMind, Meta AI appear here first, free). Reddit covers career/industry signal (layoffs, ML discussions, job market) as a Teamblind replacement.

**Source categories:**
- arXiv cs.AI + cs.LG → Frontier AI Research
- Reddit r/MachineLearning → Technical community discussion
- Reddit r/cscareerquestions + r/layoffs → Career/industry signal

**Fetch patterns:**
- **arXiv:** GET `https://export.arxiv.org/api/query?search_query=cat:{category}&max_results=10&sortBy=submittedDate&sortOrder=descending` — returns Atom XML; loop over `<entry>` blocks; regex-extract ID from `<id>`, title from `<title>`, abstract from `<summary>`; URL = `https://arxiv.org/abs/{id}`; raw_content = `{title}\n\n{abstract}`; metadata = `{ category: "cs.AI" }`
- **Reddit:** GET `https://www.reddit.com/r/{subreddit}/hot.json?limit=25` with `User-Agent: NewsProject/1.0`; parse `data.children[*].data`; link posts (`is_self=false`) → `post.url` (external article); self-posts (`is_self=true`) → `https://reddit.com{post.permalink}`; raw_content = `r/{subreddit}: {title}`; metadata = `{ score, num_comments, subreddit }`

**Source name encodes subreddit:** `src.name.replace('Reddit r/', '')` extracts subreddit at runtime — adding a new subreddit only requires a DB INSERT, no code change.

**SQL to run once:**
```sql
INSERT INTO sources (name, rss_url, source_type, is_active) VALUES
  ('arXiv cs.AI', 'https://export.arxiv.org/api/query?search_query=cat:cs.AI', 'arxiv', true),
  ('arXiv cs.LG',  'https://export.arxiv.org/api/query?search_query=cat:cs.LG',  'arxiv', true),
  ('Reddit r/MachineLearning',   'https://www.reddit.com/r/MachineLearning/hot.json',   'reddit', true),
  ('Reddit r/cscareerquestions', 'https://www.reddit.com/r/cscareerquestions/hot.json', 'reddit', true),
  ('Reddit r/layoffs',           'https://www.reddit.com/r/layoffs/hot.json',           'reddit', true);
```

**Secrets required:** None — both arXiv and Reddit are public APIs.

**Subrequest budget:** 42/50 → **47/50** (+2 arXiv + 3 Reddit; combined batch INSERT already counted)

**Gotchas:**
- arXiv `<id>` tag contains full URL (`https://arxiv.org/abs/2501.12345`) — regex must extract numeric ID only; arXiv IDs do not have version suffix in the `<id>` field at this API endpoint
- Reddit **requires** `User-Agent` header — Cloudflare Worker default UA is blocked by Reddit with 429; always set `User-Agent: NewsProject/1.0`
- Reddit self-posts (`is_self=true`) have `post.url` pointing back to `reddit.com` — use `post.permalink` instead, or two entirely different self-posts could share a base domain collision
- PostgREST batch INSERT key uniformity applies here too — all rows must include `metadata` key; both arXiv and Reddit rows already do

---

### Stage 4.1 — Drum-Wheel UI Integration ✅ COMPLETE

**All components shipped and both open bugs resolved.**

**Components** (in `news-app/components/`):
- `NavBar` — fixed top bar, category tabs, EN/中 spring-sliding toggle, fade-out on narrow viewport
- `DrumWheelSidebar` — Today/3D/7D/30D TF buttons + drum wheel DOM bridge; `wrapDom.style.overflow='hidden'` fixes scrollbar (Gotcha 16 Option C)
- `FilterTag` — active date pill with ✕ reset
- `ArticleCard` — engagement badges, Q&A streaming, MarkdownText
- `WebHTML` — now uses `useRef` + `useEffect` → `node.innerHTML = html` (Gotcha 15 fix; not `dangerouslySetInnerHTML`)
- `TrendBriefCard` — Trend Brief synthesis; SSE streaming; collapse/expand; source list
- `MarkdownText` — bullet + bold inline rendering

**Date filtering:** `or()` query on (`published_at` in range) OR (`published_at IS NULL` AND `created_at` in range). Uses local-time midnight as day boundary — "Today" maps to current calendar day in browser's timezone.

**Known behavior:** "Today" returns empty when no articles have been ingested for the current UTC calendar day yet. Normal — pipelines run every 4h. Use 3D/7D to always see content.

---

### Stage 4 — Web Deployment (Cloudflare Pages)

**Prerequisite:** Stage 4.1 drum-wheel UI integration complete; no console errors in `npx expo start --web`.

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
| Stage 4 — Web deployment (Cloudflare Pages) | Active next — `npx expo export --platform web && npx wrangler pages deploy dist --project-name news-app` |
| Retry backoff in process-queue | Error rate > 10% |
| Fix questions all-or-nothing (return partial EN/ZH) | questions null rate > 20% |
| Return `article_content` from `match_articles` for richer RAG context | After Stage 2 UI done |
| Add more Apify handles (e.g. Yann LeCun, Jensen Huang) | After Stage 4.5 stable; budget allows ~12 handles at $5/mo |
| Add more CN sources (少数派, 虎嗅, 晚点LatePost) | After source audit |
| Fix HN scraping to follow linked URL (not HN page) | If HN re-enabled after structural fix |
| Engagement sorting/filtering in App.tsx | After enough engagement data accumulates (1+ week) |
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
| HN `article_content` is comment threads, not articles | `ingest-rss` fetches HN discussion page; HN is a link aggregator | Source disabled (`is_active=false`); fix requires scraper to follow the linked URL — see Backlog |
| EN↔ZH toggle scroll position | EN and ZH cards render at different heights — raw pixel offset maps to wrong position after lang change | Fixed: proportional mapping via `onContentSizeChange` + `pendingProportionRef` in `news-app/App.tsx` |
| PostgREST batch INSERT fails with mixed keys | `PGRST102: All object keys must match` — all row objects in a batch must have identical key sets | Always include every key in every row; use `null` for absent values (e.g. `metadata: null`) |
