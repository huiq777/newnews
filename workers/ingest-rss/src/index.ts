import {
  canonicalizeUrl,
  chooseDedupeWinner,
  classifyContentTypeHint,
  computeFingerprint,
  computeSimilarity,
  scoreUsableContent,
} from '../../../supabase/functions/_shared/official-source.js'
import {
  FEED_HEADERS,
  extractYouTubeChannelId as extractYouTubeChannelIdFromShared,
  getYouTubeChannelId,
  redditFeedUrlCandidates,
} from '../../../supabase/functions/_shared/social-source.js'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

type SourceRow = {
  id: string
  name: string
  rss_url: string
  source_type: string
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
}

type FeedItem = {
  source_id: string
  source_name: string
  source_url: string
  source_type: string
  source_metadata?: SourceRow['metadata']
  url: string
  title: string
  content: string
  published_at: string | null
  metadata?: Record<string, unknown> | null
}

const MAX_NEW_OFFICIAL_ITEMS_PER_SOURCE = 1
const MAX_FEED_ITEMS_PER_SOURCE = 30
const MAX_OFFICIAL_FEED_ITEMS_PER_SOURCE = 30
const FRONTEND_WHEEL_MAX_DAYS = 30

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return new Response('ingest-rss worker is running')
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Get active sources
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&source_type=in.(rss,wechat,official_rss,reddit,youtube)&select=id,name,rss_url,source_type,metadata`,
      { headers: SB(env) }
    )
    const sources: SourceRow[] = await sourcesRes.json()
    console.log(`Fetching ${sources.length} sources`)

    // 2. Fetch all RSS-like feeds in parallel. YouTube source rows store channel
    // handles, so they need a lightweight handle -> channel feed fallback.
    const feedResults = await Promise.all(
      sources.map(async (source) => {
        try {
          const items = source.source_type === 'youtube'
            ? await fetchYouTubeFeed(source)
            : source.source_type === 'reddit'
              ? await fetchRedditFeed(source.rss_url)
              : await fetchXmlFeed(source.rss_url, source.source_type === 'official_rss'
                ? MAX_OFFICIAL_FEED_ITEMS_PER_SOURCE
                : MAX_FEED_ITEMS_PER_SOURCE)
          console.log(`${source.rss_url}: ${items.length} items`)
          return { source, items }
        } catch (e) {
          console.error(`Failed source=${source.name} type=${source.source_type} url=${source.rss_url}`, e)
          return { source, items: [] }
        }
      })
    )

    // 3. Insert all items in parallel — duplicates silently skipped
    const allItems: FeedItem[] = feedResults.flatMap(({ source, items }) =>
      items.map(item => ({
        source_id: source.id,
        source_name: source.name,
        source_url: source.rss_url,
        source_type: source.source_type,
        source_metadata: source.metadata,
        ...item,
      }))
    )

    const scopedItems = await limitOfficialItemsToWheel(env, allItems)
    const dedupedItems = await suppressBatchDuplicates(scopedItems)
    const rows = await Promise.all(dedupedItems.map(toRawIngestionRow))
    if (rows.length === 0) {
      console.log(`Done. Attempted ${allItems.length} inserts, all suppressed or empty.`)
      return
    }

    const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?on_conflict=url`, {
      method: 'POST',
      headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
      body: JSON.stringify(rows),
    })
    if (!insertRes.ok) {
      const err = await insertRes.text()
      console.error(`Batch insert failed ${insertRes.status}: ${err.substring(0, 500)}`)
    }

    console.log(`Done. Attempted ${rows.length}/${allItems.length} inserts after official recency limits and batch dedupe.`)
  },
}

function parseRSS(xml: string, maxItems = MAX_FEED_ITEMS_PER_SOURCE): { url: string; title: string; content: string; published_at: string | null }[] {
  const items: { url: string; title: string; content: string; published_at: string | null }[] = []
  // Support both RSS <item> and Atom <entry>
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    // Atom <link href="..."/> or RSS <link>...</link>
    const atomLink = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || ''
    const url = atomLink || extract(block, 'link') || extract(block, 'guid') || ''
    const title = extract(block, 'title') || ''
    const content =
      extract(block, 'content') ||
      extract(block, 'content:encoded') ||
      extract(block, 'media:description') ||
      extract(block, 'description') ||
      extract(block, 'summary') || ''
    const pubDate = extract(block, 'pubDate') || extract(block, 'published') || extract(block, 'updated') || extract(block, 'dc:date') || ''
    const published_at = pubDate ? pubDate.trim() : null
    if (url) items.push({ url: url.trim(), title: title.trim(), content: content.trim(), published_at })
    if (items.length >= maxItems) break
  }
  return items
}

