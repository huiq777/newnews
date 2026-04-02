# Trend Brief Feature — Design Spec

## Context

Users currently read articles one by one and must mentally connect them to understand broader trends. This is high-effort and misses cross-temporal patterns — an article from 3 months ago, one from last month, and one from this week may all be pointing at the same story, but only become obvious when looked at together. The Trend Brief adds a synthesis layer above the feed: a single unified analysis of what the current window's articles collectively mean across **all categories**, enriched with historically related articles surfaced via the existing pgvector infrastructure. One brief per time window — not per category.

---

## What Changes

**New:** Supabase Edge Function `generate-trend-brief`
**New:** `trend_briefs` DB table (cache)
**New:** Trend Brief card in `App.tsx`
**Modified:** `embed-batch` — one-line sort change
**Unchanged:** All ingestion workers, `process-queue`, `match_articles` RPC, RAG Q&A

---

## Data Flow

```
User settles on drum wheel position (80ms scroll-settle callback)
  → Frontend checks trend_briefs table for cache hit (key: anchor_date + step_days only — no category)
      → HIT: render immediately (no Edge Function call)
      → MISS: call generate-trend-brief Edge Function
            1. Fetch all daily_news rows in window (published_at range, ALL categories)
            2. Two-pass cluster + select 12 context articles
            3. For each selected article WITH embedding → match_articles (historical)
               For articles WITHOUT embedding → skip historical step, include as text only
            4. Compress articles for prompt
            5. Stream to MiMo-V2-Flash → synthesis prose
            6. Store result in trend_briefs (with TTL) — only on full completion
            7. Stream SSE back to frontend
  → Frontend renders Trend Brief card (streaming prose + source list)
  → AbortController fires on next window change → cancels inflight fetch
    → req.signal propagated to Groq fetch (kills upstream generation quickly)
    → Catch AbortError: log { event, duration_ms, chars_streamed }, return 499
```

---

## Article Selection — Two-Pass Clustering

Runs entirely in Deno memory. Embeddings fetched in one SQL query alongside the articles.

```
effectiveTarget = Math.min(totalArticles, 12)

PASS 1 — Group into clusters
  // engagement fallback: likes → votes → score → 0; tiebreak by published_at DESC
  for each article (sorted by engagement DESC, published_at DESC):
    find cluster representative with cosine_similarity > 0.82
    if found → add to that cluster
    if not found → create new cluster (this article is the representative)
  → result: list of { representative, members[], clusterSize }

PASS 2 — Allocate slots (clusters sorted by clusterSize DESC)
  dominantCap = Math.ceil(effectiveTarget × 0.40)   // clusters >= 20% of total
  mediumCap   = Math.ceil(effectiveTarget × 0.20)   // clusters >= 5% of total
  smallCap    = 1                                    // all others

  for each cluster:
    threshold = clusterSize / totalArticles
    calculatedCap = threshold >= 0.20 ? dominantCap
                  : threshold >= 0.05 ? mediumCap
                  : smallCap
    allocatedSlots = Math.min(clusterSize, calculatedCap)
    pick top-N articles from cluster by engagement
    add to selected[]
    break when selected.length == effectiveTarget
```

---

## Historical Enrichment

For each of the 12 selected articles that has a non-null embedding:
- Call `match_articles` RPC with `match_threshold: 0.82`, `match_count: 5`
- In the Edge Function, filter out results whose `published_at` falls within the current window date range (the existing RPC has no date filter parameter — exclusion happens post-query)
- Deduplicate across all queries (same article may surface for multiple seeds)
- Result: 5–10 historical articles with titles, dates, and first summary bullet

Articles without embeddings (recently ingested, < 30 min old) contribute to the LLM context as current-window text but do not seed historical retrieval. This is correct behavior — breaking news appears in the brief even before the embedding pipeline catches up.

---

## Token Budget

| Content | Format sent | ~Tokens |
|---|---|---|
| 12 current articles | title + all 3 summary bullets | ~2,000 |
| 5–8 historical articles | title + date + bullet 1 only | ~400 |
| System prompt | — | ~300 |
| **Total input** | | **~2,700** |
| Output (synthesis) | prose ~400–600 words | ~550 |
| **Grand total** | | **~3,250** |

