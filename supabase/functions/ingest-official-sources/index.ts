import {
  canonicalizeUrl,
  chooseDedupeWinner,
  classifyContentTypeHint,
  computeFingerprint,
  computeSimilarity,
  scoreUsableContent,
} from "../_shared/official-source.js"

type SourceRow = {
  id: string
  name: string
  rss_url: string
  metadata?: {
    trust_tier?: string
    organization?: string
    fetch_mode?: string
    dedupe_priority?: number
  } | null
}

type ArticleCandidate = {
  source: SourceRow
  url: string
  canonicalUrl: string
  title: string
  bodyText: string
  publishedAt: string | null
}

const MAX_NEW_ARTICLES_PER_SOURCE = 1
const MAX_LINKS_TO_SCAN_PER_SOURCE = 16
const MAX_EXISTING_ROWS = 40
const MAX_FETCH_CHARS = 700_000
const MAX_DEDUPE_BODY_CHARS = 2500
const FRONTEND_WHEEL_MAX_DAYS = 30

Deno.serve(async (_req) => {
  EdgeRuntime.waitUntil(runIngestion().catch(err => console.error('[ingest-official-sources] unhandled:', err)))
  return json({ status: 'accepted' })
})

async function runIngestion() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const headers = sbHeaders(serviceKey)

  const sourcesRes = await fetch(
    `${supabaseUrl}/rest/v1/sources?is_active=eq.true&source_type=eq.official_html_index&select=id,name,rss_url,metadata`,
    { headers },
  )
  if (!sourcesRes.ok) throw new Error(`sources lookup failed ${sourcesRes.status}: ${await sourcesRes.text()}`)
  const sources: SourceRow[] = await sourcesRes.json()
  console.log(`[ingest-official-sources] sources=${sources.length}`)

  const existing = await fetchExistingCandidates(supabaseUrl, headers)
  console.log(`[ingest-official-sources] existing_candidates=${existing.length}`)
  const pendingRows: Record<string, unknown>[] = []
  const suppressedRows: Record<string, unknown>[] = []

  for (const source of sources) {
    console.log(`[ingest-official-sources] source_start name="${source.name}"`)
    const indexHtml = await fetchText(source.rss_url)
    if (!indexHtml) {
      console.error(`[ingest-official-sources] index fetch failed: ${source.name}`)
      continue
    }

    const links = extractIndexLinks(source.rss_url, indexHtml).slice(0, MAX_LINKS_TO_SCAN_PER_SOURCE)
    console.log(`[ingest-official-sources] source_links name="${source.name}" count=${links.length}`)
    if (links.length === 0) {
      console.error(`[ingest-official-sources] zero links extracted: ${source.name}`)
      continue
    }

    const knownUrls = await fetchKnownUrls(supabaseUrl, headers, links)
    let insertedForSource = 0
    for (const link of links) {
      const candidate = await fetchArticleCandidate(source, link)
      if (!candidate) continue
      if (isBeforeWheelEarliest(candidate.publishedAt)) {
        console.log(`[ingest-official-sources] source_cutoff name="${source.name}" url=${candidate.canonicalUrl} published_at=${candidate.publishedAt}`)
        break
      }

      const row = await buildRawRow(candidate, 'pending')
      if (knownUrls.has(candidate.canonicalUrl)) {
        await patchExistingOfficialRows(supabaseUrl, headers, [row])
        console.log(`[ingest-official-sources] source_skip_known name="${source.name}" url=${candidate.canonicalUrl}`)
        continue
      }

      const duplicate = findSuppressingDuplicate(candidate, existing)
      if (duplicate) {
        suppressedRows.push({
          ...row,
          status: 'error',
          last_error: 'DUPLICATE_SUPPRESSED',
          metadata: {
            ...(row.metadata as Record<string, unknown>),
            duplicate_suppressed: true,
            duplicate_of_url: duplicate.winner.url,
            duplicate_reason: duplicate.reason,
            duplicate_similarity: duplicate.similarity,
          },
        })
        console.log(`[ingest-official-sources] source_skip_duplicate name="${source.name}" url=${candidate.canonicalUrl} reason=${duplicate.reason}`)
        continue
      }

      pendingRows.push(row)
      existing.push(toDedupeCandidate(candidate))
      knownUrls.add(candidate.canonicalUrl)
      insertedForSource++
      if (insertedForSource >= MAX_NEW_ARTICLES_PER_SOURCE) break
    }
    console.log(`[ingest-official-sources] source_done name="${source.name}" inserted=${insertedForSource} pending_so_far=${pendingRows.length} suppressed_so_far=${suppressedRows.length}`)
  }

  await insertRows(supabaseUrl, headers, [...pendingRows, ...suppressedRows])
  await patchExistingOfficialRows(supabaseUrl, headers, [...pendingRows, ...suppressedRows])
  console.log(`[ingest-official-sources] pending=${pendingRows.length} suppressed=${suppressedRows.length}`)
}