async function fetchXmlFeed(url: string, maxItems = MAX_FEED_ITEMS_PER_SOURCE) {
  const res = await fetch(url, { headers: FEED_HEADERS })
  if (!res.ok) throw new Error(`Feed fetch failed ${res.status}`)
  const xml = await res.text()
  return parseRSS(xml, maxItems)
}

async function fetchRedditFeed(url: string) {
  let lastError: unknown
  for (const candidate of redditFeedUrlCandidates(url)) {
    try {
      return await fetchXmlFeed(candidate, MAX_FEED_ITEMS_PER_SOURCE)
    } catch (error) {
      lastError = error
      console.warn(`Reddit feed candidate failed url=${candidate}`, error)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Reddit feed fetch failed: ${url}`)
}

async function fetchYouTubeFeed(source: SourceRow): Promise<Array<{ url: string; title: string; content: string; published_at: string | null; metadata?: Record<string, unknown> }>> {
  const channelId = getYouTubeChannelId(source) ?? await resolveYouTubeChannelId(source.rss_url)
  if (!channelId) {
    console.error(`YouTube channel id not found: ${source.rss_url}`)
    return []
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`
  const items = await fetchXmlFeed(feedUrl)
  return items.map(item => ({
    ...item,
    content: item.content || item.title,
    metadata: { show_name: source.name, channel_id: channelId, source_page: source.rss_url },
  }))
}

async function resolveYouTubeChannelId(url: string): Promise<string | null> {
  const direct = extractYouTubeChannelId(url)
  if (direct) return direct

  const res = await fetch(url, {
    headers: { 'User-Agent': 'NewsProject-IngestRSS/1.0' },
  })
  if (!res.ok) throw new Error(`YouTube channel page fetch failed ${res.status}`)
  return extractYouTubeChannelId(await res.text())
}

function extractYouTubeChannelId(text: string): string | null {
  return extractYouTubeChannelIdFromShared(text)
}

function extract(xml: string, tag: string): string {
  const m =
    xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')) ||
    xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m?.[1] ?? ''
}

async function toRawIngestionRow(item: FeedItem) {
  const isOfficial = item.source_type === 'official_rss'
  const isYouTube = item.source_type === 'youtube'
  const canonicalUrl = isOfficial ? canonicalizeUrl(item.url) : item.url
  return {
    source_id: item.source_id,
    url: canonicalUrl,
    raw_content: item.content,
    status: 'pending',
    metadata: isOfficial ? await buildOfficialMetadata(item, canonicalUrl) : isYouTube ? (item.metadata ?? null) : null,
    published_at: item.published_at ?? null,
  }
}

async function buildOfficialMetadata(item: FeedItem, canonicalUrl: string) {
  const organization = item.source_metadata?.organization ?? inferOrganization(item.source_name, item.source_url)
  const { usableContentChars } = scoreUsableContent({
    title: item.title,
    bodyText: stripHtml(item.content),
    publishedAt: item.published_at,
  })
  return {
    trust_tier: 'official',
    organization,
    source_page: item.source_url,
    content_type_hint: classifyContentTypeHint(canonicalUrl, item.title, stripHtml(item.content)),
    canonical_url: canonicalUrl,
    fingerprint: await computeFingerprint({
      url: canonicalUrl,
      title: item.title,
      bodyText: stripHtml(item.content),
      publishedAt: item.published_at,
      organization,
    }),
    usable_content_chars: usableContentChars,
    dedupe_priority: item.source_metadata?.dedupe_priority ?? 100,
  }
}

async function suppressBatchDuplicates(items: FeedItem[]): Promise<FeedItem[]> {
  const kept: FeedItem[] = []
  const keptOfficial: FeedItem[] = []
  for (const item of items) {
    if (item.source_type !== 'official_rss') {
      kept.push(item)
      continue
    }

    const candidate = toCandidate(item)
    let shouldInsert = true
    for (let i = 0; i < keptOfficial.length; i++) {
      const existingItem = keptOfficial[i]
      const existing = toCandidate(existingItem)
      if (computeSimilarity(candidate, existing) < 0.9) continue
      const decision = chooseDedupeWinner(candidate, existing)
      if (decision.winner.id === candidate.id) {
        console.log(`Batch duplicate: replacing ${existing.url} with ${candidate.url} (${decision.reason})`)
        const keptIndex = kept.indexOf(existingItem)
        if (keptIndex >= 0) kept.splice(keptIndex, 1)
        keptOfficial.splice(i, 1)
        i--
      } else {
        console.log(`Batch duplicate: suppressing ${candidate.url} for ${existing.url} (${decision.reason})`)
        shouldInsert = false
        break
      }
    }
    if (shouldInsert) {
      kept.push(item)
      keptOfficial.push(item)
    }
  }
  return kept
}

async function limitOfficialItemsToWheel(env: Env, items: FeedItem[]): Promise<FeedItem[]> {
  const officialItems = items.filter(item => item.source_type === 'official_rss')
  if (officialItems.length === 0) return items
  const knownUrls = await fetchKnownUrls(env, officialItems.map(item => canonicalizeUrl(item.url)))
  const officialCounts = new Map<string, number>()
  const scoped: FeedItem[] = []

  for (const item of items) {
    if (item.source_type !== 'official_rss') {
      scoped.push(item)
      continue
    }
    const canonicalUrl = canonicalizeUrl(item.url)
    if (isBeforeWheelEarliest(item.published_at)) {
      console.log(`Official RSS cutoff: ${canonicalUrl} published_at=${item.published_at}`)
      continue
    }
    if (knownUrls.has(canonicalUrl)) {
      console.log(`Official RSS known: ${canonicalUrl}`)
      continue
    }
    const count = officialCounts.get(item.source_id) ?? 0
    if (count >= MAX_NEW_OFFICIAL_ITEMS_PER_SOURCE) continue
    officialCounts.set(item.source_id, count + 1)
    knownUrls.add(canonicalUrl)
    scoped.push(item)
  }

  return scoped
}

async function fetchKnownUrls(env: Env, urls: string[]): Promise<Set<string>> {
  const known = new Set<string>()
  const canonicalUrls = [...new Set(urls.map(url => canonicalizeUrl(url) as string))]
  for (let i = 0; i < canonicalUrls.length; i += 50) {
    const chunk = canonicalUrls.slice(i, i + 50)
    const filterValue = `(${chunk.map(u => `"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`
    const rawRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?url=in.${encodeURIComponent(filterValue)}&select=url&limit=50`,
      { headers: SB(env) },
    )
    if (rawRes.ok) {
      const rows: { url: string }[] = await rawRes.json()
      for (const row of rows) known.add(canonicalizeUrl(row.url))
    }
    const dailyRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/daily_news?url=in.${encodeURIComponent(filterValue)}&select=url&limit=50`,
      { headers: SB(env) },
    )
    if (dailyRes.ok) {
      const rows: { url: string }[] = await dailyRes.json()
      for (const row of rows) known.add(canonicalizeUrl(row.url))
    }
  }
  return known
}

function toCandidate(item: FeedItem) {
  const text = stripHtml(item.content)
  const official = item.source_type === 'official_rss'
  const score = scoreUsableContent({ title: item.title, bodyText: text, publishedAt: item.published_at })
  return {
    id: `${item.source_id}:${canonicalizeUrl(item.url)}`,
    url: official ? canonicalizeUrl(item.url) : item.url,
    title: item.title,
    bodyText: text,
    publishedAt: item.published_at,
    organization: item.source_metadata?.organization ?? inferOrganization(item.source_name, item.source_url),
    trustTier: official ? 'official' : 'secondary',
    usableContentChars: score.usableContentChars,
    dedupePriority: official ? (item.source_metadata?.dedupe_priority ?? 100) : 0,
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function inferOrganization(name: string, url: string): string {
  const text = `${name} ${url}`.toLowerCase()
  if (text.includes('anthropic')) return 'anthropic'
  if (text.includes('deepmind')) return 'google_deepmind'
  if (text.includes('openai')) return 'openai'
  return 'unknown'
}

function isBeforeWheelEarliest(publishedAt: string | null): boolean {
  if (!publishedAt) return false
  const published = new Date(publishedAt)
  if (Number.isNaN(published.getTime())) return false
  const cutoff = new Date()
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - (FRONTEND_WHEEL_MAX_DAYS - 1))
  return published < cutoff
}
