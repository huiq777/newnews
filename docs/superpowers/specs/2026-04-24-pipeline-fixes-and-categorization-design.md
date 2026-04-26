# Pipeline Fixes (arXiv, Reddit, Nowcoder) + ICLR + Per-Article Categorization

## Context

User confirmed via Supabase inspection:

- **arXiv:** ingestion fetches title + full abstract correctly, but `process-queue` flags it as `INSUFFICIENT_CONTENT` and never lets it into `daily_news`.
- **Reddit / Nowcoder:** ingestion stores **only the post title** in `raw_content`. With nothing else, the LLM correctly returns `INSUFFICIENT_CONTENT`. The fix is upstream — fetch real content (and ideally comments) at ingest time.
- The earlier hypothesis about `NOT_AI_RELEVANT` filtering does not apply here. This is purely a content-availability bug.

This spec covers three fixes plus two new-feature designs (Q2 ICLR, Q3 per-article categorization). Q1 splits cleanly into Q1.1 (arXiv threshold) and Q1.2 (Reddit/Nowcoder content fetch).

---

## Q1.1 — arXiv: Adjust the `INSUFFICIENT_CONTENT` Rule

### Diagnosis

[supabase/functions/process-queue/index.ts:55–58](../../../supabase/functions/process-queue/index.ts#L55-L58):

> "INSUFFICIENT_CONTENT — Use when: the article text contains less than 200 words of actual content after stripping navigation, ads, and boilerplate."

arXiv abstracts run **150–250 words** typically. The 200-word threshold is borderline by design — a paywall stub of 150 words would correctly fail, but a complete 180-word arXiv abstract fails for the wrong reason. The threshold treats "short" as a proxy for "stub," but for academic abstracts, short *is* the full unit.

### Design

The cleanest fix is **type-aware framing in the prompt**, not a global threshold change. Lowering 200→100 globally would let in real paywall stubs across RSS sources. Instead, condition the rule on `source_type`.

**Two options:**

**Option A (preferred): Pass `source_type` into the prompt context, override the rule for academic sources.**

In `process-queue`, when constructing the user message, prepend a one-line context header:

```
SOURCE_TYPE: arxiv
CONTENT_KIND: This content is the title and abstract of an academic paper. The abstract IS the article — do not flag as INSUFFICIENT_CONTENT based on length alone. Treat any abstract of 50+ words as sufficient.
```

For all other source types, omit this header — default 200-word rule applies. Token cost: ~30 prompt tokens per arXiv article. Net delta against 100K cap: trivial. Existing behavior preserved for RSS/WeChat/tweets.

This pattern composes naturally with Q3 (passing `category` into the prompt) — same plumbing, same place in the code.

**Option B (simpler, cruder): Drop the global threshold to 20 words.**

Documented as a viable fallback. 20 words is below any genuinely meaningful article — even a thin paywall stub typically runs 30–60 words — so this avoids Option B's original "lets in 100-word stubs" problem. The trade-off vs. Option A: it removes the source-aware prompt seam that Q3 wants to reuse, so picking B alone leaves Q3 to build that seam from scratch.

Architect-recommended choice: **Option A**. Option B remains as a documented safety net if the source-type plumbing in Option A turns out fragile in practice.

### Acceptance Check

After deploy, run:
```sql
SELECT s.name, COUNT(*) AS arxiv_articles_in_daily_news
FROM daily_news dn JOIN sources s ON s.id=dn.source_id
WHERE s.source_type='arxiv' AND dn.created_at > now() - interval '7 days'
GROUP BY s.name;
```
Expect: nonzero for both `arXiv cs.AI` and `arXiv cs.LG` within 24 hours of fix.

### Backfill (NFR-Bounded)

Existing arXiv rows in `raw_ingestion` are marked `done` (LLM responded with `INSUFFICIENT_CONTENT`). A naive re-queue of all of them would push 100K–400K tokens through Groq in one wave — the TPD cap is a **daily** quota with no "quiet window," so an unbounded backfill would crater the entire `process-queue` pipeline for the rest of the day.

**Required mitigation: bound the backfill on both axes.**

Default (preferred) — restrict to recent rows only:

```sql
UPDATE raw_ingestion ri
SET status = 'pending', last_error = NULL, retry_count = 0
FROM sources s
WHERE ri.source_id = s.id AND s.source_type = 'arxiv'
  AND ri.status = 'done'
  AND ri.created_at > now() - interval '3 days'   -- NFR bound: last 3 days only
  AND NOT EXISTS (SELECT 1 FROM daily_news dn WHERE dn.raw_ingestion_id = ri.id);
```

If older rows need recovery, run **batched** instead:

```sql
WITH batch AS (
  SELECT ri.id FROM raw_ingestion ri JOIN sources s ON s.id=ri.source_id
  WHERE s.source_type='arxiv' AND ri.status='done'
    AND NOT EXISTS (SELECT 1 FROM daily_news dn WHERE dn.raw_ingestion_id = ri.id)
  ORDER BY ri.fetched_at DESC
  LIMIT 15                                       -- NFR bound: ≤15 rows per manual run
)
UPDATE raw_ingestion SET status='pending', last_error=NULL, retry_count=0
WHERE id IN (SELECT id FROM batch);
```

Each batch ≈ 30K tokens, well under the 100K cap, leaving room for the day's normal ingestion. Re-run on subsequent days until the backlog is cleared.

**Do not run an unbounded backfill in one shot.**

---

## Q1.2 — Reddit & Nowcoder: Fetch Real Content (and Comments Where Possible)

### Diagnosis

[workers/ingest-builders/src/index.ts:622–636](../../../workers/ingest-builders/src/index.ts#L622-L636) — Reddit branch stores only `title`:
```ts
raw_content: `r/${post.subreddit}: ${post.title}`,
```
Even for self-text posts where `post.selftext` contains the actual question/discussion (often 200–1000 words), it's discarded.

[workers/ingest-builders/src/index.ts:560–566](../../../workers/ingest-builders/src/index.ts#L560-L566) — Nowcoder branch stores only `title`:
```ts
newRows.push({ source_id: nowcoderSource.id, url, raw_content: item.title, ... })
```
The hot-list endpoint only returns headlines. To get content, a per-post detail call is needed.

Note: per [docs/current-state.md:175–177](../../current-state.md#L175-L177), Reddit was migrated to `source_type='rss'` (handled by `ingest-rss`), not via the JSON branch in `ingest-builders`. **Confirm the current `source_type` setting** before deciding which file to edit:

```sql
SELECT name, source_type, rss_url FROM sources WHERE name LIKE 'Reddit%' OR name = 'Nowcoder Hot';
```

If Reddit rows are `source_type='rss'`, the bug is in `ingest-rss` extracting only `<title>` from Reddit's RSS (the `<description>` is sparse for many subreddits and `<content:encoded>` is often absent). If `source_type='reddit'`, the bug is in `ingest-builders`.

### Design — Reddit

**Recommend: move Reddit ingestion fully into `ingest-builders` (`source_type='reddit'`) using the JSON API**, and enrich the row to include selftext.

The historical reason for switching to RSS (CF IP block on `reddit.com/.json`) is worth re-validating — Reddit blocks heavy scrapers but accepts traffic with a real `User-Agent`. The current code uses `'NewsProject/1.0'`, which is exactly the kind of UA Reddit rate-limits or rejects. Use a descriptive UA like `web:NewsProject:v1.0 (by /u/<your_username>)` per Reddit's API guidelines — they explicitly document this format. If that still 403s, fall back to RSS with enhanced extraction.

**Updated row shape (single source change in [ingest-builders/src/index.ts:606–637](../../../workers/ingest-builders/src/index.ts#L606-L637)):**

```ts
const titleLine = `r/${post.subreddit}: ${post.title}`
const bodyLine  = post.is_self && post.selftext ? `\n\n${post.selftext}` : ''
const raw_content = titleLine + bodyLine
```

For most r/cscareerquestions and r/layoffs posts (90%+ self-posts with substantial bodies), this yields content well above the 200-word threshold. For link posts, the URL already points to the underlying article, which `process-queue`'s scraper handles.

**Comments — defer.** Adding top-N comments per post would mean: 3 subreddits × 25 posts × 1 fetch = 75 added subrequests. `ingest-builders` is at 38/50 → 113/50, breaks the budget hard. Two paths if comments become important later:

1. Fetch comments only for the top 5 posts per subreddit (3 × 5 = 15 added → 53/50, still over).
2. Move Reddit/Nowcoder ingestion into a Supabase Edge Function (no subrequest cap) — separate spec.

Recommend punting comments to a follow-up spec. The selftext fix alone closes the visibility gap for the majority of posts.

**Sort dimension:** also worth swapping `/hot.json` → `/top.json?t=day` so we get yesterday's top conversation, not real-time hot (which churns minute-to-minute and the daily 06:00 UTC cron misses most of it). Same subrequest count.

### Design — Nowcoder

The hot-list endpoint returns titles only. Each post detail requires a per-post API call. Limit count to stay under budget.

**Endpoint discovery (SWE task):** the Nowcoder app calls one of these patterns for post detail (verify by inspecting network tab):
- Type 74 (feed): `https://gw-c.nowcoder.com/api/sparta/feed/main/detail?uuid={uuid}`
- Discussion: `https://gw-c.nowcoder.com/api/sparta/discuss-pc/detail?discussId={id}`

**Updated flow in `ingest-builders`:**

1. Fetch hot list (1 subrequest, current behavior).
2. Take **top 5** items (cut from 20 — see budget below).
3. For each, call detail API in parallel (5 subrequests).
4. Extract `data.content` (the post body) from the detail response. Store as `raw_content: title + '\n\n' + content`.

**Failure mode:** if any per-post detail call returns 4xx/5xx, fall back to `raw_content: title` for that one item — process-queue will then mark it `INSUFFICIENT_CONTENT`, which is the current state. No regression for failed details.

**Comments — defer**, same reasoning as Reddit. If Nowcoder comments are wanted later, it's the same Edge Function migration.

### Combined Subrequest Audit (NFR-Bounded)

Operating at >90% of the 50-subrequest cap is architecturally unsafe — the chunked dedup query is variable (it scales with incoming item volume), and a momentary spike in Reddit/Nowcoder/podcast volume can push past 50. When CF Workers exceed the subrequest cap they crash mid-execution, leaving rows stuck in `processing` (per [docs/keep-in-mind.md](../../keep-in-mind.md)). That's silent data loss.

**Required headroom: ≤45/50.**

| Stage | Current | Proposed |
|---|---|---|
| Builder tweets + bio extract | 4 | 4 |
| Podcasts | 1 | 1 |
| GitHub Trending | 1 | 1 |
| Product Hunt | 1 | 1 |
| Nowcoder hot list | 1 | 1 |
| **Nowcoder per-post details** | 0 | **5** (top 5) |
| arXiv (cs.AI + cs.LG) | 2 | 2 |
| Reddit (3 subreddits) | 0 (RSS path) or 3 (JSON path) | 3 |
| Bulk INSERT | 1 | 1 |
| Bulk dedup query (chunked, variable) | ~25 | ~25 |
| **Total** | ~36/50 | **~44/50** |

44/50 leaves ~6 subrequests of buffer for variable dedup growth — within tolerance.

**Future expansion** (Q2 ICLR, comments, additional sources) requires either:
- Refactoring the chunked dedup to fewer subrequests (e.g., a single RPC that takes a URL array), or
- Migrating `ingest-builders` to a Supabase Edge Function (no subrequest cap).

Either is a separate spec. For now: ship at 44/50 with the top-5 Nowcoder cap as the hard constraint.

### Acceptance Check

```sql
SELECT s.name,
       COUNT(*) FILTER (WHERE length(ri.raw_content) > 500)  AS substantive,
       COUNT(*) FILTER (WHERE length(ri.raw_content) <= 200) AS title_only
FROM raw_ingestion ri JOIN sources s ON s.id=ri.source_id
WHERE s.name LIKE 'Reddit%' OR s.name = 'Nowcoder Hot'
GROUP BY s.name;
```
Expect: `substantive` to dominate after fix; before fix, `title_only` is essentially the whole population.

---

## Q2 — ICLR / OpenReview Source (Deferred)

ICLR papers live on **OpenReview**, not arXiv. Public JSON API, no auth.

- New `source_type='openreview'` (TEXT enum-as-comment, no migration needed).
- One `sources` row: `name='ICLR 2026'`, `rss_url='https://api.openreview.net/notes?invitation=ICLR.cc/2026/Conference/-/Submission&details=replyCount&sort=number:asc&limit=20'`, `metadata={'venue':'ICLR','year':2026}`.
- New branch in `ingest-builders` mirroring the arXiv branch: extract `id`, `content.title.value`, `content.abstract.value`, `cdate`. URL: `https://openreview.net/forum?id=<id>`. `raw_content`: title + abstract.
- **Verify endpoint first** — ICLR 2026 invitation may not be open yet; if so, start with `ICLR.cc/2025/Conference`.

**Token cost:** abstracts are ~150–250 words (same shape as arXiv). Combined with Q1.1 fix, these will land in `daily_news` correctly. Capped at 20 papers per run, daily token spend ≈ 30K — significant but bounded.

**Subrequest impact:** +1 per OpenReview source. Even after the Nowcoder top-5 trim (44/50), adding ICLR pushes to 45/50 with no headroom for an active ICLR submission window. Per the headroom NFR (≤45/50 with buffer), **ICLR cannot land in the CF Worker** — it requires the Edge Function migration first.

**Decision:** Defer ICLR (Spec D) until `ingest-builders` is migrated to a Supabase Edge Function. Do not add ICLR to the Cloudflare Worker.

---

## Q3 — Per-Article Categorization

Today: `sources.category` is per-source. WeChat sources are pinned (Founder Park = always `industry`) regardless of article content.

### Architectural Constraint: PostgREST Cannot OR Across Foreign Tables

An earlier draft of this spec proposed a **read-time fallback** in the frontend: `query.or('category.eq.X,and(category.is.null,sources.category.eq.X)')`. **This is invalid.** PostgREST (Supabase's REST layer) does not support `or` filters that span a foreign-table join — the request returns `400 Bad Request: failed to parse filter string`.

The fix is to materialize the fallback at **write time**, in `process-queue`, so `daily_news.category` is always populated and the frontend filter collapses to a clean `eq`.

### Schema

```sql
ALTER TABLE daily_news
  ADD COLUMN category TEXT NOT NULL DEFAULT 'industry'
  CHECK (category IN ('industry','technical_frontier','career_community'));
ALTER TABLE daily_news ALTER COLUMN category DROP DEFAULT;  -- keep NOT NULL after backfill
CREATE INDEX idx_daily_news_category ON daily_news (category);
```

The temporary DEFAULT exists only so the `NOT NULL` constraint can be added against an existing populated table; after the column is in place and a one-time backfill runs (`UPDATE daily_news SET category = sources.category FROM sources WHERE daily_news.source_id = sources.id`), drop the default so future inserts must supply the value explicitly.

### Prompt

The categorization rule must follow the existing prompt style in [process-queue/index.ts:25–80](../../../supabase/functions/process-queue/index.ts#L25-L80) — every rule has a definition + WHY + BAD/GOOD examples + FAILURE MODE. A bare three-line definition list (which an earlier draft used) does not match how `INSUFFICIENT_CONTENT` and `NOT_AI_RELEVANT` are written, and produces lower-quality output because the model has no exemplars to anchor on.

Add to `ARTICLE_SYSTEM_PROMPT` immediately after the `QUESTIONS_ZH` line, before `BILINGUAL RULES`:

```
CATEGORY: [Output exactly one of: industry | technical_frontier | career_community. Pick the dominant frame of the article — what makes this newsworthy. If two categories tie, pick the one closer to the actor in the title.]

CATEGORY DEFINITIONS:

1. industry — Company strategy, funding rounds, M&A, product launches by labs/vendors, regulation/policy, market share dynamics, leadership changes at AI orgs.
   WHY: This is the "who's winning, who's spending, who's regulating" lane. The reader is tracking the AI ecosystem as a market and power structure.
   GOOD: "Anthropic Cuts API Prices 80%, Targeting OpenAI's Enterprise Customers" → industry (pricing strategy by a named vendor against named competitor)
   GOOD: "Accel筹集50亿美元资金，重点布局后期AI软件与机器人领域" → industry (VC fund close + thesis)
   GOOD: "EU AI Act Phase 2 Enforcement Begins, GPAI Providers Face €35M Fines" → industry (regulation with concrete penalty)
   BAD: "Researchers at Anthropic publish paper on circuit tracing" → NOT industry, this is technical_frontier (research output, not corporate strategy)
   FAILURE MODE: Defaulting every article that mentions a company name to industry. The substitution test: if you removed the company and replaced with a research result, would the story still hold? If yes → technical_frontier. If the story collapses without the company actor, → industry.

2. technical_frontier — Research papers, new model architectures, training breakthroughs, benchmark advances, capability evaluations, novel datasets, agentic-system research.
   WHY: This is the "what's now possible that wasn't last week" lane. The reader is tracking the capability frontier and how it moves.
   GOOD: "DeepSeek-V4 Hits 92% on SWE-bench Verified, Beating Claude Opus 4 by 6 Points" → technical_frontier (benchmark result on a research-relevant task)
   GOOD: "Anthropic Publishes Circuit Tracing Method, Identifies 50K Features in Claude 3 Sonnet" → technical_frontier (interpretability research output)
   GOOD: "ICLR 2026 Submission: Mixture-of-Depths Reduces Transformer FLOPs 40%" → technical_frontier (architecture research)
   BAD: "OpenAI Hires Former Meta VP to Lead Research" → NOT technical_frontier, this is industry (leadership/strategy, no capability claim)
   BAD: "Cursor adds Claude Sonnet 4.6 to its model picker" → NOT technical_frontier, this is industry (product integration, not capability research)
   FAILURE MODE: Routing every paper-shaped article here even if its content is a corporate announcement dressed up as research. If the headline number is a price or a funding round, it is not technical_frontier regardless of who published it.

3. career_community — Hiring/layoffs at AI orgs, comp data, interview prep, career advice from practitioners, community/culture stories (developer relations, conference recaps, online discourse threads), early-career and student-facing content.
   WHY: This is the "what does this mean for me as a person working in or entering AI" lane. The reader is asking job-market and skill-positioning questions.
   GOOD: "OpenAI Lays Off 200 from Applied AI Team, 60% of Cuts in San Francisco" → career_community (workforce impact, geography-specific)
   GOOD: "r/cscareerquestions: New-grad ML PhD offers from FAANG drop 35% YoY, base comp flat" → career_community (job-market data from community)
   GOOD: "Karpathy: 90% of AI courses teach the wrong things — 3 alternatives I recommend" → career_community (career advice from a practitioner)
   BAD: "Meta cuts AI infra costs 30% via custom inference stack" → NOT career_community even though jobs exist behind the cuts; the news is the cost-engineering story, not the workforce → industry
   BAD: "DeepMind paper: agents trained on developer interview transcripts solve 23% more LeetCode" → NOT career_community despite the topic, this is a research result → technical_frontier
   FAILURE MODE: Putting any article that mentions hiring or jobs in career_community. The test: is the workforce/career angle the dominant frame, or is it a side detail? If the headline number is workforce-side (layoff count, comp number, hiring spike), → career_community. If the headline number is product or research, route to that lane instead.
```

Mirror the same block into `TWEET_SYSTEM_PROMPT` with tweet-shaped GOOD examples (e.g., `@sama: ...`, `@karpathy: ...`).

### Parser & Write-Time Fallback

`process-queue` claims rows via the `claim_pending_batch` RPC at [supabase/functions/process-queue/index.ts:567–576](../../../supabase/functions/process-queue/index.ts#L567-L576). Today the RPC returns `id, source_id, url, raw_content, published_at, metadata` from `raw_ingestion` only — `sources.category` and `sources.source_type` are not joined.

**Required RPC change:** extend `claim_pending_batch` to return joined source fields:

```sql
-- inside claim_pending_batch, after the FOR UPDATE SKIP LOCKED claim
RETURNING ri.id, ri.source_id, ri.url, ri.raw_content, ri.published_at, ri.metadata,
          s.category AS source_category,
          s.source_type AS source_type
-- (joining sources s ON s.id = ri.source_id)
```

If the RPC body cannot return joined columns directly (Postgres function return-type limitations), the alternative is a follow-up `SELECT category, source_type FROM sources WHERE id IN (...)` keyed on the just-claimed source_ids — adds zero subrequests inside the Edge Function (the Edge runtime has no subrequest cap).

**Validation + fallback in TS** (one helper near `parseJsonSection`):

```ts
const ALLOWED_CATEGORIES = ['industry', 'technical_frontier', 'career_community'] as const
type Category = typeof ALLOWED_CATEGORIES[number]

function isValidCategory(v: unknown): v is Category {
  return typeof v === 'string' && (ALLOWED_CATEGORIES as readonly string[]).includes(v)
}

const parsedCategory = parseSection(llmOutput, 'CATEGORY')
const finalCategory: Category = isValidCategory(parsedCategory)
  ? parsedCategory
  : (article.source_category as Category)  // guaranteed by sources.category NOT NULL
```

`finalCategory` then flows into the `daily_news` INSERT alongside the existing fields. Because every `sources` row already has a `category`, the fallback is total — `daily_news.category` is always populated, `NOT NULL` holds, no row ever lands without a category.

### Frontend Filter (post-fix)

[news-app/App.tsx:175–176](../../../news-app/App.tsx#L175-L176) collapses to:

```ts
if (activeCategory !== 'all') {
  query = query.eq('category', activeCategory)
}
```

No `or`, no foreign-table join inside the filter, no PostgREST limitation hit. Single index lookup on `idx_daily_news_category`.

### Composes with Q1.1

Both fixes route through the same prompt-context layer (passing `source_type` into the prompt for Q1.1, emitting `CATEGORY` from the prompt for Q3). Same code seam, same RPC extension — Q1.1 already needs `source_type` from the join, Q3 needs `category` from the same join. **Implement the RPC change once and both specs consume it.**

### Token Cost

~30 prompt tokens + ~5 response tokens per article. Negligible delta against 100K cap.

### Failure Mode

LLM emits invalid CATEGORY (or omits the field entirely) → write-time fallback substitutes `sources.category` → row inserts cleanly with the per-source category. No NULL state in `daily_news`, no frontend coalescing, no data loss. The fallback is silent by design — invalid model output is a normal, expected condition, not an error.

---

## Recommended Sequencing — Architect-Ratified

Specs A, B, C are **cleared for SWE implementation** with the NFR mitigations baked in above:

1. **Spec A — arXiv threshold fix.** Source-type-aware prompt seam (Option A). Requires extending `claim_pending_batch` RPC to return `source_type`. Backfill must use the 3-day window OR the `LIMIT 15` batched form. Unbounded backfill is rejected.
2. **Spec B — Reddit selftext + Nowcoder details.** Nowcoder capped at top 5 (not 10) to maintain ≤45/50 subrequest headroom.
3. **Spec C — Per-article categorization.** Schema (`NOT NULL`, CHECK, index) + prompt block (WHY/BAD/GOOD/FAILURE MODE matching existing style) + write-time fallback in `process-queue` + simplified frontend `eq` filter. Requires the same `claim_pending_batch` RPC change as Spec A (joined `source_category`).
4. **Spec D — ICLR/OpenReview: deferred** until `ingest-builders` is migrated to a Supabase Edge Function. Do not add to the Cloudflare Worker.

A and C share the RPC extension — implement that change once. B is independent (different file, different worker) and can land in parallel.

---

## Verification (Pre-Implementation)

1. Confirm Reddit `source_type` (RSS vs. reddit branch) — query above.
2. Inspect Nowcoder detail API by hitting one URL manually:
   ```bash
   curl -s 'https://gw-c.nowcoder.com/api/sparta/discuss-pc/detail?discussId=<some_id>' | head -c 500
   ```
   Confirm response shape and field name for content body before locking the parser logic.
3. Verify Reddit JSON API still 403s with naive UA, succeeds with `web:NewsProject:v1.0 (by /u/<user>)`:
   ```bash
   curl -s -A 'web:NewsProject:v1.0 (by /u/<user>)' 'https://www.reddit.com/r/cscareerquestions/top.json?t=day&limit=3' | head -c 400
   ```
4. Confirm OpenReview ICLR 2026 invitation exists or fall back to 2025:
   ```bash
   curl -s 'https://api.openreview.net/notes?invitation=ICLR.cc/2026/Conference/-/Submission&limit=1'
   ```
5. After Spec A deploys: re-run the arXiv `daily_news` count query above and the backfill SQL.
6. After Spec B deploys: re-run the Reddit/Nowcoder content-length query above.
7. After Spec C deploys: confirm `SELECT COUNT(*) FROM daily_news WHERE category IS NULL` returns 0; spot-check ten rows where the LLM-emitted CATEGORY differs from `sources.category` (per-article override is working) and ten where they match (fallback is working).

---

## Critical Files

- [docs/architect-role.md](../../architect-role.md)
- [docs/schema.md](../../schema.md) — `source_type` list, `daily_news` schema (target for `category` column)
- [docs/current-state.md](../../current-state.md) — Reddit RSS migration, cron slot count
- [supabase/functions/process-queue/index.ts:55–80](../../../supabase/functions/process-queue/index.ts#L55-L80) — `INSUFFICIENT_CONTENT` and `NOT_AI_RELEVANT` rules (style template for Q3 CATEGORY block)
- [supabase/functions/process-queue/index.ts:567–576](../../../supabase/functions/process-queue/index.ts#L567-L576) — `claim_pending_batch` RPC call site (target for joined `source_type`/`source_category` extension)
- `claim_pending_batch` RPC definition (in Supabase SQL editor, not in repo) — must be updated to return joined source fields
- [workers/ingest-builders/src/index.ts:560–566](../../../workers/ingest-builders/src/index.ts#L560-L566) — Nowcoder title-only insert
- [workers/ingest-builders/src/index.ts:606–637](../../../workers/ingest-builders/src/index.ts#L606-L637) — Reddit JSON branch (currently dead code if Reddit is `source_type='rss'`)
- [workers/ingest-rss/src/index.ts:80–89](../../../workers/ingest-rss/src/index.ts#L80-L89) — RSS `<description>`/`<content:encoded>` extraction (relevant if Reddit stays on RSS)
- [news-app/App.tsx:175–176](../../../news-app/App.tsx#L175-L176) — current source-category filter
