# AI PM Skill — News Project

> This file is the living product context for AI-assisted PM conversations on this project.
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

**What it is:** AI-powered bilingual news aggregator (English + Chinese)

**Core loop:**
```
RSS Feeds → Cloudflare Workers → Groq LLM (summarize + questions) → Cohere Embeddings → Supabase pgvector → Inline RAG Q&A (Expo frontend)
```

**Who it's for:** Personal daily reading tool + portfolio showcase piece

**Success definition:** Build it *nicely* — quality and craft over scale or revenue

**Stack:** 100% free-tier (Groq, Cohere, Supabase, Cloudflare Workers, Expo/React Native)

**Sources:** TechCrunch, Ars Technica, Hacker News, Founder Park, GeekPark, WeChat public accounts (via RSS bridge)

---

## Current State (as of 2026-03-21)

| Component | Status |
|---|---|
| RSS ingestion | ✅ Live |
| Full article content scraping | ✅ Live (HTMLRewriter; 8s timeout; paywall fallback) |
| LLM summarization + question generation | ✅ Live (bilingual EN+ZH; full content as input) |
| Vector embeddings (Cohere) | ✅ Live (embed-batch; prefers article_content) |
| Inline Q&A on article cards | ✅ Live |
| RAG in `answer-question` | ✅ Live (match_articles RPC; top 3 related; Groq SSE streaming) |
| Web deployment | ❌ Dev only — Cloudflare Pages (next milestone) |
| iOS build (Expo EAS) | ❌ Phase 3 |

---

## Prioritized Roadmap

### ✅ Tier 1 — Foundation (complete as of 2026-03-21)

- ~~Full article scraping~~ — live; HTMLRewriter in process-queue
- ~~Activate RAG~~ — live; match_articles RPC + Groq streaming

### Tier 2 — Active Work

**1. Source Quality Audit** ← next action
- **Problem:** Unknown which feeds produce high-signal content vs. noise after scraping
- **Impact:** Ensures the intelligence layer is working on good raw material
- **Approach:** SQL query across `daily_news` JOIN `sources` — check avg scraped chars, scrape failure rate per source; disable low-signal sources
- **Effort:** No code — SQL + manual judgment
- **Gate for:** Everything downstream (UI polish, deploy) improves only with good data

**2. UI Polish + Design Pass**
- Use `superpowers:brainstorming` then `frontend-design` skill before writing any code
- File: `/news-app/App.tsx`
- Known pain points: answer Markdown rendering, article card visual hierarchy, source labels, empty states

**3. Web Deployment via Cloudflare Pages**
- `npx expo export --platform web` → `npx wrangler pages deploy dist --project-name news-app`
- `EXPO_PUBLIC_*` vars baked at build time — set in `.env.local` or Pages dashboard CI
- See AI-SWE-skill.md Stage 3 for full commands

**4. iOS via Expo EAS**
- Packaging step, not product work — do last
- Requires Apple Developer account ($99/yr)

---

## Feature Evaluation Framework

Before adding any feature, ask:

1. **Does it make the core loop better?** (ingest → summarize → embed → Q&A)
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
| 2026-03-21 | Tier 1 complete — scraping + RAG both live | Roadmap advances to Tier 2: source audit → UI polish → deploy |
| 2026-03-21 | Cloudflare Pages for web deployment (not Vercel) | Already in CF ecosystem; wrangler installed; no extra tooling; free tier generous |

---

## Key Files Reference

| File | Purpose |
|---|---|
| `/workers/process-queue/src/index.ts` | Groq summarization + question generation pipeline |
| `/supabase/functions/answer-question/index.ts` | Streaming RAG chatbot endpoint |
| `/supabase/functions/refresh-questions/index.ts` | On-demand question regeneration |
| `/workers/embed-batch/src/index.ts` | Cohere batch embeddings |
| `/news-app/App.tsx` | Full frontend (Phase 2.1) |
| `/docs/architecture.md` | Technical decisions + rationale |
| `/docs/schema.md` | Database schema + RLS policies |
| `/current-state.md` | Live deployment status |