async function fetchArticleCandidate(source: SourceRow, url: string): Promise<ArticleCandidate | null> {
  const html = await fetchText(url)
  if (!html) {
    console.error(`[ingest-official-sources] article fetch failed: ${url}`)
    return null
  }

  const canonicalUrl = canonicalizeUrl(
    findLinkHref(html, 'canonical') ?? url,
  )
  const title =
    findMetaContent(html, 'property', 'og:title') ??
    findMetaContent(html, 'name', 'twitter:title') ??
    findTagText(html, 'h1') ??
    findTagText(html, 'title') ??
    ''
  const publishedAt =
    findMetaContent(html, 'property', 'article:published_time') ??
    findMetaContent(html, 'property', 'og:article:published_time') ??
    findMetaContent(html, 'name', 'article:published_time') ??
    findMetaContent(html, 'name', 'datePublished') ??
    findMetaContent(html, 'itemprop', 'datePublished') ??
    findMetaContent(html, 'name', 'date') ??
    findTimeDatetime(html) ??
    findJsonLdDate(html) ??
    findVisibleDate(html) ??
    null

  const bodyText = extractReadableText(html)

  if (bodyText.length < 120 && !title) {
    console.error(`[ingest-official-sources] empty article content: ${url}`)
    return null
  }

  return { source, url, canonicalUrl, title, bodyText, publishedAt }
}

function extractIndexLinks(indexUrl: string, html: string): string[] {
  const base = new URL(indexUrl)
  const seen = new Set<string>()
  const linkRegex = /<a\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    const href = decodeHtml(getAttr(match[0], 'href') ?? '')
    if (!href) continue
    let url: URL
    try {
      url = new URL(href, indexUrl)
    } catch {
      continue
    }
    if (url.host !== base.host) continue
    if (!isAllowedArticlePath(base, url)) continue
    seen.add(canonicalizeUrl(url.toString()))
  }
  return [...seen]
}

function isAllowedArticlePath(base: URL, url: URL): boolean {
  if (base.host.includes('anthropic.com')) {
    return /^\/(news|research)\//.test(url.pathname)
  }
  if (base.host.includes('deepmind.google')) {
    return (
      /^\/blog\/[^/]+/.test(url.pathname) ||
      /^\/discover\/blog\/[^/]+/.test(url.pathname)
    ) && !['/blog/', '/discover/blog/'].includes(url.pathname)
  }
  return url.pathname.startsWith(base.pathname)
}

async function buildRawRow(candidate: ArticleCandidate, status: 'pending' | 'error') {
  const metadata = await buildOfficialMetadata(candidate)
  return {
    source_id: candidate.source.id,
    url: candidate.canonicalUrl,
    raw_content: candidate.bodyText,
    status,
    metadata,
    published_at: candidate.publishedAt,
  }
}

async function buildOfficialMetadata(candidate: ArticleCandidate) {
  const organization = candidate.source.metadata?.organization ?? inferOrganization(candidate.source.name, candidate.source.rss_url)
  const { usableContentChars } = scoreUsableContent({
    title: candidate.title,
    bodyText: candidate.bodyText,
    publishedAt: candidate.publishedAt,
  })
  return {
    trust_tier: 'official',
    organization,
    source_page: candidate.source.rss_url,
    content_type_hint: classifyContentTypeHint(candidate.canonicalUrl, candidate.title, candidate.bodyText),
    canonical_url: candidate.canonicalUrl,
    fingerprint: await computeFingerprint({
      url: candidate.canonicalUrl,
      title: candidate.title,
      bodyText: candidate.bodyText,
      publishedAt: candidate.publishedAt,
      organization,
    }),
    usable_content_chars: usableContentChars,
    dedupe_priority: candidate.source.metadata?.dedupe_priority ?? 100,
  }
}

function findSuppressingDuplicate(candidate: ArticleCandidate, existing: ReturnType<typeof toDedupeCandidate>[]) {
  const dedupeCandidate = toDedupeCandidate(candidate)
  for (const other of existing) {
    const similarity = computeSimilarity(dedupeCandidate, other)
    if (similarity < 0.9) continue
    const decision = chooseDedupeWinner(dedupeCandidate, other)
    if (decision.suppressed === dedupeCandidate) {
      return { ...decision, similarity }
    }
  }
  return null
}

