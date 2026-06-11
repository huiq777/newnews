# Social Source Coverage Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore and harden source coverage for the current WeChat, Reddit, and YouTube source names without replacing the existing source list.

**Architecture:** Keep `sources` as the registry of truth, recover the exact active source names/URLs through an idempotent SQL migration, and make ingestion tolerant at the source boundary. `ingest-rss` remains the owner of RSS-like WeChat/Reddit plus lightweight YouTube freshness; `ingest-youtube-transcripts` remains the authoritative depth path for YouTube transcripts through Apify.

**Tech Stack:** Supabase Postgres SQL, Cloudflare Worker TypeScript, Supabase Edge Function Deno/TypeScript, shared JavaScript helpers, Node `node:test`.

---

## Evidence From Investigation

- Reddit RSS returned `403` with plain `curl -L https://www.reddit.com/r/MachineLearning.rss`.
- Reddit RSS returned fresh Atom entries with a descriptive `User-Agent`; sample entries included June 1-3, 2026 timestamps.
- WeChat `wechat2rss.xlab.app` feeds returned HTTP 200 XML from local probing, so stale WeChat is either upstream bridge freshness, worker deployment/runtime, or duplicate suppression, not an obvious URL typo.
- YouTube handle pages are reachable and expose channel IDs, but parsing any first `UC...` from the full page is noisy because related channels appear in the payload.
- `ingest-youtube-transcripts` currently maps Apify items only when `item.inputChannelUrl` exactly equals `sources.rss_url`; valid Apify output can be dropped when Apify emits a channel URL, handle URL with trailing slash, or equivalent casing.
- The user explicitly wants to recover all current names and remembers YouTube depth is through Apify. Therefore: do not replace current YouTube rows with RSS-only feeds; use RSS only as a freshness fallback.

## File Structure

- Create: `supabase/functions/_shared/social-source.js`
  - Shared URL normalization, feed headers, YouTube source alias generation, and stored channel ID extraction.
- Modify: `workers/ingest-rss/src/index.ts`
  - Use shared feed headers for Reddit/RSS bridge fetches.
  - Prefer stored `sources.metadata.channel_id` for YouTube feed resolution.
  - Log source type/name with fetch failures.
- Modify: `supabase/functions/ingest-youtube-transcripts/index.ts`
  - Normalize Apify `inputChannelUrl` before matching sources.
  - Match against aliases from `rss_url`, `metadata.youtube_handle`, and `metadata.channel_id`.
  - Log unmatched YouTube input URLs instead of silently losing them.
- Create: `supabase/sql/20260604_social_source_coverage_recovery.sql`
  - Idempotently upsert the current source names and URLs from the user-provided coverage table.
  - Add metadata for fetch modes, current YouTube channel IDs, and Apify depth ownership.
  - Include verification queries.
- Create: `tests/social-source.test.mjs`
  - Unit test shared URL normalization, YouTube alias matching, and headers.
- Modify: `docs/instructions.md`
  - Add the recovery migration, deploy order, Apify depth check, and coverage verification SQL.
- Modify: `docs/current-state.md`
  - Update the source coverage status after implementation.

## Task 1: Shared Social Source Helpers

**Files:**
- Create: `supabase/functions/_shared/social-source.js`
- Test: `tests/social-source.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/social-source.test.mjs`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const modulePath = process.env.SOCIAL_SOURCE_MODULE ?? '../supabase/functions/_shared/social-source.js'
const {
  FEED_HEADERS,
  extractYouTubeChannelId,
  normalizeSocialSourceUrl,
  youtubeSourceAliases,
} = await import(modulePath)

