# Token Usage Reference

> Methodology: 1 token ≈ 4 English characters. Chinese characters ≈ 1.5 tokens each.
> All estimates are approximate. Actual usage varies by content length and Groq's internal tokenizer.
> Groq free tier hard limit: **100,000 tokens per day (TPD)**, resets at midnight UTC.

---

## All Groq API Calls in the Codebase

| Worker / Function | Purpose | Model | max_tokens | Temp | Input cap |
|---|---|---|---|---|---|
| `process-queue` — ARTICLE prompt | Bilingual title + 3-bullet summary | llama-3.3-70b-versatile | 900 | 0.1 | 24,000 chars of scraped content |
| `process-queue` — TWEET prompt | Tweet title + 3-bullet summary | llama-3.3-70b-versatile | 900 | 0.1 | 24,000 chars (tweets ~280) |
| `process-queue` — EN questions | 3 EN analytical questions | llama-3.3-70b-versatile | 300 | 0.7 | `summary_en` only |
| `process-queue` — ZH questions | 3 ZH analytical questions | llama-3.3-70b-versatile | 300 | 0.7 | `summary_zh` only |
| `ingest-builders` — bio extraction | Bio map JSON `{handle: "role"}` | llama-3.3-70b-versatile | 600 | 0 | All bios concatenated (~25 accounts) |
| `answer-question` — RAG answer | Streaming Q&A with RAG context | llama-3.3-70b-versatile | 1024 | 0.6 | article_content + 3 related articles (**no char limit**) |
| `refresh-questions` — EN | Regenerate 3 EN questions | llama-3.3-70b-versatile | 300 | 0.7 | `summary_en` |
| `refresh-questions` — ZH | Regenerate 3 ZH questions | llama-3.3-70b-versatile | 300 | 0.7 | `summary_zh` |

## All Cohere API Calls in the Codebase

| Worker / Function | Purpose | Model | input_type | Items/call | Input cap |
|---|---|---|---|---|---|
| `embed-batch` | Index articles for vector search | embed-english-v3.0 | `search_document` | Up to 45 | 2,000 chars/article |
| `answer-question` | Embed user question for RAG | embed-english-v3.0 | `search_query` | 1 | Raw question text |

---

## Per-Call Token Breakdown

### `process-queue` — Article path (per article)

**Call 1 — Summary (ARTICLE_SYSTEM_PROMPT)**

| Component | Chars | Tokens |
|---|---|---|
| `ARTICLE_SYSTEM_PROMPT` | ~1,400 | ~350 |
| User preamble: `"Summarize this article:\n\n"` | ~40 | ~10 |
| Content (average scraped article) | ~5,000 | ~1,250 |
| **Total input** | | **~1,610** |
| Output (3 bullets × 2-3 sentences each) | | **~530** |
| **Call 1 total** | | **~2,140** |

Content varies widely by source:
- TechCrunch / Ars / The Verge: 3,000–15,000 chars scraped → 750–3,750 tokens of content
- WeChat (bridge HTML, stripped): ~2,600–6,000 chars → 650–1,500 tokens
- Paywalled: falls back to RSS snippet ~200-500 chars → 50–125 tokens
- Hard cap at 24,000 chars = 6,000 tokens of content

**Call 2 — EN Questions**

| Component | Chars | Tokens |
|---|---|---|
| EN system prompt | ~200 | ~50 |
| User preamble + requirements | ~600 | ~150 |
| `summary_en` input | ~800 | ~200 |
| **Total input** | | **~400** |
| Output (3 questions × ~25 words) | | **~100** |
| **Call 2 total** | | **~500** |

**Call 3 — ZH Questions** (parallel with Call 2)

| Component | Chars | Tokens |
|---|---|---|
| ZH system prompt (Chinese) | ~250 | ~165 |
| User preamble (Chinese) | ~400 | ~265 |
| `summary_zh` input | ~900 | ~600 |
| **Total input** | | **~1,030** |
| Output (3 questions × ~20 Chinese chars) | | **~120** |
| **Call 3 total** | | **~1,150** |

> Note: Chinese prompts cost more tokens per character (~1.5× vs English).

**Article path total per item: ~3,790 tokens**
Range: ~2,600 (thin/paywalled) → ~8,000 (long-form article, 15K chars scraped)

---

### `process-queue` — Tweet path (per tweet)

**Call 1 — Summary (TWEET_SYSTEM_PROMPT)**

