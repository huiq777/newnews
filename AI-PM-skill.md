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

**App name:** **newnews**

**What it is:** AI-powered bilingual news aggregator (English + Chinese) with daily Feishu digest — personal daily reading tool and portfolio showcase piece

**Core loop:**
```
Sources (RSS + WeChat + Tweets + Podcasts + future: GitHub/PH/Nowcoder/Papers)
  → Cloudflare Workers / Supabase Edge Functions
  → LLM (summarize + bilingual questions)
  → Cohere Embeddings → Supabase pgvector
  → Web app (newnews) + Daily Feishu digest
```

**Who it's for:** Personal daily reading tool + portfolio showcase piece

**Success definition:** Build it *nicely* — quality and craft over scale or revenue

**Stack:** Mostly free-tier (Groq → migrating to grok-4.1-thinking + MiMo-V2-Flash, Cohere, Supabase, Cloudflare Workers, Expo/React Native web)

---

## Content Categories

Categories are defined by **content type, not platform**. A Nowcoder post and a Zhihu coding thread both belong in the same category regardless of origin. This drives both the feed UI (tab navigation) and source expansion decisions.

| Category | Signal type | Current sources | Proposed additions |
|---|---|---|---|
| **Industry** | Editorial journalism, product commentary, professional takes | RSS (TechCrunch, Ars, The Verge), WeChat (5 sources), Podcasts, Builder Tweets (follow-builders + Apify 6) | Product Hunt (free GraphQL API, ~30 AI/tech launches/day, vote count as quality signal) |
| **Technical Frontier** | Primary technical outputs — not journalism about them | — (none yet) | GitHub Trending (zero-cost Cheerio scrape), arXiv / Papers with Code (research papers) |
| **Career / Dev Community** | What developers are discussing, experiencing, hiring | — (none yet) | Nowcoder hot-search API (undocumented, no auth, 20 trending items) — Chinese dev/job community |