describe('social source helpers', () => {
  it('sends a descriptive user agent for Reddit and bridge feeds', () => {
    assert.match(FEED_HEADERS['User-Agent'], /^web:LinkXCapitalNews:v1\.0/)
    assert.match(FEED_HEADERS.Accept, /application\/atom\+xml/)
  })

  it('normalizes equivalent YouTube source URLs', () => {
    assert.equal(
      normalizeSocialSourceUrl('https://www.youtube.com/@DwarkeshPatel/'),
      'youtube:@dwarkeshpatel',
    )
    assert.equal(
      normalizeSocialSourceUrl('https://youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA/'),
      'youtube:channel:UCXl4i9dYBrFOabk0xGmbkRA',
    )
    assert.equal(
      normalizeSocialSourceUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCcefcZRL2oaA_uBNeo5UOWg'),
      'youtube:channel:UCcefcZRL2oaA_uBNeo5UOWg',
    )
  })

  it('builds source aliases from current metadata', () => {
    const aliases = youtubeSourceAliases({
      rss_url: 'https://www.youtube.com/@DwarkeshPatel',
      metadata: {
        youtube_handle: '@DwarkeshPatel',
        channel_id: 'UCXl4i9dYBrFOabk0xGmbkRA',
      },
    })

    assert.ok(aliases.has('youtube:@dwarkeshpatel'))
    assert.ok(aliases.has('youtube:channel:UCXl4i9dYBrFOabk0xGmbkRA'))
  })

  it('extracts channel IDs from page payloads and feed URLs', () => {
    assert.equal(
      extractYouTubeChannelId('window["ytCommand"]={"browseEndpoint":{"browseId":"UCcefcZRL2oaA_uBNeo5UOWg"}}'),
      'UCcefcZRL2oaA_uBNeo5UOWg',
    )
    assert.equal(
      extractYouTubeChannelId('https://www.youtube.com/feeds/videos.xml?channel_id=UChpleBmo18P08aKCIgti38g'),
      'UChpleBmo18P08aKCIgti38g',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/social-source.test.mjs
```

Expected: FAIL because `supabase/functions/_shared/social-source.js` does not exist.

- [ ] **Step 3: Create the shared helper**

Create `supabase/functions/_shared/social-source.js`:

```js
export const FEED_HEADERS = {
  'User-Agent': 'web:LinkXCapitalNews:v1.0 (source coverage recovery; contact: ops@linkx.capital)',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
}

export function extractYouTubeChannelId(value) {
  if (!value) return null
  const text = String(value).replace(/\\u0026/g, '&').replace(/\\"/g, '"')
  return text.match(/[?&]channel_id=(UC[a-zA-Z0-9_-]{20,})/)?.[1] ??
    text.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,})/)?.[1] ??
    text.match(/"browseEndpoint":\{"browseId":"(UC[a-zA-Z0-9_-]{20,})"/)?.[1] ??
    text.match(/"channelId":"(UC[a-zA-Z0-9_-]{20,})"/)?.[1] ??
    text.match(/"externalId":"(UC[a-zA-Z0-9_-]{20,})"/)?.[1] ??
    text.match(/itemprop=["']channelId["'][^>]+content=["'](UC[a-zA-Z0-9_-]{20,})["']/i)?.[1] ??
    null
}

export function normalizeSocialSourceUrl(value) {
  if (!value) return ''
  const raw = String(value).trim()
  const channelId = extractYouTubeChannelId(raw)
  if (channelId) return `youtube:channel:${channelId}`

  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    const pathname = url.pathname.replace(/\/+$/, '')

    if (host === 'youtube.com' || host === 'youtu.be') {
      const handle = pathname.match(/^\/@([^/]+)$/)?.[1]
      if (handle) return `youtube:@${handle.toLowerCase()}`
    }

    url.hash = ''
    url.search = ''
    url.hostname = host
    url.pathname = pathname || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    const handle = raw.match(/^@?([A-Za-z0-9._-]+)$/)?.[1]
    return handle ? `youtube:@${handle.toLowerCase()}` : raw.toLowerCase()
  }
}

export function getYouTubeChannelId(source) {
  return source?.metadata?.channel_id ??
    source?.metadata?.youtube_channel_id ??
    extractYouTubeChannelId(source?.rss_url ?? '')
}

export function youtubeSourceAliases(source) {
  const aliases = new Set()
  const rssUrl = source?.rss_url ?? ''
  const metadata = source?.metadata ?? {}

  for (const value of [
    rssUrl,
    metadata.youtube_handle,
    metadata.handle,
    metadata.channel_url,
    metadata.apify_start_url,
    metadata.source_page,
  ]) {
    const normalized = normalizeSocialSourceUrl(value)
    if (normalized) aliases.add(normalized)
  }

  const channelId = getYouTubeChannelId(source)
  if (channelId) {
    aliases.add(`youtube:channel:${channelId}`)
    aliases.add(normalizeSocialSourceUrl(`https://www.youtube.com/channel/${channelId}`))
    aliases.add(normalizeSocialSourceUrl(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`))
  }

  return aliases
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test tests/social-source.test.mjs
```

Expected: PASS for `social source helpers`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/social-source.js tests/social-source.test.mjs
git commit -m "test: add social source normalization helpers"
```

## Task 2: Harden `ingest-rss` Fetching

**Files:**
- Modify: `workers/ingest-rss/src/index.ts`
- Test: `tests/social-source.test.mjs`

- [ ] **Step 1: Import shared helpers**

In `workers/ingest-rss/src/index.ts`, add imports below the existing official-source import:

```ts
import {
  FEED_HEADERS,
  extractYouTubeChannelId as extractYouTubeChannelIdFromShared,
  getYouTubeChannelId,
} from '../../../supabase/functions/_shared/social-source.js'
```

- [ ] **Step 2: Extend `SourceRow.metadata`**

Replace the `metadata` type in `SourceRow` with:

```ts
  metadata?: {
    trust_tier?: string
    organization?: string
    fetch_mode?: string
    dedupe_priority?: number
    channel_id?: string
    youtube_channel_id?: string
    youtube_handle?: string
    handle?: string
    channel_url?: string
    apify_start_url?: string
    source_page?: string
  } | null
```

- [ ] **Step 3: Fetch XML feeds with headers**

Replace `fetchXmlFeed` with:

```ts
async function fetchXmlFeed(url: string) {
  const res = await fetch(url, { headers: FEED_HEADERS })
  if (!res.ok) throw new Error(`Feed fetch failed ${res.status}`)
  const xml = await res.text()
  return parseRSS(xml)
}
```

- [ ] **Step 4: Prefer stored YouTube channel IDs**

Replace the first line of `fetchYouTubeFeed` with:

```ts
  const channelId = getYouTubeChannelId(source) ?? await resolveYouTubeChannelId(source.rss_url)
```

Keep the rest of `fetchYouTubeFeed` intact.

- [ ] **Step 5: Use shared channel ID extraction in the local fallback**

Replace the body of `extractYouTubeChannelId` with:

```ts
  return extractYouTubeChannelIdFromShared(text)
```

- [ ] **Step 6: Improve failure logs**

Inside the scheduled `catch`, replace:

```ts
          console.error(`Failed: ${source.rss_url}`, e)
```

with:

```ts
          console.error(`Failed source=${source.name} type=${source.source_type} url=${source.rss_url}`, e)
```

- [ ] **Step 7: Run tests**

Run:

```bash
node --test tests/social-source.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add workers/ingest-rss/src/index.ts
git commit -m "fix: harden social RSS feed fetching"
```

## Task 3: Tolerant YouTube Apify Transcript Matching

**Files:**
- Modify: `supabase/functions/ingest-youtube-transcripts/index.ts`
- Test: `tests/social-source.test.mjs`

- [ ] **Step 1: Import shared helpers**

At the top of `supabase/functions/ingest-youtube-transcripts/index.ts`, below the `serve` import, add:

```ts
import {
  normalizeSocialSourceUrl,
  youtubeSourceAliases,
} from '../_shared/social-source.js'
```

- [ ] **Step 2: Extend the source lookup**

Replace the source lookup URL:

```ts
`${SUPABASE_URL}/rest/v1/sources?source_type=eq.youtube&is_active=eq.true&select=id,name,rss_url`,
```

with:

```ts
`${SUPABASE_URL}/rest/v1/sources?source_type=eq.youtube&is_active=eq.true&select=id,name,rss_url,metadata`,
```

Replace the source type:

```ts
const sources: { id: string; name: string; rss_url: string }[] = await sourceRes.json()
```

with:

```ts
const sources: { id: string; name: string; rss_url: string; metadata?: Record<string, unknown> | null }[] = await sourceRes.json()
```

- [ ] **Step 3: Replace exact URL maps with alias maps**

Replace:

```ts
  console.log(`Known sources (${sources.length}): ${sources.map(s => s.rss_url).join(' | ')}`)
  const sourceByUrl = new Map(sources.map(s => [s.rss_url, s.id]))
  const sourceNameByUrl = new Map(sources.map(s => [s.rss_url, s.name]))
```

with:

```ts
  console.log(`Known YouTube sources (${sources.length}): ${sources.map(s => `${s.name}=${s.rss_url}`).join(' | ')}`)
  const sourceByAlias = new Map<string, { id: string; name: string; canonicalUrl: string }>()
  for (const source of sources) {
    for (const alias of youtubeSourceAliases(source)) {
      sourceByAlias.set(alias, { id: source.id, name: source.name, canonicalUrl: source.rss_url })
    }
  }
```

- [ ] **Step 4: Replace known-source filtering**

Replace:

```ts
  const sourceOk = urlOk.filter(i => sourceByUrl.has(i.inputChannelUrl!))
  console.log(`Filter stages: total=${items.length} type=video:${typeOk.length} hasUrl:${urlOk.length} knownSource:${sourceOk.length}`)
  const validItems = sourceOk
```

with:

```ts
  const sourceOk = urlOk
    .map(item => ({ item, source: sourceByAlias.get(normalizeSocialSourceUrl(item.inputChannelUrl!)) }))
    .filter((row): row is { item: ApifyItem; source: { id: string; name: string; canonicalUrl: string } } => Boolean(row.source))
  const unmatched = urlOk
    .filter(item => !sourceByAlias.has(normalizeSocialSourceUrl(item.inputChannelUrl!)))
    .map(item => item.inputChannelUrl)
  console.log(`Filter stages: total=${items.length} type=video:${typeOk.length} hasUrl:${urlOk.length} knownSource:${sourceOk.length}`)
  if (unmatched.length > 0) {
    console.log(`Unmatched YouTube inputChannelUrls: ${[...new Set(unmatched)].slice(0, 10).join(' | ')}`)
  }
  const validItems = sourceOk
```

- [ ] **Step 5: Adjust URL dedup inputs**

Replace:

```ts
  const allUrls    = validItems.map(item => item.url)
  const knownUrls  = await fetchKnownUrls(allUrls, SUPABASE_URL, sbHeaders)
  const newItems   = validItems.filter(item => !knownUrls.has(item.url))
```

with:

```ts
  const allUrls    = validItems.map(row => row.item.url)
  const knownUrls  = await fetchKnownUrls(allUrls, SUPABASE_URL, sbHeaders)
  const newItems   = validItems.filter(row => !knownUrls.has(row.item.url))
```

- [ ] **Step 6: Adjust row mapping**

Replace:

```ts
  const rows = newItems.map(item => {
```

with:

```ts
  const rows = newItems.map(({ item, source }) => {
```

Replace:

```ts
    const channelUrl = item.inputChannelUrl!
    return {
      source_id:   sourceByUrl.get(channelUrl)!,
      url:         item.url,
      raw_content: transcript,
      fetched_at:  new Date().toISOString(),
      status:      'pending',
      metadata:    { likes: item.likes ?? 0, show_name: sourceNameByUrl.get(channelUrl) ?? item.channelName ?? '' },
      published_at: item.date ?? null,
    }
```

with:

```ts
    return {
      source_id:   source.id,
      url:         item.url,
      raw_content: transcript,
      fetched_at:  new Date().toISOString(),
      status:      'pending',
      metadata:    {
        likes: item.likes ?? 0,
        show_name: source.name || item.channelName || '',
        input_channel_url: item.inputChannelUrl ?? null,
        source_page: source.canonicalUrl,
      },
      published_at: item.date ?? null,
    }
```

- [ ] **Step 7: Run tests**

Run:

```bash
node --test tests/social-source.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/ingest-youtube-transcripts/index.ts
git commit -m "fix: match apify youtube sources by normalized aliases"
```

## Task 4: Recover Current Source Rows

**Files:**
- Create: `supabase/sql/20260604_social_source_coverage_recovery.sql`

- [ ] **Step 1: Create the migration**

Create `supabase/sql/20260604_social_source_coverage_recovery.sql`:

```sql
-- 20260604 — Social source coverage recovery
-- Purpose:
--   Recover the current WeChat, Reddit, and YouTube source names exactly as
--   provided by the production coverage audit. YouTube transcript depth remains
--   owned by Apify via ingest-youtube-transcripts; ingest-rss only provides
--   lightweight channel freshness.

insert into public.sources (name, rss_url, source_type, is_active, category, metadata)
values
  (
    'Reddit r/layoffs',
    'https://www.reddit.com/r/layoffs.rss',
    'reddit',
    true,
    'career_community',
    jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'content_scope', jsonb_build_array('layoffs', 'career_community', 'workforce'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Reddit r/cscareerquestions',
    'https://www.reddit.com/r/cscareerquestions.rss',
    'reddit',
    true,
    'career_community',
    jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'content_scope', jsonb_build_array('career_advice', 'job_market', 'community'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Reddit r/MachineLearning',
    'https://www.reddit.com/r/MachineLearning.rss',
    'reddit',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'content_scope', jsonb_build_array('research', 'technical_discussion', 'community'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Founder Park',
    'https://wechat2rss.xlab.app/feed/e95ec80ad542565f0eeaf02a42c6d021a7ae51bc.xml',
    'wechat',
    true,
    'industry',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('startup', 'ai_industry', 'founders'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '机器之心',
    'https://wechat2rss.xlab.app/feed/51e92aad2728acdd1fda7314be32b16639353001.xml',
    'wechat',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('ai_research', 'models', 'technical_news'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '新智元',
    'https://wechat2rss.xlab.app/feed/ede30346413ea70dbef5d485ea5cbb95cca446e7.xml',
    'wechat',
    true,
    'industry',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('ai_industry', 'models', 'china_ai'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '量子位',
    'https://wechat2rss.xlab.app/feed/7131b577c61365cb47e81000738c10d872685908.xml',
    'wechat',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('ai_research', 'technical_news', 'china_ai'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '极客公园',
    'https://wechat2rss.xlab.app/feed/1a5aec98e71c707c8ca092bc2c255b9d4bac477d.xml',
    'wechat',
    true,
    'industry',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('technology_business', 'startups', 'ai_industry'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Y Combinator',
    'https://www.youtube.com/@ycombinator',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@ycombinator',
      'channel_id', 'UCcefcZRL2oaA_uBNeo5UOWg',
      'apify_start_url', 'https://www.youtube.com/@ycombinator',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Sam Witteveen AI',
    'https://www.youtube.com/@samwitteveenai',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@samwitteveenai',
      'channel_id', 'UC55ODQSvARtgSyc8ThfiepQ',
      'apify_start_url', 'https://www.youtube.com/@samwitteveenai',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Dwarkesh Patel',
    'https://www.youtube.com/@DwarkeshPatel',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@DwarkeshPatel',
      'channel_id', 'UCXl4i9dYBrFOabk0xGmbkRA',
      'apify_start_url', 'https://www.youtube.com/@DwarkeshPatel',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Matt Wolfe',
    'https://www.youtube.com/@mreflow',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@mreflow',
      'channel_id', 'UChpleBmo18P08aKCIgti38g',
      'apify_start_url', 'https://www.youtube.com/@mreflow',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'No Priors Podcast',
    'https://www.youtube.com/@NoPriorsPodcast',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@NoPriorsPodcast',
      'channel_id', 'UCSI7h9hydQ40K5MJHnCrQvw',
      'apify_start_url', 'https://www.youtube.com/@NoPriorsPodcast',
      'coverage_recovered_at', '2026-06-04'
    )
  )
on conflict (rss_url) do update
set
  name = excluded.name,
  source_type = excluded.source_type,
  is_active = excluded.is_active,
  category = excluded.category,
  metadata = coalesce(public.sources.metadata, '{}'::jsonb) || excluded.metadata;

-- Ensure older Reddit rows are handled by ingest-rss, not the historical JSON path.
update public.sources
set source_type = 'reddit',
    is_active = true,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'coverage_recovered_at', '2026-06-04'
    )
where name in ('Reddit r/layoffs', 'Reddit r/cscareerquestions', 'Reddit r/MachineLearning');

-- Verification: current source registry.
select name, source_type, rss_url, is_active, category, metadata
from public.sources
where name in (
  'Reddit r/layoffs',
  'Reddit r/cscareerquestions',
  'Reddit r/MachineLearning',
  'Founder Park',
  '机器之心',
  '新智元',
  '量子位',
  '极客公园',
  'Y Combinator',
  'Sam Witteveen AI',
  'Dwarkesh Patel',
  'Matt Wolfe',
  'No Priors Podcast'
)
order by source_type, name;

-- Verification: post-deploy freshness. Run after ingest-rss has executed once.
select
  s.name,
  s.source_type,
  count(ri.id) filter (where ri.fetched_at > now() - interval '24 hours') as raw_24h,
  count(dn.id) filter (where dn.created_at > now() - interval '7 days') as articles_7d,
  max(ri.fetched_at) as newest_raw,
  max(dn.created_at) as newest_article
from public.sources s
left join public.raw_ingestion ri on ri.source_id = s.id
left join public.daily_news dn on dn.source_id = s.id
where s.is_active = true
  and s.source_type in ('wechat', 'reddit', 'youtube')
group by s.id, s.name, s.source_type
order by s.source_type, raw_24h asc, s.name;
```

- [ ] **Step 2: Apply migration**

Run the SQL file in Supabase SQL Editor or with the project’s usual migration path.

Expected:
- All 13 current names exist.
- All 13 are active.
- Reddit rows are `source_type='reddit'`.
- YouTube rows have `metadata.depth_mode='apify_transcript'` and `metadata.channel_id`.

- [ ] **Step 3: Commit**

```bash
git add supabase/sql/20260604_social_source_coverage_recovery.sql
git commit -m "fix: recover social source coverage rows"
```

## Task 5: Update Runbook Documentation

**Files:**
- Modify: `docs/instructions.md`
- Modify: `docs/current-state.md`

- [ ] **Step 1: Update `docs/instructions.md` under `ingest-rss`**

Add this block after the existing source coverage verification query:

```markdown
**Social source recovery:**
Run `supabase/sql/20260604_social_source_coverage_recovery.sql` before deploying `ingest-rss` when Reddit, WeChat, or YouTube rows are stale or missing. This preserves the current source names and stores YouTube channel IDs for deterministic Atom fallback.

Reddit RSS requires a descriptive `User-Agent`; plain anonymous requests can return `403`. If Reddit coverage drops again, test with:

```bash
curl -L -A 'web:LinkXCapitalNews:v1.0 (source coverage recovery; contact: ops@linkx.capital)' 'https://www.reddit.com/r/MachineLearning.rss'
```

YouTube depth comes from Apify through `ingest-youtube-transcripts`. The `ingest-rss` YouTube path is only a lightweight title/description fallback.
```

- [ ] **Step 2: Update `docs/current-state.md` social source notes**

Replace the stale social source notes with:

```markdown
- **Reddit/YouTube/WeChat coverage recovery:** `supabase/sql/20260604_social_source_coverage_recovery.sql` preserves the current 13 social source names. Reddit is fetched via RSS with a descriptive User-Agent. WeChat uses `wechat2rss.xlab.app` bridge URLs. YouTube stores channel IDs in `sources.metadata`; `ingest-rss` provides lightweight Atom freshness while Apify + `ingest-youtube-transcripts` remains the transcript-depth path.
```

- [ ] **Step 3: Commit**

```bash
git add docs/instructions.md docs/current-state.md
git commit -m "docs: document social source recovery flow"
```

## Task 6: Deploy And Verify

**Files:**
- No code changes.

- [ ] **Step 1: Run local tests**

Run:

```bash
node --test tests/social-source.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Deploy `ingest-rss`**

Run:

```bash
cd workers/ingest-rss
wrangler deploy
```

Expected: deployment succeeds and cron remains `0 * * * *`.

- [ ] **Step 3: Deploy `ingest-youtube-transcripts` without JWT verification**

Run:

```bash
supabase functions deploy ingest-youtube-transcripts --no-verify-jwt
```

Expected: deployment succeeds. The `--no-verify-jwt` flag is required because Apify posts with a custom Bearer token, not a Supabase JWT.

- [ ] **Step 4: Trigger `ingest-rss` once**

Run:

```bash
cd workers/ingest-rss
wrangler dev --remote --test-scheduled
```

In another terminal:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

Expected log patterns:
- `Reddit r/MachineLearning` fetches more than zero items.
- `Failed source=...` logs are absent for Reddit.
- YouTube fetches either zero items for channels with no recent uploads or positive lightweight Atom items.
- WeChat fetches XML items unless the upstream bridge feed itself is stale.

- [ ] **Step 5: Verify database coverage**

Run:

```sql
select
  s.name,
  s.source_type,
  count(ri.id) filter (where ri.fetched_at > now() - interval '24 hours') as raw_24h,
  count(dn.id) filter (where dn.created_at > now() - interval '7 days') as articles_7d,
  max(ri.fetched_at) as newest_raw,
  max(dn.created_at) as newest_article
from public.sources s
left join public.raw_ingestion ri on ri.source_id = s.id
left join public.daily_news dn on dn.source_id = s.id
where s.is_active = true
  and s.source_type in ('wechat', 'reddit', 'youtube')
group by s.id, s.name, s.source_type
order by s.source_type, raw_24h asc, s.name;
```

Expected after `ingest-rss` and `process-queue` have had time to run:
- Reddit `raw_24h > 0` for active subreddits with fresh RSS entries.
- WeChat `raw_24h > 0` only when the upstream `wechat2rss` feed has fresh entries; stale upstream bridge feeds should be recorded as an upstream issue, not a code failure.
- YouTube `raw_24h > 0` only if a channel published recently or Apify posted a transcript dataset.

- [ ] **Step 6: Verify Apify YouTube depth path**

Trigger the existing Apify actor configured with the five current channel URLs:

```text
https://www.youtube.com/@ycombinator
https://www.youtube.com/@samwitteveenai
https://www.youtube.com/@DwarkeshPatel
https://www.youtube.com/@mreflow
https://www.youtube.com/@NoPriorsPodcast
```

Expected `ingest-youtube-transcripts` log patterns:
- `Known YouTube sources (5): ...`
- `knownSource:` is greater than zero when the dataset contains videos from these channels.
- `Unmatched YouTube inputChannelUrls:` is absent or only lists channels outside the five current names.
- Inserted rows have `raw_ingestion.metadata->>'input_channel_url'` and `raw_ingestion.metadata->>'source_page'`.

## Rollback Plan

- SQL rollback for source metadata only:

```sql
update public.sources
set metadata = metadata - 'coverage_recovered_at'
where source_type in ('wechat', 'reddit', 'youtube');
```

- Code rollback:

```bash
git revert <commit-for-apify-normalized-aliases>
git revert <commit-for-ingest-rss-feed-headers>
git revert <commit-for-social-source-helper>
```

- Do not delete source rows during rollback. Set `is_active=false` only for an individual broken upstream bridge after confirming its RSS URL is stale or empty.

## Self-Review

- Spec coverage: The plan covers recovering current names, Reddit, WeChat, YouTube, and preserves Apify as YouTube depth.
- Placeholder scan: No unresolved placeholder text is present; every task has exact files, snippets, commands, and expected results.
- Type consistency: Shared helper names are consistent across tests, worker import, and Edge Function import.