`article_content` is never sent — summaries are purpose-built for this.

---

## Prompt Design

```
SYSTEM:
You are a ruthless, high-conviction senior technology analyst writing for a sophisticated, time-poor audience. You cut through industry hype to identify structural shifts, asymmetric risks, and changing leverage.

You have been given a set of articles from [date range] plus historically related articles for context.

Your task: Write a unified, highly critical trend analysis (3–5 paragraphs) that answers the "So What?" of this news cycle. 

1. The Structural Shift: Do not just summarize what happened. Extract the underlying shift in power, capital, or architecture. Who is gaining leverage? What bottleneck is being bypassed or created?
2. The "So What" Test: For every trend identified, you must explicitly state why the reader should care. How does this change the strategic landscape? 
3. The Blast Radius: Map the second-order effects. Identify the non-obvious casualties, beneficiaries, or friction points in adjacent domains. 
4. Weak Signals & Skepticism: Highlight emerging details that contradict the mainstream narrative, or point out where the current hype ignores physical, economic, or regulatory reality.
5. Inline Citations: Every analytical claim must be grounded in the text. Cite sources inline using [N] notation where N matches the article index.
6. The Catalyst: End with a concrete "Watch For" conclusion. Identify the specific metric, upcoming event, or failure mode that will prove or disprove this trend in the near future.

IMPORTANT: If the articles do not form a cohesive structural trend, DO NOT force a narrative. Instead, identify the 2–3 most significant standalone stories, critically evaluate why they matter individually, and explicitly note the fragmentation of the current news cycle.

Style constraints: Dense, specific, opinionated, and skeptical. NO bullet points. NO introductory filler ("In recent news," "This is a significant development"). Write with the authority of an insider explaining the real stakes to a peer.

USER:
Current window articles [Mar 21–28, Industry]:
[1] title | Mar 28 | bullet1 | bullet2 | bullet3
[2] title | Mar 27 | ...
...

Historical context:
[13] title | Jan 15 | bullet1
[14] title | Dec 3  | bullet1
...
```

---

## DB Schema — trend_briefs

```sql
CREATE TABLE trend_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_date   date        NOT NULL,
  step_days     integer     NOT NULL,
  synthesis     text        NOT NULL,
  sources_json  jsonb       NOT NULL,  -- [{id, title, published_at, is_historical, index}]
  model         text        NOT NULL,
  tokens_used   integer,               -- null on abort; set on successful completion
  generated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL   -- generated_at + interval '6 hours'
);

CREATE INDEX ON trend_briefs (anchor_date, step_days, expires_at);
```

Cache key: `(anchor_date, step_days)` where `expires_at > now()`. No category column — one brief covers all categories for a given window.

Cache invalidation: TTL only (6h). A **Refresh button** on the card lets the user force regeneration — showing the `generated_at` timestamp makes staleness visible without automated invalidation complexity.

Feishu digest generates its own independent brief at 17:00 UTC — it does NOT read from this table.

---

## Frontend — Trend Brief Card

Position: placed **below the filter tag and above the article list** within the main feed area, **only when the "All" category tab is active**. The brief synthesizes across all categories; it is intentionally hidden on the Industry, Frontier, and Career tabs to avoid wasting tokens on per-category generations — the brief is a cross-cutting view, not a per-category view.

```
┌─────────────────────────────────────────────────────┐
│ TREND BRIEF · Mar 21–28               2h ago  ↻     │
│                                                     │
│ "The AI inference cost war is accelerating faster   │
│  than most analysts predicted. OpenAI's 80% API     │
│  price cut [1] follows Groq's $1B raise [13] from   │
│  January — both signals pointing to the same        │
│  conclusion: commoditization is now the dominant    │
│  competitive strategy..."                           │
│                                                     │
│ ▼ Sources (8 articles)                              │
│   [1] OpenAI cuts API prices · Mar 28               │
│   [2] Mistral raises $1B · Mar 25                   │
│   ...                                               │
│   [13] Groq raises $640M · Jan 15  ← historical    │
└─────────────────────────────────────────────────────┘
```

