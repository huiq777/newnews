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

**Stack:** Mostly free-tier (Groq `llama-3.3-70b-versatile`, Cohere, Supabase, Cloudflare Workers, Expo/React Native web)

---

## Content Categories

Categories are defined by **content type, not platform**. A Nowcoder post and a Zhihu coding thread both belong in the same category regardless of origin. This drives both the feed UI (tab navigation) and source expansion decisions.

| Category | Signal type | Current sources |
|---|---|---|
| **Industry** | Editorial journalism, product commentary, professional takes | RSS (TechCrunch, Ars, The Verge), WeChat (Founder Park, GeekPark), Podcasts, Builder Tweets (follow-builders), Apify tweets (6 handles), Product Hunt |
| **Technical Frontier** | Primary technical outputs — not journalism about them | GitHub Trending, arXiv (cs.AI + cs.LG) |
| **Career / Dev Community** | What developers are discussing, experiencing, hiring | Nowcoder hot-search, Reddit (r/MachineLearning, r/cscareerquestions, r/layoffs) |

**Key principle:** Categories are content-first, platform-agnostic. Product Hunt belongs in Industry (industry people talking about what's shipping — same signal as builder tweets). GitHub Trending belongs in Technical Frontier (primary technical output, not journalism about it).

---

## Sources

### Active
- **RSS:** TechCrunch, Ars Technica, The Verge *(Hacker News disabled — captures comment threads, not articles)*
- **WeChat** (via RSS bridge): Founder Park, GeekPark *(wechat2rss — content works)*; 财联社, 中国新闻社, 36氪 disabled *(wewe-rss — empty raw_content)*
- **Builder tweets:** 25 AI builders via follow-builders `feed-x.json` (GitHub, no X API cost)
- **Apify-scraped tweets:** 6 curated handles (ch402, DarioAmodei, simonw, xai, paulg, emollick) via Apify webhook (~$1.08/mo)
- **AI podcasts:** 5 shows via follow-builders `feed-podcasts.json` (YouTube transcripts, no API cost)
- **GitHub Trending:** HTML scrape of `github.com/trending`, zero auth, star count as engagement signal → Technical Frontier
- **arXiv:** cs.AI + cs.LG top 10 per category via Atom API, no auth → Technical Frontier
- **Product Hunt:** GraphQL API top 30 by votes, `PRODUCTHUNT_API_TOKEN` required → Industry
- **Nowcoder:** public hot-search JSON API (`gw-c.nowcoder.com`), no auth → Career/Dev Community
- **Reddit:** r/MachineLearning, r/cscareerquestions, r/layoffs via `.rss` feeds (JSON API blocked by Cloudflare IPs) → ⚠️ Needs SQL update + ingest-rss deploy

**Source reference:** See `docs/design-inspiration-log.md` for scraper analysis of GitHub Trending, Product Hunt, and Nowcoder.

---

## Delivery Channels

- **Web app (newnews)** — full feed with inline RAG Q&A, left sidebar date navigator, 3-category tabs
- **Feishu (飞书)** — daily digest card at 12pm EST (17:00 UTC)

---

## Web UI Design Direction

> Full analysis in `docs/design-inspiration-log.md`. Design is **implemented** — all components live in `news-app/components/`.

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

### Implemented components (`news-app/components/`)
- `NavBar` — tab navigation (Latest · Technical · Community) + EN/中 toggle
- `DrumWheelSidebar` — fixed left sidebar; Today / 3D / 7D / 30D buttons; spring-sliding indicators; `switchTo(days)` control for auto-fallback
- `FilterTag` — active filter pill
- `ArticleCard` — progressive disclosure; engagement badges (🔥 tweets, ★ GitHub); Markdown bullets; Q&A streaming
- `TrendBriefCard` — synthesis card above feed; expand/collapse; SSE streaming; Refresh button; "All" tab only

---

## Current State (as of 2026-04-05)

| Component | Status |
|---|---|
| RSS ingestion | ⚠️ Needs deploy — now routes `source_type IN (rss, wechat, reddit)` |
| Full article scraping | ✅ Live (HTMLRewriter; 8s timeout; paywall fallback) |
| LLM summarization + question generation | ⚠️ Needs deploy — **1 Groq call/article** (was 3); `parseJsonSection()` parser; max_tokens 2000 |
| Vector embeddings (Cohere) | ✅ Live (embed-batch every 5 min; article_content preferred) |
| Inline Q&A on article cards | ✅ Live |
| RAG in `answer-question` | ✅ Live (match_articles RPC; top 3 related; Groq SSE streaming) |
| `ingest-builders` worker | ⚠️ Needs deploy — now fetches GH Trending + PH + Nowcoder + arXiv + Reddit; missing podcast no longer kills downstream |
| `send-feishu-digest` worker | ✅ Live (daily 17:00 UTC / 12pm EST; Chinese; `X - @handle - role` format; all 3 ZH bullets) |
| Engagement data pipeline | ✅ Live (tweets: likes/retweets; GitHub Trending: stars; Reddit: score + num_comments) |
| Engagement UI badges | ✅ Live (🔥 tweets amber pill; ★ GitHub stars; HN disabled) |
| Podcast ingestion | ✅ Live (ingest-builders; YouTube transcripts; `podcast` source_type) |
| Web UI redesign (newnews) | ✅ Live — drum wheel sidebar, progressive disclosure, 3-category tabs, Today/3D/7D/30D; components in `news-app/components/` |
| Today eager init + 3D auto-fallback | ✅ Live — no flash on load; auto-switches to 3D if Today returns 0 articles |
| Trend Brief | ✅ Live — `generate-trend-brief` Edge Function + `TrendBriefCard`; two-pass clustering; historical enrichment; `trend_briefs` 6h TTL cache |
| Apify tweet ingestion | ✅ Live — `ingest-apify-tweets` Edge Function; 6 handles; Apify webhook |
| GitHub Trending ingestion | ✅ Live — added to ingest-builders; HTML scrape; stars engagement |
| arXiv ingestion | ✅ Live — cs.AI + cs.LG top 10; Atom API; added to ingest-builders |
| Product Hunt ingestion | ✅ Live — GraphQL top 30 by votes; `PRODUCTHUNT_API_TOKEN` required |
| Nowcoder ingestion | ✅ Live — public hot-search API; no auth; added to ingest-builders |
| Reddit ingestion | ⚠️ Needs SQL + deploy — sources need `.rss` URL update + ingest-rss needs deploy |
| `published_at` pipeline | ✅ Live — all sources store `metadata.published_at`; HTML meta tag fallback |
| Web deployment | 🔄 In progress — Cloudflare Pages |
| Model migration (grok-4.1 + MiMo) | ⏳ Plan written — `docs/model-strategy.md`; not implemented |
| iOS build (Expo EAS) | ❌ Phase 6 — do last |

---

## Prioritized Roadmap

### ✅ Complete
- ~~Full article scraping~~ — live
- ~~Activate RAG~~ — live
- ~~Deploy `ingest-builders` + `send-feishu-digest`~~ — live
- ~~Podcast ingestion~~ — live
- ~~UI polish + design pass~~ — warm editorial aesthetic live
- ~~Apify tweet ingestion~~ — `ingest-apify-tweets` Edge Function live; 6 curated handles
- ~~Web UI redesign~~ — drum wheel sidebar, progressive disclosure, 3-category tabs live in `news-app/components/`
- ~~Trend Brief~~ — `generate-trend-brief` + `TrendBriefCard` + `trend_briefs` cache live
- ~~Source expansion~~ — GitHub Trending, arXiv, Product Hunt, Nowcoder all live in ingest-builders

### ⚠️ Immediate — Deploy Pending Workers

Three workers have local changes not yet deployed:

```bash
cd workers/ingest-rss && npx wrangler deploy
cd workers/process-queue && npx wrangler deploy
cd workers/ingest-builders && npx wrangler deploy
```

Also update Reddit sources to RSS format (JSON API blocked from Cloudflare IPs):
```sql
UPDATE sources SET rss_url = 'https://www.reddit.com/r/MachineLearning.rss', source_type = 'rss' WHERE name = 'Reddit r/MachineLearning';
UPDATE sources SET rss_url = 'https://www.reddit.com/r/cscareerquestions.rss', source_type = 'rss' WHERE name = 'Reddit r/cscareerquestions';
UPDATE sources SET rss_url = 'https://www.reddit.com/r/layoffs.rss', source_type = 'rss' WHERE name = 'Reddit r/layoffs';
```

Then reset 429-errored rows: `UPDATE raw_ingestion SET status='pending', retry_count=0 WHERE status='error' AND last_error LIKE 'Groq 429%';`

### Active Work

**1. Source Quality Audit** ⏳ Pending — run once `daily_news` has 50+ articles (3+ days of ingest after deploy)
- SQL + judgment only; no code changes
- Per-source: RSS → avg_scraped_chars + scrape_failures; WeChat → avg_summary_chars; Builders → skip

**2. Web Deployment via Cloudflare Pages** 🔄 In progress
- `npx expo export --platform web` → `npx wrangler pages deploy dist --project-name news-app`
- `EXPO_PUBLIC_*` vars baked at build time — set in `.env.local` or Pages CI dashboard
- See `AI-SWE-skill.md` for full commands

### Future

**3. Model Migration (grok-4.1-thinking + MiMo-V2-Flash)**
- grok-4.1-thinking for quality tasks (summaries, RAG Q&A); MiMo-V2-Flash for mechanical (questions, bio extraction)
- ~67% cheaper; removes TPD cap entirely
- Full plan: `docs/model-strategy.md`

**4. iOS via Expo EAS**
- Packaging step only — do last
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
