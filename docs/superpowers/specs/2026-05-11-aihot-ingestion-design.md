# Design Plan: AIHot Ingestion Source

## Context
The developer wants to ingest AI news from [aihot.virxact.com](https://aihot.virxact.com/agent). The site aggregates curated AI news (models, products, papers, industry, tips) with bilingual titles (Chinese + English). It provides a public REST API — no auth required.

The goal is to integrate this source into the existing pipeline with minimal subrequest and TPD overhead.

---

## Architecture Decision: REST API over RSS
Choose `/api/public/items` REST API, not the RSS feed.

| Factor | RSS `/feed/all.xml` | REST API `/api/public/items` |
|---|---|---|
| Code changes | Zero — just add DB row | ~80 lines in ingest-builders |
| Incremental fetch | No — full feed every poll | Yes — `since` parameter, only new items |
| Metadata richness | title, description, pubDate | + `title_en`, `category`, `source` (original outlet) |
| Dedup strategy | URL `ON CONFLICT` (reactive) | `since` window (proactive) + URL fallback |
| Pagination | Feed truncation (unknown limit) | Cursor-based, deterministic |
| Subrequest cost | +1/hr (ingest-rss, hourly) | +3/day max (ingest-builders, daily) |

The `since` parameter means we only fetch items published since the last run. The richer metadata (`title_en`, `category`, `source`) flows through to `daily_news` via a new metadata JSONB column (see below).

---

## Capacity Check (Mandatory per architect-role.md)
**1. New cron trigger?** No. Added to existing `ingest-builders` (daily 6am UTC). 4/5 triggers remain.

**2. Daily Groq token cost?** Estimated 20–40 new items/day × ~1,500 tokens (summaries are short, ~200 chars). All routed through TokenRouter (primary) → OpenRouter (secondary) → Groq (tertiary). Net Groq TPD impact: near-zero under normal load.

**3. Subrequest budget (ingest-builders)?** Currently 38/50. Adding AIHot:
- +1 for `MAX(published_at)` Supabase query (stateful cursor)
- +1 for `/api/public/items` page 1
- +1 for `/api/public/items` page 2 (if hasNext=true)
Max new total: **41/50**. Within limit.

**4. Data through `raw_ingestion`?** Yes. All items flow through `raw_ingestion` with `status: 'pending'`.

**5. Failure mode?** If API returns 429/503: log error, skip source, function continues with other sources. No rows inserted, no stuck state. Items absent for that day — acceptable; recovered next run via stateful cursor (see below).

---

## Field Mapping
REST API response item → `raw_ingestion` row:

```json
{
  "source_id": "src.id",
  "url": "item.url",
  "raw_content": "item.title\\n\\nitem.summary",
  "status": "pending",
  "metadata": {
    "title_en": "item.title_en ?? null",
    "category": "item.category",
    "source": "item.source",
    "aihot_id": "item.id"
  },
  "published_at": "item.publishedAt"
}
```
`raw_content` follows the `title\n\nbody` pattern used by arXiv and Nowcoder. The LLM in `process-queue` sees the Chinese title + summary and produces its own EN/ZH summary pair.

---

## Metadata Bridge: raw_ingestion → daily_news

**Problem:** `daily_news` has no `metadata` column. `process-queue` only maps `raw_ingestion.metadata` → `daily_news.engagement` (social signals). Without a fix, `title_en`, `category`, and `source` die in the queue and never reach the frontend.

**Fix:** Schema migration + process-queue update.

### Migration
```sql
ALTER TABLE daily_news ADD COLUMN IF NOT EXISTS metadata JSONB;
```
No default value, no NOT NULL — fully backward compatible. Existing rows get NULL.

### process-queue change
When `source.source_type === 'aihot'`, pass `raw_ingestion.metadata` through to `daily_news.metadata`:

```javascript
// existing engagement mapping (unchanged)
const engagement = buildEngagement(source.source_type, rawRow.metadata)

// new: pass-through metadata for sources that carry editorial metadata
const rowMetadata = source.source_type === 'aihot' ? rawRow.metadata : null

// daily_news insert (add metadata field)
{ ...existingFields, engagement, metadata: rowMetadata }
```
This is a conditional pass-through. No other source types are affected.

---

## Stateful since Cursor
**Problem:** `since = now - 25h` is a hardcoded window. If `ingest-builders` fails or is paused for >25h, that gap is permanently lost.

**Fix:** Query `MAX(published_at)` from `raw_ingestion` for this source before fetching:

```javascript
// 1. Look up aihot source row
const src = sources.find(s => s.source_type === 'aihot')

// 2. Query last ingested published_at (+1 subrequest via REST API)
// GET /rest/v1/raw_ingestion?source_id=eq.{src.id}&select=published_at&order=published_at.desc&limit=1

// 3. Use cursor, or fall back to 25h ago on first run
const since = cursor?.published_at
  ? new Date(cursor.published_at).toISOString()
  : new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
```

---

## Fetch Logic (in ingest-builders)
`since` = `MAX(published_at)` for aihot source, or `now - 25h` (first run)
`url` = `https://aihot.virxact.com/api/public/items?mode=selected&take=50&since={since}`

```text
Loop (max 2 pages, bounds subrequests to +2):
  fetch page
  if 429 or 503: log, break (skip source this run, recovered next run via cursor)
  collect items
  if hasNext and page < 2: fetch nextCursor page
  else: stop

Insert all collected items with ON CONFLICT (url) DO NOTHING
```

---

## Prompt Security
`raw_content` goes in the `user` role inside `process-queue` — already enforced by existing prompt structure. The 24,000 char truncation cap applies; AIHot summaries are ~200 chars. No new injection surface beyond existing RSS/Reddit sources. Same sanitization posture.

---

## Critical Files to Modify

| File | Change |
|---|---|
| `workers/ingest-builders/src/index.ts` | Add `fetchAIHot()` function + call in main handler. Remember to add `aihot` to the `in.()` source fetch query. |
| `supabase/functions/process-queue/index.ts` | Add `metadata` field to daily_news insert; conditional pass-through for `source_type='aihot'` |
| New Supabase SQL migration | `ALTER TABLE daily_news ADD COLUMN IF NOT EXISTS metadata JSONB` |
| `sources` table | Insert one row (`source_type='aihot'`) manually or via migration |

---

## Verification

1. **Local**: Trigger `ingest-builders` manually via `wrangler dev`, confirm rows in `raw_ingestion` with correct field mapping and `source_type='aihot'`.
2. **Subrequest count**: Confirm total ≤ 41/50 from worker logs.
3. **Dedup**: Run twice; second run inserts 0 new rows.
4. **Metadata bridge**: After `process-queue` runs, confirm `daily_news.metadata` contains `{title_en, category, source, aihot_id}`.
5. **Cursor recovery**: Set `published_at` of last AIHot row to 48h ago, re-run — confirm items from the 48h window are fetched and inserted.
6. **429 path**: Mock a 429 response, confirm worker continues processing other sources and exits cleanly.
7. **Existing rows**: Confirm `daily_news.metadata IS NULL` for all non-AIHot rows (no regression).