function toDedupeCandidate(candidate: ArticleCandidate) {
  const score = scoreUsableContent({
    title: candidate.title,
    bodyText: candidate.bodyText,
    publishedAt: candidate.publishedAt,
  })
  return {
    id: candidate.canonicalUrl,
    url: candidate.canonicalUrl,
    title: candidate.title,
    bodyText: candidate.bodyText,
    publishedAt: candidate.publishedAt,
    organization: candidate.source.metadata?.organization ?? inferOrganization(candidate.source.name, candidate.source.rss_url),
    trustTier: 'official',
    usableContentChars: score.usableContentChars,
    dedupePriority: candidate.source.metadata?.dedupe_priority ?? 100,
  }
}

async function fetchExistingCandidates(supabaseUrl: string, headers: Record<string, string>) {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const rawRes = await fetch(
    `${supabaseUrl}/rest/v1/raw_ingestion?fetched_at=gte.${encodeURIComponent(since)}&select=url,published_at,metadata&limit=${MAX_EXISTING_ROWS}&order=fetched_at.desc`,
    { headers },
  )
  const dailyRes = await fetch(
    `${supabaseUrl}/rest/v1/daily_news?created_at=gte.${encodeURIComponent(since)}&select=url,title,summary,published_at,metadata&limit=${MAX_EXISTING_ROWS}&order=created_at.desc`,
    { headers },
  )

  const result: ReturnType<typeof toDedupeCandidate>[] = []
  if (rawRes.ok) {
    const rows: Array<{ url: string; published_at?: string | null; metadata?: Record<string, unknown> | null }> = await rawRes.json()
    for (const row of rows) result.push(existingRowToCandidate(row.url, '', '', row.published_at ?? null, row.metadata))
  }
  if (dailyRes.ok) {
    const rows: Array<{ url: string; title?: string; summary?: string; published_at?: string | null; metadata?: Record<string, unknown> | null }> = await dailyRes.json()
    for (const row of rows) result.push(existingRowToCandidate(row.url, row.title ?? '', row.summary ?? '', row.published_at ?? null, row.metadata))
  }
  return result
}

async function fetchKnownUrls(supabaseUrl: string, headers: Record<string, string>, urls: string[]) {
  const known = new Set<string>()
  const canonicalUrls = [...new Set(urls.map(canonicalizeUrl))]
  for (let i = 0; i < canonicalUrls.length; i += 50) {
    const chunk = canonicalUrls.slice(i, i + 50)
    const filterValue = `(${chunk.map(u => `"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`
    const rawRes = await fetch(
      `${supabaseUrl}/rest/v1/raw_ingestion?url=in.${encodeURIComponent(filterValue)}&select=url&limit=50`,
      { headers },
    )
    if (rawRes.ok) {
      const rows: Array<{ url: string }> = await rawRes.json()
      for (const row of rows) known.add(canonicalizeUrl(row.url))
    }
    const dailyRes = await fetch(
      `${supabaseUrl}/rest/v1/daily_news?url=in.${encodeURIComponent(filterValue)}&select=url&limit=50`,
      { headers },
    )
    if (dailyRes.ok) {
      const rows: Array<{ url: string }> = await dailyRes.json()
      for (const row of rows) known.add(canonicalizeUrl(row.url))
    }
  }
  return known
}

function existingRowToCandidate(url: string, title: string, bodyText: string, publishedAt: string | null, metadata?: Record<string, unknown> | null) {
  const cappedBody = bodyText.slice(0, MAX_DEDUPE_BODY_CHARS)
  const score = scoreUsableContent({ title, bodyText: cappedBody, publishedAt })
  const trustTier = metadata?.trust_tier === 'official' ? 'official' : 'secondary'
  return {
    id: canonicalizeUrl(url),
    url: canonicalizeUrl(url),
    title,
    bodyText: cappedBody,
    publishedAt,
    organization: typeof metadata?.organization === 'string' ? metadata.organization : 'unknown',
    trustTier,
    usableContentChars: score.usableContentChars,
    dedupePriority: typeof metadata?.dedupe_priority === 'number' ? metadata.dedupe_priority : 0,
  }
}

async function insertRows(supabaseUrl: string, headers: Record<string, string>, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return
  const res = await fetch(`${supabaseUrl}/rest/v1/raw_ingestion?on_conflict=url`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify(rows),
  })
  if (!res.ok) throw new Error(`raw_ingestion insert failed ${res.status}: ${await res.text()}`)
}

async function patchExistingOfficialRows(supabaseUrl: string, headers: Record<string, string>, rows: Record<string, unknown>[]) {
  const patchableRows = rows.filter(row => row.url && (row.published_at || row.metadata))
  for (const row of patchableRows) {
    const body: Record<string, unknown> = { metadata: row.metadata }
    if (row.published_at) body.published_at = row.published_at
    const encodedUrl = encodeURIComponent(String(row.url))
    const rawRes = await fetch(`${supabaseUrl}/rest/v1/raw_ingestion?url=eq.${encodedUrl}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    })
    if (!rawRes.ok) {
      console.error(`[ingest-official-sources] raw patch failed url=${row.url} status=${rawRes.status}`)
    }
    const dailyRes = await fetch(`${supabaseUrl}/rest/v1/daily_news?url=eq.${encodedUrl}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    })
    if (!dailyRes.ok) {
      console.error(`[ingest-official-sources] daily patch failed url=${row.url} status=${dailyRes.status}`)
    }
  }
}

