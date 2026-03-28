# Design Inspiration Log

## Purpose

This document records analysis of reference websites during the web UI redesign process. For each site, we capture what works, what doesn't, and the specific design decisions or patterns worth stealing or avoiding for this project.

## How to add an entry

Each site gets its own `###` section with:
- **URL** — exact link reviewed
- **What it looks like** — brief description of layout and visual language
- **Steal** — specific patterns, interactions, or decisions to adopt
- **Reject** — specific patterns that don't fit this project, with a reason
- **Key insight** — the single most important takeaway distilled into one paragraph

Entries are added in conversation order as sites are reviewed. Do not reorder. **Always check the last entry number before adding a new one and increment by 1.** The number in the `###` heading must match the sequential position in the Sites Reviewed section — never skip or duplicate.

---

## Content Category Decisions

These decisions were made during the inspiration review phase and should drive the UI structure.

| Category | Signal type | Sources (initial) |
|---|---|---|
| **Industry** | Editorial journalism, product commentary, professional takes | RSS (TechCrunch, Ars, The Verge), WeChat (5 sources), Podcasts, Builder Tweets (follow-builders + Apify 6), Product Hunt |
| **Technical Frontier** | Primary technical outputs — not journalism about them | GitHub Trending, arXiv / Papers with Code |
| **Career/Developer Community** | What career are discussing, experiencing, asking | Nowcoder hot discussions + job signals; platform-agnostic (more sources can be added) |

**Key principle:** Categories are defined by content type, not platform. A Nowcoder post and a Zhihu coding thread both belong in career/Developer Community regardless of origin. Product Hunt belongs in Industry because it's industry people talking about what's shipping — same signal as builder tweets.

---

## Sites Reviewed

### 1. newsminimalist.com
**URL:** https://www.newsminimalist.com/

**What it looks like:** Dense list view. One article per row — significance score (1–10) on the left, source name, then headline. Clicking a row expands an inline AI-written summary below it. A horizontal slider at the top filters by significance score. Nine category tabs (All, AI, Politics, Business, Science, Tech, World, Health, Climate) sit above the list.

**Steal:**
- **Title-only collapsed state** — no summary, no bullets, no metadata shown until the user clicks. Zero cognitive overhead when scanning. The user controls how deep they go.
- **Inline expansion** — clicking expands the article in-place within the list. No navigation away, no modal, scroll position preserved. The feed stays in context.
- **Source name always visible** — before reading anything, you know where it came from. Trust signal before time commitment.

**Reject:**
- **Significance score + slider** — forces a meta-judgement ("is this significant enough?") before you've even read the headline. Our source curation (Ars, TechCrunch, Verge + builder tweets + WeChat) is already the quality filter. No score needed.
- **Nine category tabs** — navigation burden with no real payoff. Our content is already meaningfully segmented by source type. The EN/ZH toggle + source label in the card header does more work with less UI. The tab bar also eats vertical space on every load.

**Key insight:** Progressive disclosure is the right UX model for a feed with AI depth. Show the title first → click to reveal summary + questions → click a question to stream the answer. Three depth levels, each earned by a deliberate user action. The current design shows all 3 summary bullets immediately on load, which creates visual fatigue when scanning 20+ items. Title-only scanning is faster and more pleasant.

---

### 2. newsnow (ourongxing/newsnow) — Source Architecture Study
**URL:** https://github.com/ourongxing/newsnow

**What it is:** Open-source news aggregator, 19k stars, 42 TypeScript source adapters, heavily Chinese-platform focused. No LLM integration — pure trending headlines. Not a design reference but a technical reference.

**Fetching mechanisms (no RSS at all):**
- HTML scraping with Cheerio: GitHub Trending, HackerNews, Weibo, Solidot, IT Home
- Direct/undocumented API calls: Bilibili, Toutiao, Zhihu, Nowcoder
- Auth'd API: ProductHunt (GraphQL + Bearer token), Douyin (session cookie), Weibo (SUB cookie + UA spoofing)

**Three scrapers examined in detail:**

**GitHub Trending** — Cheerio scrape of `github.com/trending`. CSS selector `main .Box div[data-hpc] > article`. Extracts: repo name, URL, star count, description. No auth. Stable structure. Two source IDs map to same function.

**Product Hunt** — GraphQL API (`api.producthunt.com/v2/api/graphql`). Requires free `PRODUCTHUNT_API_TOKEN`. Queries top 30 posts by vote count. Returns name, tagline, votes (`△︎ 847`), URL. Clean, reliable, free API.

**牛客 (Nowcoder)** — Undocumented public hot-search API: `gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc?size=20&_={timestamp}`. No auth. Returns 20 trending items. `type=74` → discussion post, `type=0` → forum post. Simplest possible implementation.

**Steal:**
- GitHub Trending scraper pattern (zero cost, strong open-source signal)
- Product Hunt GraphQL integration (free API, AI/tech launch signal + vote count as quality signal)
- `defineSource()` functional adapter pattern for adding new sources cleanly

**Reject:**
- Most Chinese sources (Weibo, Douyin, Bilibili) require fragile cookie auth
- Their overall architecture (trending headlines only, no full content, no LLM) is a different paradigm

**Key insight:** Product Hunt is a high-quality free structured API for AI/tech product launches — vote count is a genuine quality signal comparable to our tweet likes. GitHub Trending is the cleanest zero-auth scrape available. Nowcoder's undocumented timestamped API is instructive: simple JSON endpoints with no auth are often more reliable than scraping.

---

### 3. GitHub Trending 简报 (unknown source — screenshot)
![GitHub Trending 简报 screenshot](assets/site-03-github-trending-briefing.png)
**What it is:** A Chinese daily briefing site that wraps GitHub Trending repos with LLM-written summaries. Left sidebar for date navigation, main area for daily repo cards, right sidebar for star rankings.

**Steal:**
- **Left sidebar for date/archive navigation** — "历史报告" (past reports) as a vertical date list on the left. Ergonomically correct for right-handed users: mouse lives on the right for content, left sidebar is reachable but non-intrusive. For a daily feed that accumulates over time, being able to browse "yesterday" or "last week" is genuinely useful and this placement earns it without competing with content.

**Reject:**
- Everything else — color palette (muted army green header), typography (oversized, inconsistent weight), card design (heavy borders, emoji-overloaded labels), the long-form briefing format for a trending list. The content structure (one massive article per day rather than scannable items) defeats the purpose of a feed.

**Key insight:** A daily feed that runs automatically for weeks/months naturally accumulates history. The left sidebar date pattern acknowledges this: the app is a *log*, not just a live feed. A subtle "browse by date" affordance in the left column — even if rarely used — signals to the user that the feed has memory, which adds perceived value and trust.

---