| Component | Chars | Tokens |
|---|---|---|
| `TWEET_SYSTEM_PROMPT` | ~1,450 | ~360 |
| User preamble | ~40 | ~10 |
| Tweet content (`@handle: tweet text`, ~300 chars) | ~300 | ~75 |
| **Total input** | | **~445** |
| Output (3 bullets, tweet-aware) | | **~450** |
| **Call 1 total** | | **~895** |

**Calls 2+3 — Questions** (identical structure to article path)

- EN call: ~500 tokens
- ZH call: ~1,150 tokens
- **Both calls combined: ~1,650 tokens**

**Tweet path total per item: ~2,545 tokens**
Range: ~1,800 (concise tweet, short output) → ~3,000 (quote-tweet with rich context)

---

### `ingest-builders` — Bio extraction (once per daily run at 6am UTC)

| Component | Chars | Tokens |
|---|---|---|
| System prompt | ~700 | ~175 |
| User message: 25× `@handle: bio text` (~100 chars/bio) | ~2,500 | ~625 |
| **Total input** | | **~800** |
| Output: 25 handle→role key-value pairs in flat JSON | ~750 | ~190 |
| **Daily total (1 call)** | | **~990 tokens** |

Scales linearly with number of tracked accounts. At 50 accounts: ~1,600 tokens.

---

### `answer-question` — Per user Q&A session (on-demand)

**Cohere embed step:** ~30 Cohere tokens (not Groq, not counted against TPD)

**Groq streaming call:**

| Component | Chars | Tokens |
|---|---|---|
| System prompt (EN or ZH) | ~200 | ~50 |
| Article title | ~200 | ~50 |
| `mainContext` (article_content avg 5,000 chars or summary ~800) | ~5,000 | ~1,250 |
| `relatedContext` (3 × title + summary, ~400 chars each) | ~1,200 | ~300 |
| User question | ~100 | ~25 |
| **Total input** | | **~1,675** |
| Output (detailed answer, ~400–600 words) | | **~530** |
| **Per session total** | | **~2,205 tokens** |

⚠️ **No character limit on `article_content` in `answer-question`.** A long-form scraped article (15,000 chars = 3,750 tokens) pushes this to **~5,500+ tokens per session** — same cost as processing a new article through the full pipeline.

---

### `refresh-questions` — Per article (on-demand)

Two parallel Groq calls (EN + ZH):

| Call | Input | Output | Total |
|---|---|---|---|
| EN: system (~30) + preamble (~100) + `summary_en` (~200) | ~330 | ~100 | ~430 |
| ZH: system (~40) + preamble (~130) + `summary_zh` (~240) | ~410 | ~110 | ~520 |
| **Both calls combined** | | | **~950 tokens** |

---

### `embed-batch` — Cohere only (zero Groq tokens)

| Metric | Value |
|---|---|
| Articles per run | Up to 45 |
| Input per article | 2,000 chars max (`article_content` preferred, else `summary`) |
| Total chars per full batch | 45 × 2,000 = 90,000 chars |
| Cohere tokens per full batch | ~22,500 |
| Schedule | Every 5 min (288 potential runs/day) |
| Effective runs with pending data | ~10–30/day as articles arrive |

Cohere free tier is generous for embedding. This is not a bottleneck.

---

## Daily Token Budget (Automated Pipeline)

These run automatically every day regardless of user activity.

| Source | New items/day | Tokens/item | Daily tokens |
|---|---|---|---|
| RSS articles — TechCrunch, Ars, Verge (scrapes well) | ~30 | ~3,790 | ~113,700 |
| WeChat articles — 5 sources (bridge content) | ~15 | ~3,200 | ~48,000 |
| Builder tweets — follow-builders feed-x.json | ~50 | ~2,545 | ~127,250 |
| Podcasts — feed-podcasts.json (~1 episode/day avg) | ~1 | ~5,000 (long transcript) | ~5,000 |
| Bio extraction — ingest-builders (1 call/day) | 1 run | ~990 fixed | ~990 |
| **TOTAL demand** | **~97 items** | | **~294,940 tokens** |

**⚠️ Demand exceeds the 100K TPD free tier by ~3×.**

The pipeline self-throttles naturally: `process-queue` hits 429, increments `retry_count`, rows stay `pending` and are retried next day. Only ~35–45 items process before the daily ceiling is hit.

---

## Practical Daily Throughput Within 100K TPD

| Content mix | Items processed | Tokens consumed |
|---|---|---|
| All tweets only (lightest) | ~39 | ~99,255 |
| All articles only (heaviest, long-form) | ~26 | ~98,540 |
| All podcasts only | ~20 | ~100,000 |
| Typical mixed day (25% articles, 75% tweets) | ~10 articles + ~28 tweets | ~109,010 ← slight overage |
| Conservative mixed day (20% articles, 80% tweets) | ~8 articles + ~32 tweets | ~112,000 ← moderate overage |