**Key principle:** Categories are content-first, platform-agnostic. Product Hunt belongs in Industry (industry people talking about what's shipping — same signal as builder tweets). GitHub Trending belongs in Technical Frontier (primary technical output, not journalism about it).

---

## Sources

### Active
- RSS: TechCrunch, Ars Technica, The Verge *(Hacker News disabled — low signal)*
- WeChat (via RSS bridge): Founder Park, GeekPark, 财联社, 中国新闻社, 36氪
- Builder tweets: 25 AI builders via follow-builders `feed-x.json` (GitHub, no X API cost)
- AI podcasts: 5 shows (Latent Space, Training Data, No Priors, Unsupervised Learning, Data Driven NYC) via follow-builders `feed-podcasts.json` (YouTube transcripts, no API cost)
- Apify-scraped tweets: 6 curated AI/tech figures (Chris Olah, Dario Amodei, Simon Willison, @xai, Paul Graham, Ethan Mollick) via Apify Twitter scraper (~$1.08/mo)

### Proposed (not yet implemented)
- **Product Hunt** — GraphQL API, free `PRODUCTHUNT_API_TOKEN`, top 30 posts by vote count → Industry category
- **GitHub Trending** — Cheerio scrape of `github.com/trending`, zero auth, star count as engagement signal → Technical Frontier category
- **arXiv / Papers with Code** — research paper feed → Technical Frontier category
- **Nowcoder** — undocumented hot-search API (`gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc?size=20&_={timestamp}`), no auth → Career/Dev Community category

**Source reference:** See `docs/design-inspiration-log.md` for detailed scraper analysis of GitHub Trending, Product Hunt, and Nowcoder (entry #2).

---

## Delivery Channels

- **Web app (newnews)** — full feed with inline RAG Q&A, left sidebar date navigator, 3-category tabs
- **Feishu (飞书)** — daily digest card at 12pm EST (17:00 UTC)

---

## Web UI Design Direction

> Full analysis in `docs/design-inspiration-log.md`. Design is still in progress — decisions below are settled; visual details are being finalised.

### App identity
- **Name:** newnews
- **Nav tabs:** Latest · Technical · Community (maps to the 3 content categories)
- **EN/中 toggle** persists across all views

### Design system (settled)
| Token | Value |
|---|---|
| Headline font | Manrope (bold, tight tracking) |
| Date/label font | Space Grotesk (uppercase, wide tracking) |
| Body font | Inter |
| Background | `#f9f9f7` warm off-white |
| Surface | zinc/neutral palette (`zinc-50`, `zinc-100`, `zinc-200`) |
| Active/selected | `bg-zinc-900 text-white` (near-black) |
| Cards | `bg-white border border-zinc-100 rounded-xl` |
| Inactive wheel items | `opacity-30 grayscale blur-[0.5px]` |

### UX model: Progressive disclosure (settled)
Inspired by newsminimalist.com — **three depth levels, each earned by user action:**
1. **Title only** (collapsed default) — source label + headline, no summary visible
2. **Expanded** (click title) — summary bullets + questions appear inline, scroll position preserved
3. **Q&A** (click a question) — streaming RAG answer renders below the question

Current design shows all 3 bullets on load — this will change to title-only collapsed default.

### Left sidebar: Drum wheel date navigator (settled, visual details in progress)
Fixed left sidebar `w-64` for temporal navigation and horizontal real estate on wide screens.

**Timeframe buttons:**
- `Today` — full-width; shows today's calendar-day articles AND snaps wheel to top; not a toggle
- `7D · 30D · 90D` — step-size selector for the wheel; tap active to deselect (returns to per-day)
- **1D dropped** — Today replaces it (semantically cleaner, per-day granularity via wheel)

**Drum wheel:**
- 5 slots: 2 above (newer), active center, 2 below (older)
- Scroll DOWN = into the past; future slots hidden
- Active item: large prominent box; non-active: blurred + faded by distance
- Secondary label: distance from today (`-4d`, `-11d`, `today`; ≥90d → `~Nmo Nd`; ≥1yr → `~Nyr Nmo Nd`)
- Window = backward from anchor (anchor = upper bound): anchor 2026-03-20, 7D step → shows Mar 13–20
- Default on load: Today active, wheel at top, today's articles shown

**Feed query impact:**
- Both count and data queries apply the same date filter (pagination accuracy)
- Page resets to 0 on any filter change

### What does NOT change
- ArticleCard component internals
- Streaming RAG Q&A behaviour
- Engagement badges (🔥 likes for tweets)
- Refresh questions button
- EN/中 language toggle with scroll-position preservation
- All workers, Supabase functions, schema

---

## Current State (as of 2026-04-01)

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
| Web deployment | ❌ Dev only — Cloudflare Pages |
| Apify tweet ingestion | ⏳ In progress — `ingest-apify-tweets` Edge Function implemented; webhook config pending |
| Web UI redesign (newnews) | ⏳ Design settled — drum wheel + progressive disclosure + 3-category tabs; implementation pending |
| Trend Brief | ⏳ Spec complete — `docs/superpowers/specs/2026-04-01-trend-brief-design.md`; implementation pending |
| Model migration (grok-4.1 + MiMo) | ⏳ Plan written in `docs/model-strategy.md` — not implemented |
| New source categories (PH, GitHub, Nowcoder, Papers) | ⏳ Proposed — not implemented |
| iOS build (Expo EAS) | ❌ Phase 5 |

---

## Prioritized Roadmap

### ✅ Tier 1 — Foundation (complete)
- ~~Full article scraping~~ — live
- ~~Activate RAG~~ — live

### Tier 2 — Active Work

**~~1. Deploy `ingest-builders` + `send-feishu-digest`~~** ✅ Complete

**2. Source Quality Audit** ⏳ Pending — DB wiped 2026-03-22; run after sufficient data (50+ articles)
- SQL + judgment only; no code
- Per-source: RSS → avg_scraped_chars + scrape_failures; WeChat → avg_summary_chars; Builders → skip

**~~2.5. Podcast Ingestion~~** ✅ Complete

**~~3. UI Polish + Design Pass~~** ✅ Complete (warm editorial)

**4. Web Deployment via Cloudflare Pages**
- `npx expo export --platform web` → `npx wrangler pages deploy dist --project-name news-app`
- `EXPO_PUBLIC_*` vars baked at build time — set in `.env.local` or Pages CI dashboard
- See `AI-SWE-skill.md` Stage 4 for full commands

**4.5. Apify Tweet Ingestion (6 curated handles)**
- **Architecture:** Apify 6:30am UTC → `RUN_SUCCEEDED` webhook → Supabase Edge Function `ingest-apify-tweets` → `raw_ingestion` → existing `process-queue` unchanged
- **Cost:** ~$1.08/mo (15 tweets × 6 handles × 30 days)
- **No CF cron slot used:** Apify scheduler is external; Edge Function is webhook-triggered
- See `AI-SWE-skill.md` Stage 4.5 for full technical spec

**5. Web UI Redesign — newnews**
- Progressive disclosure: title-only collapsed → click to expand summary + questions
- Left sidebar drum wheel date navigator (Today / 7D / 30D / 90D)
- 3-category nav tabs: Latest · Technical · Community
- Design system: Space Grotesk + Manrope + Inter, zinc neutral palette
- File: `news-app/App.tsx` only
- Full design spec: see Web UI Design Direction above + `docs/design-inspiration-log.md`

**5.5. Trend Brief**
- Cross-window synthesis card above article list, "All" tab only
- Two-pass clustering (cosine > 0.82, proportional slot allocation) → 12 articles → MiMo-V2-Flash
- Historical enrichment via existing `match_articles` RPC (pgvector)
- TTL cache in `trend_briefs` table (6h); Refresh button for manual invalidation
- AbortController + `req.signal` propagation for cancel-on-scroll
- Full spec: `docs/superpowers/specs/2026-04-01-trend-brief-design.md`

**6. Model Migration (grok-4.1-thinking + MiMo-V2-Flash)**
- grok-4.1-thinking for quality tasks (article/tweet summaries, RAG Q&A)
- MiMo-V2-Flash for mechanical tasks (question generation, bio extraction)
- ~67% cheaper than Groq paid tier; removes TPD cap entirely
- Full plan: `docs/model-strategy.md`
- New secrets: `XAI_API_KEY`, `MIMO_API_KEY`

**7. Source Expansion (new categories)**
- **Industry:** Add Product Hunt (free GraphQL API, `PRODUCTHUNT_API_TOKEN`)
- **Technical Frontier:** Add GitHub Trending (Cheerio scrape) + arXiv/Papers with Code
- **Career/Dev Community:** Add Nowcoder (undocumented hot-search API, no auth)
- Each new source_type needs a category mapping in the frontend

**8. iOS via Expo EAS**
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
| 2026-03-28 | App named "newnews" | Project identity established during web UI design session |
| 2026-03-28 | Content taxonomy: 3 categories (Industry / Technical Frontier / Career+Dev Community) | Content-first, platform-agnostic; Product Hunt → Industry; GitHub Trending → Technical Frontier; Nowcoder → Career/Dev Community |
| 2026-03-28 | Progressive disclosure UX: title-only collapsed default | Newsminimalist analysis — showing all 3 bullets on load creates visual fatigue; title-only scan is faster; depth earned by user action |
| 2026-03-28 | Left sidebar drum wheel date navigator | GitHub Trending 简报 analysis — left sidebar ergonomically correct for right-handed users; drum wheel (Apple clock style) with Today / 7D / 30D / 90D timeframe step sizing |
| 2026-03-28 | Drop 1D timeframe; replace with Today button | 1D and Today feel identical to users; Today is more meaningful and doubles as snap-to-top action |
| 2026-03-28 | Wheel window = backward from anchor (anchor is upper bound) | Active anchor = upper bound; step period goes backward from it (e.g. 2026-03-20 with 7D → shows Mar 13–20) |
| 2026-03-28 | Design system: Space Grotesk + Manrope + Inter, zinc neutral palette | Matches reference UI; Space Grotesk for dates/labels, Manrope for headlines, Inter for body |
| 2026-03-28 | Model split: grok-4.1-thinking (quality) + MiMo-V2-Flash (mechanical) | 67% cheaper than Groq paid; removes TPD cap; quality improvement on article summaries (Arena 1472 vs ~1250); plan in docs/model-strategy.md |

---

## Key Files Reference

| File | Purpose |
|---|---|
| `/workers/process-queue/src/index.ts` | LLM summarization + question generation pipeline |
| `/workers/ingest-builders/src/index.ts` | Reads follow-builders feed-x.json + feed-podcasts.json → raw_ingestion |
| `/workers/send-feishu-digest/src/index.ts` | Daily Feishu digest card |
| `/supabase/functions/answer-question/index.ts` | Streaming RAG chatbot endpoint |
| `/supabase/functions/refresh-questions/index.ts` | On-demand question regeneration |
| `/supabase/functions/ingest-apify-tweets/index.ts` | Apify webhook receiver (Stage 4.5, not yet built) |
| `/workers/embed-batch/src/index.ts` | Cohere batch embeddings |
| `/news-app/App.tsx` | Full frontend — single file, all UI logic |
| `/docs/architecture.md` | Technical decisions + rationale |
| `/docs/api-keys-and-env.md` | Every secret and where it lives |
| `/docs/model-strategy.md` | Model migration plan (grok-4.1 + MiMo) |
| `/docs/token.md` | Full token usage breakdown per pipeline stage |
| `/docs/design-inspiration-log.md` | Web UI design inspiration — site reviews, category decisions, design system |
| `/current-state.md` | Live deployment status |
| `AI-SWE-skill.md` | Technical counterpart — read before any code change |
