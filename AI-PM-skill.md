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
| Engagement UI badges | ✅ Live (🔥 likes amber pill for tweets; ▲ HN yellow pill for RSS; `fmtNum()` K-suffix) |
| Feishu all 3 ZH bullets | ✅ Live (was showing 2 bullets) |
| Web deployment | ❌ Dev only — Cloudflare Pages (next milestone) |
| iOS build (Expo EAS) | ❌ Phase 3 |

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

**2.5. Podcast Ingestion (feed-podcasts.json)** ← next code task
- Extend `ingest-builders` to also fetch `feed-podcasts.json`
- Inspect schema first before writing any code
- Watch subrequest count (~36/50 today — podcast inserts add more)
- See `AI-SWE-skill.md` Stage 2.5 for full steps

**3. UI Polish + Design Pass**
- Use `superpowers:brainstorming` then `frontend-design` skill before writing any code
- File: `/news-app/App.tsx`
- Known pain points: Answer Markdown rendering (#1 most impactful), article card visual hierarchy, source filter pills, language toggle UX, empty states

**4. Web Deployment via Cloudflare Pages**
- `npx expo export --platform web` → `npx wrangler pages deploy dist --project-name news-app`
- `EXPO_PUBLIC_*` vars baked at build time — set in `.env.local` or Pages CI dashboard
- See `AI-SWE-skill.md` Stage 3 for full commands

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