**Expand/collapse behaviour:**
- **Default: expanded.** The full synthesis is visible when the user arrives on a window. This is the primary reading experience.
- **User can collapse** by clicking/tapping the header row. Collapsed state shows only the header line — date range + "TREND BRIEF" label + the ↻ refresh icon. No synthesis text, no sources.
- Collapse state is **session-local** — reopening the app resets to expanded. No persistence needed.

```
EXPANDED (default):
┌─────────────────────────────────────────────────────┐
│ TREND BRIEF · Mar 21–28               2h ago  ↻  ▲  │  ← click to collapse
│                                                     │
│ "The AI inference cost war is accelerating..."      │
│                                                     │
│ ▼ Sources (8 articles)                              │
│   [1] OpenAI cuts API prices · Mar 28               │
│   ...                                               │
└─────────────────────────────────────────────────────┘

COLLAPSED (user-dismissed):
┌─────────────────────────────────────────────────────┐
│ TREND BRIEF · Mar 21–28               2h ago  ↻  ▼  │  ← click to expand
└─────────────────────────────────────────────────────┘
```

States:
- **Loading (cache miss):** expanded skeleton card with "Synthesizing [window]…" label, streaming text appears progressively
- **Loaded (cache hit):** renders instantly expanded, shows `generated_at` age + refresh button
- **Refreshing:** skeleton state, previous synthesis hidden, card stays expanded
- **Rate limited (429 from Groq):** "Rate limited — try again in a moment" inline message inside expanded card, no crash
- **Error:** "Unable to generate brief" with retry option inside expanded card
- **No articles in window:** card hidden entirely
- **Sub-category tab active (Industry / Frontier / Career):** card hidden entirely — not rendered, no API call made

Source list: collapsed by default within the expanded card, expandable. Historical articles marked visually (muted date label).

---

## embed-batch — One-Line Change

```
// Before
embedding=is.null&select=id,summary,article_content&limit=45

// After
embedding=is.null&select=id,summary,article_content&order=ingested_at.desc,id.desc&limit=45
```

Recency-first ensures recently ingested articles are embedded before older backlog. The `id DESC` tiebreaker makes the sort deterministic within same-timestamp batch inserts.

---

## Observability / Logging

```ts
// Successful completion
console.log(JSON.stringify({
  event: 'brief_generated',
  duration_ms, tokens_used,  // from include_usage: true final chunk
  source_count, historical_count,
  anchor_date, step_days,
}))

// Client disconnected (AbortError)
console.log(JSON.stringify({
  event: 'client_disconnected',
  duration_ms, chars_streamed,
  anchor_date, step_days,
}))

// Rate limited by Groq
console.log(JSON.stringify({
  event: 'rate_limited_429',
  anchor_date, step_days,
}))
```

Signal propagation: pass `signal: req.signal` to the downstream Groq fetch. Catch `AbortError` explicitly and return HTTP 499. Write to `trend_briefs` only after the stream completes fully — never on abort.

---

## Known Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| 5–10s first-visit latency | User waits on cache miss | Streaming + skeleton state makes wait feel active; cache eliminates on repeat visits |
| Embedding pipeline lag | Breaking news (< 30 min) gets no historical enrichment | Graceful degradation — article still appears in synthesis as text |
| Binary similarity threshold (0.82) | Soft connections just below threshold missed | Acceptable for v1; threshold tunable |
| No guaranteed causal reasoning | LLM may miss subtle cross-domain links or invent weak ones | Escape-hatch prompt + inline citations let user audit |
| TTL-only cache invalidation | Brief may be stale if major news breaks mid-TTL | Refresh button + visible timestamp gives user control |
| Larger article pool per window | More articles to cluster means effectiveTarget=12 draws from richer but noisier set | Clustering + engagement sort handles this; 12 cap keeps LLM context clean |