async function fetchText(url: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timer)
    if (!res.ok) return ''
    const text = await res.text()
    return text.slice(0, MAX_FETCH_CHARS)
  } catch {
    clearTimeout(timer)
    return ''
  }
}

function inferOrganization(name: string, url: string) {
  const text = `${name} ${url}`.toLowerCase()
  if (text.includes('anthropic')) return 'anthropic'
  if (text.includes('deepmind')) return 'google_deepmind'
  if (text.includes('openai')) return 'openai'
  return 'unknown'
}

function sbHeaders(serviceKey: string) {
  return {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  }
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function findMetaContent(html: string, attrName: 'name' | 'property', attrValue: string) {
  const metaRegex = /<meta\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = metaRegex.exec(html)) !== null) {
    if ((getAttr(match[0], attrName) ?? '').toLowerCase() !== attrValue.toLowerCase()) continue
    return decodeHtml(getAttr(match[0], 'content') ?? '').trim() || null
  }
  return null
}

function findLinkHref(html: string, rel: string) {
  const linkRegex = /<link\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    if (!(getAttr(match[0], 'rel') ?? '').toLowerCase().split(/\s+/).includes(rel.toLowerCase())) continue
    return decodeHtml(getAttr(match[0], 'href') ?? '').trim() || null
  }
  return null
}

function findTimeDatetime(html: string) {
  const match = /<time\b[^>]*>/i.exec(html)
  const datetime = decodeHtml(match ? getAttr(match[0], 'datetime') ?? '' : '').trim()
  if (datetime) return normalizePublishedAt(datetime)
  return match ? normalizePublishedAt(cleanText(match[0])) : null
}

function findTagText(html: string, tag: string) {
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  return cleanText(regex.exec(html)?.[1] ?? '') || null
}

function extractReadableText(html: string) {
  const article = firstMatchedBlock(html, 'article') ?? firstMatchedBlock(html, 'main') ?? html
  const withoutNoise = article
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const chunks: string[] = []
  const blockRegex = /<(h1|h2|h3|p)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(withoutNoise)) !== null) {
    const text = cleanText(match[2])
    if (text && text.length > 20) chunks.push(text)
    if (chunks.join(' ').length >= 12000) break
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim()
}

function firstMatchedBlock(html: string, tag: string) {
  const regex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'i')
  return regex.exec(html)?.[0] ?? null
}

function cleanText(html: string) {
  return decodeHtml(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtml(input: string) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function getAttr(tag: string, name: string) {
  const regex = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = regex.exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

function findJsonLdDate(html: string) {
  const scriptRegex = /<script\b[^>]*type=(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = scriptRegex.exec(html)) !== null) {
    const rawJson = decodeHtml(match[1]).trim()
    try {
      const parsed = JSON.parse(rawJson)
      const date = findDateInJson(parsed)
      if (date) return normalizePublishedAt(date)
    } catch {
      const fallback = /"datePublished"\s*:\s*"([^"]+)"/i.exec(rawJson)?.[1] ?? /"dateModified"\s*:\s*"([^"]+)"/i.exec(rawJson)?.[1]
      if (fallback) return normalizePublishedAt(fallback)
    }
  }
  return null
}

function findDateInJson(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDateInJson(item)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of ['datePublished', 'dateCreated', 'dateModified', 'uploadDate']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  for (const nested of Object.values(record)) {
    const found = findDateInJson(nested)
    if (found) return found
  }
  return null
}

function findVisibleDate(html: string) {
  const datePatterns = [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+20\d{2}\b/i,
    /\b20\d{2}-\d{2}-\d{2}\b/,
    /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+20\d{2}\b/i,
  ]
  const earlyText = cleanText(html.slice(0, 80_000))
  for (const pattern of datePatterns) {
    const match = pattern.exec(earlyText)
    if (match) return normalizePublishedAt(match[0])
  }
  return null
}

function normalizePublishedAt(input: string | null) {
  if (!input) return null
  const cleaned = input.trim()
  const parsed = new Date(cleaned)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return cleaned || null
}

function isBeforeWheelEarliest(publishedAt: string | null) {
  if (!publishedAt) return false
  const published = new Date(publishedAt)
  if (Number.isNaN(published.getTime())) return false
  const cutoff = new Date()
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - (FRONTEND_WHEEL_MAX_DAYS - 1))
  return published < cutoff
}
