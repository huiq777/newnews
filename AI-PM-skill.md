# AI PM Skill — News Project

> Living product context for AI-assisted PM conversations.
> Read this at the start of any new session before making product decisions.
> Update the Decision Log whenever a significant product direction is chosen.

---

## Role Definition

When operating as AI PM on this project:
- Focus on **user value and product quality**, not implementation mechanics
- Prioritize **fundamentals over features** — broken foundations make features worthless
- Think in terms of **portfolio-grade craft** — every feature must be demonstrably excellent
- Challenge assumptions; bring FAANG-level rigor to prioritization
- Always use `superpowers:brainstorming` before proposing a new feature
- Use `frontend-design` skill for any UX/UI direction decisions
- Use `context7` for library-specific documentation lookups

---

## Product Snapshot

**What it is:** AI-powered bilingual news aggregator (English + Chinese) with daily Feishu digest

**Core loop:**
```
RSS Feeds + Builder Tweets → Cloudflare Workers → Groq LLM (summarize + questions) → Cohere Embeddings → Supabase pgvector → Inline RAG Q&A (Expo web) + Daily Feishu digest
```

**Who it's for:** Personal daily reading tool + portfolio showcase piece

**Success definition:** Build it *nicely* — quality and craft over scale or revenue

**Stack:** 100% free-tier (Groq, Cohere, Supabase, Cloudflare Workers, Expo/React Native)

**Sources:**
- RSS: TechCrunch, Ars Technica, The Verge, Hacker News
- WeChat (via RSS bridge): Founder Park, GeekPark, 财联社, 中国新闻社, 36氪
- Builder tweets: 25 AI builders via follow-builders `feed-x.json` (GitHub, no X API cost)
- AI podcasts: 5 shows (Latent Space, Training Data, No Priors, Unsupervised Learning, Data Driven NYC) via follow-builders `feed-podcasts.json` (YouTube transcripts, no API cost)
- Apify-scraped tweets: 6 curated AI/tech figures (Chris Olah, Dario Amodei, Simon Willison, @xai, Paul Graham, Ethan Mollick) via Apify Twitter scraper (~$1.08/mo)

**Delivery channels:**
- Web app (Expo) — full feed with inline RAG Q&A
- Feishu (飞书) — daily digest card at 12pm EST (17:00 UTC)

---

## Current State (as of 2026-03-22)

| Component | Status |
|---|---|
| RSS ingestion | ✅ Live |
| Full article content scraping | ✅ Live (HTMLRewriter; 8s timeout; paywall fallback) |
| LLM summarization + question generation | ✅ Live (bilingual EN+ZH; full content as input) |
| Vector embeddings (Cohere) | ✅ Live (embed-batch; prefers article_content) |
| Inline Q&A on article cards | ✅ Live |
| RAG in `answer-question` | ✅ Live (match_articles RPC; top 3 related; Groq SSE streaming) |
| `ingest-builders` worker | ✅ Live (daily 6am UTC; bio extraction via Groq; stores metadata={likes,retweets}) |
| `send-feishu-digest` worker | ✅ Live (daily 17:00 UTC / 12pm EST; Chinese content; X - @handle - role format; all 3 ZH bullets; engagement badge) |
| Engagement data pipeline | ✅ Live (`raw_ingestion.metadata` + `daily_news.engagement`; tweets: likes/retweets; RSS: HN score via Algolia API) |
| Upgraded summary prompt | ✅ Live (2-3 sentences/bullet; specific metrics required; no vague generalizations) |
| Engagement UI badges | ✅ Live (🔥 likes amber pill for tweets only; HN badge disabled) |
| Feishu all 3 ZH bullets | ✅ Live (was showing 2 bullets) |
| Podcast ingestion (feed-podcasts.json) | ✅ Live (ingest-builders; YouTube transcripts; `podcast` source_type; batch INSERT) |
| Stage 3 UI redesign | ✅ Live (warm editorial; `MarkdownText`; answer Markdown; proportional scroll position) |
| Web deployment | ❌ Dev only — Cloudflare Pages ← NEXT |
| Apify tweet ingestion | ❌ Not started — Stage 4.5 (6 curated handles via Supabase Edge Function webhook) |
| iOS build (Expo EAS) | ❌ Phase 5 |