In practice, `retry_count` absorbs the overflow — articles that don't get processed today are retried tomorrow.

---

## On-Demand Token Cost (User Activity)

These happen only when the app is actively used. Each on-demand call competes with the automated pipeline for the same 100K TPD budget.

| Action | Tokens/session | Groq "equivalent cost" |
|---|---|---|
| Ask a question (`answer-question`) | ~2,205 | ≈ 1.3 tweet summaries |
| Refresh questions on 1 article | ~950 | ≈ 0.6 tweet summaries |
| Ask a question on a long article (15K chars) | ~5,500 | ≈ 3.3 tweet summaries |

**Estimated typical daily on-demand usage:**

| Action | Sessions/day | Daily tokens |
|---|---|---|
| `answer-question` Q&A | 5 | ~11,025 |
| `refresh-questions` | 3 | ~2,850 |
| **On-demand total** | | **~13,875** |

**Combined daily total (automated + on-demand): ~308,815 demand vs 100K cap**

On-demand calls firing during the day reduce how many articles process-queue can handle. If you ask 10 questions in a session (~22,050 tokens), that's equivalent to preventing ~13 tweet summaries from being processed.

---

## TPD Ceiling: When It Hits and What Happens

**When:** process-queue returns Groq 429 (rate limit exceeded).

**What happens:**
1. The `catch` block in `processArticle()` increments `retry_count`
2. Row stays `pending` (if retry_count < 3) or becomes `error` (if ≥ 3)
3. No article content written to `daily_news` for that run
4. Next 15-min cycle picks up remaining `pending` rows — immediately hits 429 again until midnight UTC

**TPD resets at midnight UTC.** After reset, process-queue resumes automatically.

**Recovery SQL (for stuck `processing` rows — run anytime after midnight):**
```sql
UPDATE raw_ingestion
SET status = 'pending', retry_count = 0, last_error = NULL
WHERE status = 'processing' AND processed_at IS NULL;
```

**⚠️ Do NOT bulk-reset `error` rows without checking `last_error` first.** Some errors are genuine failures (empty content, paywalls) — resetting them wastes TPD retrying unprocessable content.

**Diagnosing TPD hits:**
```sql
SELECT status, last_error, COUNT(*)
FROM raw_ingestion
WHERE last_error LIKE '%429%' OR last_error LIKE '%rate limit%'
GROUP BY status, last_error;
```

---

## Stage 4.5 Impact: Apify Tweets (6 Curated Handles)

Adding 6 handles × 15 tweets/day via Apify:

| Metric | Value |
|---|---|
| New tweets/day | 6 × 15 = 90 |
| Tokens/tweet | ~2,545 |
| Additional daily Groq demand | ~228,950 tokens |
| New total daily demand | ~523,890 tokens (~5.2× TPD cap) |

This accelerates how quickly the 100K TPD ceiling is reached each day. With Apify tweets added, the pipeline will process fewer RSS articles before hitting the limit.

**Mitigation options (in order of impact):**

| Option | Savings | Tradeoff |
|---|---|---|
| Cap `contentForGroq` at 8,000 chars (from 24,000) | ~500 tokens/article | Slightly shorter context for long articles |
| Reduce question generation to EN only | ~1,100 tokens/item | Lose ZH questions |
| Reduce `process-queue` batch size from 5 to 3 | 40% fewer items/run, slower throughput | No token savings per item — just paces spending |
| Upgrade to Groq paid tier (~$0.10/1M tokens) | Removes TPD cap entirely | ~$0.03/day at current volume |

---

## Quick Reference: Cost Per Action

| Action | Groq tokens | % of daily TPD |
|---|---|---|
| Process 1 RSS article (avg) | ~3,790 | 3.8% |
| Process 1 RSS article (long-form) | ~8,000 | 8.0% |
| Process 1 tweet | ~2,545 | 2.5% |
| Process 1 podcast episode | ~5,000 | 5.0% |
| 1 Q&A session (avg article) | ~2,205 | 2.2% |
| 1 Q&A session (long article) | ~5,500 | 5.5% |
| 1 question refresh | ~950 | 0.95% |
| Daily bio extraction (ingest-builders) | ~990 | 1.0% |
| Full day automated pipeline (current) | ~294,940 demand | 295% of cap |
| Full day automated pipeline (post-4.5) | ~523,890 demand | 524% of cap |