---

## Prioritized Roadmap

### ✅ Tier 1 — Foundation (complete)
- ~~Full article scraping~~ — live
- ~~Activate RAG~~ — live

### Tier 2 — Active Work

**~~1. Deploy `ingest-builders` + `send-feishu-digest`~~** ✅ Complete
- Both workers live; bio map cached in `sources.metadata`; Feishu digest running at 17:00 UTC

**2. Source Quality Audit** ⏳ Pending — DB wiped 2026-03-22; run after 2026-03-25
- Wait for 3+ days of ingest (50+ articles across sources) before running
- SQL + judgment only; no code
- Per-source strategy: RSS → avg_scraped_chars + scrape_failures; HN → disable (structural); WeChat → avg_summary_chars; Builders → skip

**~~2.5. Podcast Ingestion (feed-podcasts.json)~~** ✅ Complete
- `ingest-builders` fetches both `feed-x.json` and `feed-podcasts.json` in one scheduled run
- Podcast episodes batch-inserted; `podcast` source_type; subrequest count 36 → 38/50

**~~3. UI Polish + Design Pass~~** ✅ Complete
- Warm editorial redesign delivered; `MarkdownText` for bullet+bold; answer Markdown; scroll position fix
- HN engagement badge removed (HN source disabled)

**4. Web Deployment via Cloudflare Pages** ← NEXT
- `npx expo export --platform web` → `npx wrangler pages deploy dist --project-name news-app`
- `EXPO_PUBLIC_*` vars baked at build time — set in `.env.local` or Pages CI dashboard
- See `AI-SWE-skill.md` Stage 4 for full commands

**4.5. Apify Tweet Ingestion (6 curated handles)**
- **Why:** 5 CF cron slots exhausted; 6 high-signal handles not in follow-builders feed (Chris Olah, Dario Amodei, Simon Willison, @xai, Paul Graham, Ethan Mollick)
- **Architecture:** Apify runs scraper on its own schedule (6:30am UTC) → `RUN_SUCCEEDED` webhook → Supabase Edge Function `ingest-apify-tweets` → `raw_ingestion` → existing `process-queue` unchanged
- **Cost:** ~$1.08/mo (15 tweets × 6 handles × 30 days = 2,700 tweets at $0.40/1K)
- **Tweet prompt:** Dedicated Groq prompt for tweets — title format `"@original said X, retweeted by @handle"` or `"@handle said X"` — same 3-bullet summary structure as articles but tweet-aware
- **No CF cron slot used:** Apify scheduler is external; Edge Function is webhook-triggered (event-driven)
- **Deduplication:** `ON CONFLICT (url) DO NOTHING` — re-fetched tweets silently skipped
- See `AI-SWE-skill.md` Stage 4.5 for full technical spec

**5. iOS via Expo EAS**
- Packaging step, not product work — do last
- Requires Apple Developer account ($99/yr)

---

## Feature Evaluation Framework

Before adding any feature, ask:

1. **Does it make the core loop better?** (ingest → summarize → embed → Q&A + digest)
2. **Does it fix a fundamental or add decoration?** Fix fundamentals first.
3. **What does a recruiter/user see in their first 60 seconds?** Optimize for that.
4. **Is the infrastructure ready to support it?** Don't build on broken foundations.
5. **Is there a simpler version that delivers 80% of the value?** Prefer it.

---

## Skills Reference

| Skill | When to use |
|---|---|
| `superpowers:brainstorming` | Before designing ANY new feature — explores intent and requirements |
| `superpowers:writing-plans` | Before multi-step implementation work |
| `superpowers:systematic-debugging` | When something breaks unexpectedly |
| `frontend-design` | Any UX/UI direction, component design, visual polish decisions |
| `context7` | Library-specific docs lookup (Expo, Supabase, Cloudflare Workers, etc.) |
| `superpowers:verification-before-completion` | Before claiming any feature is done |

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-03-20 | Prioritize full article scraping over RAG activation | RAG on snippet-based embeddings has limited ceiling; scraping unlocks both simultaneously |
| 2026-03-20 | Defer UI polish, filtering, personalization | Fundamentals (content quality, reasoning quality) must be solid first |
| 2026-03-20 | Keep 100% free-tier stack | Portfolio project — cost constraints are a feature, not a limitation |
| 2026-03-21 | Tier 1 complete — scraping + RAG both live | Roadmap advances to Tier 2 |
| 2026-03-21 | Cloudflare Pages for web deployment (not Vercel) | Already in CF ecosystem; wrangler installed; free tier generous |
| 2026-03-21 | Integrate follow-builders as passive data source | Reads their public feed-x.json — builder tweets in web + RAG at zero X API cost |
| 2026-03-21 | Add Feishu as daily delivery channel | Personal daily use case; digest card at 17:00 UTC (12pm EST); no extra cost |
| 2026-03-21 | Feishu digest time set to 17:00 UTC (12pm EST), not 9am UTC | 9am UTC is 5am EST — too early for a morning digest; 17:00 UTC hits mid-day US Eastern |
| 2026-03-21 | Bio extraction via Groq batch call, cached in sources.metadata JSONB | Avoids per-tweet bio lookups; shared between ingest-builders (write) and send-feishu-digest (read) |
| 2026-03-21 | follow-builders stays independent; we are read-only consumers | No X API needed; no fork/clone needed; acceptable dependency on public repo |
| 2026-03-21 | Tweet likes/retweets deferred to Stage 3 | Not useful as quality signal (KOL curation supersedes engagement); may display on tweet cards during UI polish |
| 2026-03-22 | Implemented engagement pipeline (reversed 2026-03-21 deferral) | HN Algolia API is free + zero auth; tweet likes already in feed-x.json; badges add visible quality signal to UI with zero ongoing cost |
| 2026-03-22 | Upgraded summary prompt to 2-3 sentences/bullet with specific metrics | Vague summaries ("discusses X") provide less value than concrete ones ("X grew 40% YoY") |
| 2026-03-22 | DB wiped for clean data start | Engagement columns added required migration; fresh start ensures all articles have engagement data populated consistently |
| 2026-03-22 | Podcast ingestion merged into ingest-builders (not a new worker) | All 5 CF cron slots used; ingest-builders already runs daily 6am UTC; batch INSERT keeps subrequest count at ~38/50 |
| 2026-03-22 | Stage 3 UI redesign complete — warm editorial aesthetic | MarkdownText renders bullet+bold; answer Markdown with streaming cursor; proportional scroll fix on lang toggle |
| 2026-03-22 | HN engagement badge disabled alongside HN source | HN source disabled (is_active=false); badge no longer meaningful; tweets-only 🔥 badge remains |
| 2026-03-23 | Apify scraper chosen for 6 curated handles not in follow-builders feed | All 5 CF cron slots exhausted; Apify has its own scheduler + webhook; Supabase Edge Function as webhook receiver avoids pg_cron/pg_net (rejected in architecture.md); ~$1.08/mo well within $5 budget |
| 2026-03-23 | Dedicated tweet Groq prompt added to process-queue | Article prompt demands "precise metrics/financial figures" → `INSUFFICIENT_CONTENT` on short tweet text; tweet prompt uses same 3-bullet structure but tweet-aware title and bullet framing |

---

## Key Files Reference

| File | Purpose |
|---|---|
| `/workers/process-queue/src/index.ts` | Groq summarization + question generation pipeline |
| `/workers/ingest-builders/src/index.ts` | Reads follow-builders feed-x.json → raw_ingestion |
| `/workers/send-feishu-digest/src/index.ts` | Daily Feishu digest card |
| `/supabase/functions/answer-question/index.ts` | Streaming RAG chatbot endpoint |
| `/supabase/functions/refresh-questions/index.ts` | On-demand question regeneration |
| `/workers/embed-batch/src/index.ts` | Cohere batch embeddings |
| `/news-app/App.tsx` | Full frontend (Phase 2.1) |
| `/docs/architecture.md` | Technical decisions + rationale |
| `/docs/api-keys-and-env.md` | Every secret and where it lives |
| `/current-state.md` | Live deployment status |
| `AI-SWE-skill.md` | Technical counterpart — read before any code change |
