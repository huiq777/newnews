import { hasAISignal } from './keywords'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  TOKENROUTER_API_KEY: string        // new primary
  LLM_MODEL: string                  // used on TokenRouter for bio extraction
  OPENROUTER_API_KEY: string
  OPENROUTER_BIO_MODEL: string       // used on OpenRouter fallback (cheaper bio model)
  GROQ_API_KEY: string
  PRODUCTHUNT_API_TOKEN?: string   // optional — skip PH if not set
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json'
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json'
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions'
const GITHUB_TRENDING_URL = 'https://github.com/trending?spoken_language_code='
const PRODUCTHUNT_GQL_URL = 'https://api.producthunt.com/v2/api/graphql'
const NOWCODER_HOT_URL    = 'https://gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc'

interface BuilderAccount {
  handle: string
  bio?: string
  tweets?: BuilderTweet[]
}

interface BuilderTweet {
  id: string
  text: string
  createdAt: string
  url: string
  likes?: number
  retweets?: number
  replies?: boolean
  isQuote?: boolean
  quotedTweetId?: string | null
}

interface PodcastEpisode {
  source: string
  name: string
  title: string
  videoId: string
  url: string
  publishedAt: string
  transcript: string
}

function extractPodcasts(data: unknown): PodcastEpisode[] {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (Array.isArray(d.podcasts)) return d.podcasts as PodcastEpisode[]
  }
  return []
}

// Nowcoder discuss/feed pages embed the post body in
// <script>window.__INITIAL_STATE__ = {...}</script>. The structure is
// __INITIAL_STATE__.prefetchData["2"].ssrCommonData.contentData.content (HTML
// fragment). The documented JSON detail endpoint returns 404, so we scrape
// the SSR state instead. Returns "" on any parse failure — caller falls back
// to title-only.
function extractNowcoderContent(html: string): string {
  const marker = 'window.__INITIAL_STATE__'
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) return ''
  // Find the first '{' after the assignment then balance-match to its closing brace.
  // String-aware so quoted braces inside JSON values do not break the count.
  const braceStart = html.indexOf('{', markerIdx)
  if (braceStart === -1) return ''
  let depth = 0, inString = false, isEscaped = false, end = -1
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i]
    if (isEscaped) { isEscaped = false; continue }
    if (ch === '\\') { isEscaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (!inString) {
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
    }
  }
  if (end === -1) return ''
  let state: unknown
  try {
    state = JSON.parse(html.slice(braceStart, end + 1))
  } catch {
    return ''
  }
  // Walk the known path, then fall back to a deep search for `content` if the
  // shape shifts. Nowcoder's frontend is third-party so the path is brittle.
  const fromKnownPath = (() => {
    try {
      const s = state as { prefetchData?: Record<string, { ssrCommonData?: { contentData?: { content?: string } } }> }
      const data = s.prefetchData
      if (!data) return ''
      for (const key of Object.keys(data)) {
        const c = data[key]?.ssrCommonData?.contentData?.content
        if (typeof c === 'string' && c.length > 0) return c
      }
      return ''
    } catch { return '' }
  })()
  const html_ = fromKnownPath
  if (!html_) return ''
  // Strip HTML tags, decode common entities, collapse whitespace.
  return html_
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Extract @handle from tweet URL: https://x.com/karpathy/status/... → "karpathy"
function extractAuthor(url: string): string | null {
  const match = url.match(/x\.com\/([^/]+)\/status\//)
  return match ? match[1] : null
}

// Flatten feed-x.json — handles { x: [{handle, tweets:[...]}, ...] } and legacy formats
function extractAccounts(data: unknown): BuilderAccount[] {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (Array.isArray(d.x)) return d.x as BuilderAccount[]
  }
  return []
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions'
const TOKENROUTER_API = 'https://api.tokenrouter.com/v1/chat/completions'


const BIO_SYSTEM_PROMPT = 'You extract professional titles, roles, and credentials from Twitter bios. Output ONE flat JSON object where keys are handles and values are the exact, unabbreviated title strings extracted directly from the bio.\n\nRules:\n1. For people: DO NOT summarize, abbreviate, or alter the titles. Extract the exact relevant text verbatim. Include previous roles, multiple affiliations, or degrees if listed. Exclude conversational filler or hobbies (e.g., drop "I like to train large deep neural nets.").\n2. For products: Use the format "[Name] is [Exact Description] @[Company]".\n\nExample output:\n{"karpathy": "Previously Director of AI @ Tesla, founding team @ OpenAI, PhD @ Stanford", "claudeai": "Claude is LLM @Anthropic"}\n\nNo arrays, no extra keys, no markdown blocks (like ```json), no explanation.'

// Extracts the first complete JSON object from a string, ignoring surrounding prose/markdown.
// Required because response_format: json_object is best-effort — models wrap in ```json fences.
function extractFirstJson(text: string): string {
  const start = text.indexOf('{')
  if (start === -1) throw new Error('No JSON object found in response')
  let depth = 0, inString = false, isEscaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (isEscaped) { isEscaped = false; continue }
    if (char === '\\') { isEscaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (!inString) {
      if (char === '{') depth++
      else if (char === '}') { depth--; if (depth === 0) return text.slice(start, i + 1) }
    }
  }
  throw new Error('Unterminated JSON object in response')
}

async function fetchKnownUrls(
  urls: string[],
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Set<string>> {
  const known = new Set<string>()
  if (urls.length === 0) return known
  const chunks: string[][] = []
  for (let i = 0; i < urls.length; i += 100) {
    chunks.push(urls.slice(i, i + 100))
  }
  await Promise.all(chunks.map(async chunk => {
    const filterValue = `(${chunk.map(u => `"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`
    const res = await fetch(
      `${supabaseUrl}/rest/v1/raw_ingestion?url=in.${encodeURIComponent(filterValue)}&select=url&limit=100`,
      { headers },
    )
    if (!res.ok) return
    const rows: { url: string }[] = await res.json()
    for (const r of rows) known.add(r.url)
  }))
  return known
}

type BuilderTweetRow = {
  source_id: string
  url: string
  raw_content: string
  status: string
  metadata: { likes?: number; retweets?: number }
  published_at: string | null
}

function gradeTweets(allTweets: BuilderTweetRow[], knownUrls: Set<string>): BuilderTweetRow[] {
  // Group by author handle extracted from x.com URL
  const byAuthor = new Map<string, BuilderTweetRow[]>()
  for (const tweet of allTweets) {
    const handle = tweet.url.match(/x\.com\/([^/]+)\/status\//)?.[1]?.toLowerCase() ?? 'unknown'
    if (!byAuthor.has(handle)) byAuthor.set(handle, [])
    byAuthor.get(handle)!.push(tweet)
  }

  const survivors: BuilderTweetRow[] = []
  for (const [, tweets] of byAuthor) {
    // 1. Filter net-new (not already in raw_ingestion)
    const netNew = tweets.filter(t => !knownUrls.has(t.url))
    // 2. Keyword gate
    const relevant = netNew.filter(t => hasAISignal(t.raw_content))
    // 3. Sort by likes + retweets descending
    const sorted = relevant.sort((a, b) => {
      const scoreA = (a.metadata.likes ?? 0) + (a.metadata.retweets ?? 0)
      const scoreB = (b.metadata.likes ?? 0) + (b.metadata.retweets ?? 0)
      return scoreB - scoreA
    })
    // 4. Keep top 3
    survivors.push(...sorted.slice(0, 3))
  }
  return survivors
}

async function extractBioMap(biosText: string, env: Env): Promise<Record<string, string>> {
  const messages = [
    {
      role: 'system',
      content: 'Respond with valid JSON only. No prose. ' + BIO_SYSTEM_PROMPT,
    },
    { role: 'user', content: biosText },
  ]

  // Helper: parse bio map from flat JSON or JSONL
  function parseBioJson(text: string): Record<string, string> | null {
    try {
      const rawParsed = JSON.parse(extractFirstJson(text))
      const flat = (rawParsed.bios && typeof rawParsed.bios === 'object') ? rawParsed.bios : rawParsed
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(flat)) {
        if (typeof v === 'string') result[k.replace(/^@/, '').toLowerCase()] = v
      }
      return Object.keys(result).length > 0 ? result : null
    } catch {
      return null
    }
  }

  // ── Tier 1: TokenRouter ─────────────────────────────────────────────────────
  {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      console.log('[extractBioMap][TokenRouter] calling...')
      const trRes = await fetch(TOKENROUTER_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.TOKENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://news-app.internal',
          'X-Title': 'NewsApp',
        },
        body: JSON.stringify({
          model: env.LLM_MODEL,
          messages,
          response_format: { type: 'json_object' },
          max_tokens: 600,
          temperature: 0,
        }),
        signal: controller.signal,
      })
      clearTimeout(timerId)
      if (trRes.ok) {
        const json = await trRes.json() as { choices?: Array<{ message?: { content?: string } }> }
        const text = json.choices?.[0]?.message?.content ?? ''
        const result = parseBioJson(text)
        if (result) return result
        console.log('[extractBioMap][TokenRouter] parse failed, trying OpenRouter')
      } else if (trRes.status === 429) {
        console.log('[extractBioMap][TokenRouter] 429, trying OpenRouter')
      } else {
        console.log(`[extractBioMap][TokenRouter] ${trRes.status}, trying OpenRouter`)
      }
    } catch (e: unknown) {
      clearTimeout(timerId)
      console.log('[extractBioMap][TokenRouter] failed, trying OpenRouter:', (e as Error).message)
    }
  }

  // ── Tier 2: OpenRouter ──────────────────────────────────────────────────────
  {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      console.log('[extractBioMap][OpenRouter] calling...')
      const orRes = await fetch(OPENROUTER_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://news-app.internal',
          'X-Title': 'NewsApp',
        },
        body: JSON.stringify({
          model: env.OPENROUTER_BIO_MODEL,
          messages,
          response_format: { type: 'json_object' },
          max_tokens: 600,
          temperature: 0,
        }),
        signal: controller.signal,
      })
      clearTimeout(timerId)
      if (orRes.ok) {
        const json = await orRes.json() as { choices?: Array<{ message?: { content?: string } }> }
        const text = json.choices?.[0]?.message?.content ?? ''
        const result = parseBioJson(text)
        if (result) return result
        console.log('[extractBioMap][OpenRouter] parse failed, trying Groq')
      } else if (orRes.status === 429) {
        console.log('[extractBioMap][OpenRouter] 429, trying Groq')
      } else {
        console.log(`[extractBioMap][OpenRouter] ${orRes.status}, trying Groq`)
      }
    } catch (e: unknown) {
      clearTimeout(timerId)
      console.log('[extractBioMap][OpenRouter] failed, trying Groq:', (e as Error).message)
    }
  }

  // ── Tier 3: Groq ───────────────────────────────────────────────────────────
  {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      console.log('[extractBioMap][Groq] calling...')
      const groqRes = await fetch(GROQ_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: BIO_SYSTEM_PROMPT },
            { role: 'user', content: biosText },
          ],
          max_tokens: 600,
          temperature: 0,
        }),
        signal: controller.signal,
      })
      clearTimeout(timerId)
      if (!groqRes.ok) {
        console.log(`[extractBioMap][Groq] ${groqRes.status}, returning empty bio map`)
        return {}
      }
      const data = await groqRes.json() as { choices?: Array<{ message?: { content?: string } }> }
      const responseText = (data.choices?.[0]?.message?.content || '').trim()
      if (!responseText) return {}

      // Try flat JSON first, then JSONL fallback
      const result = parseBioJson(responseText)
      if (result) return result

      // JSONL fallback: {"handle": "karpathy", "role": "Director"}
      const jsonlResult: Record<string, string> = {}
      for (const line of responseText.split('\n').filter(l => l.trim())) {
        try {
          const obj = JSON.parse(line) as { handle?: string; role?: string }
          if (obj.handle && obj.role) {
            jsonlResult[obj.handle.replace(/^@/, '').toLowerCase()] = obj.role
          }
        } catch { /* skip malformed line */ }
      }
      if (Object.keys(jsonlResult).length > 0) return jsonlResult

      console.log('[extractBioMap][Groq] all parse attempts failed, returning empty bio map')
      return {}
    } catch (e: unknown) {
      clearTimeout(timerId)
      console.log('[extractBioMap][Groq] failed, returning empty bio map:', (e as Error).message)
      return {}
    }
  }
}

interface AIHotItem {
  id: string
  url: string
  title: string
  title_en?: string
  summary: string
  category: string
  source: string
  publishedAt: string
}

interface AIHotResponse {
  items: AIHotItem[]
  hasNext: boolean
  nextCursor?: string
}

async function fetchAIHot(
  src: { id: string; name: string; source_type: string; metadata?: Record<string, unknown> },
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<object[]> {
  // Stateful cursor: use MAX(published_at) from last run; fall back to 25h window on first run.
  const cursorRes = await fetch(
    `${supabaseUrl}/rest/v1/raw_ingestion?source_id=eq.${src.id}&select=published_at&order=published_at.desc&limit=1`,
    { headers },
  )
  const cursorRows: { published_at: string | null }[] = cursorRes.ok ? await cursorRes.json() : []
  const since = cursorRows[0]?.published_at
    ? new Date(cursorRows[0].published_at).toISOString()
    : new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()

  const rows: object[] = []
  let url: string | null = `https://aihot.virxact.com/api/public/items?mode=selected&take=50&since=${encodeURIComponent(since)}`
  let page = 0

  while (url && page < 2) {
    page++
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NewsProject-IngestBuilders/1.0' },
    })
    if (!res.ok) {
      console.error(`AIHot fetch failed (page ${page}): ${res.status}`)
      break
    }
    const data = await res.json() as AIHotResponse
    for (const item of data.items ?? []) {
      if (!item.url || !item.title) continue
      rows.push({
        source_id: src.id,
        url: item.url,
        raw_content: item.summary ? `${item.title}\n\n${item.summary}` : item.title,
        status: 'pending',
        metadata: {
          title_en: item.title_en ?? null,
          category: item.category,
          source: item.source,
          aihot_id: item.id,
        },
        published_at: item.publishedAt ?? null,
      })
    }
    url = data.hasNext && data.nextCursor
      ? `https://aihot.virxact.com/api/public/items?mode=selected&take=50&cursor=${encodeURIComponent(data.nextCursor)}`
      : null
  }

  console.log(`AIHot: ${rows.length} items queued (since ${since})`)
  return rows
}

export default {
  async fetch() {
    return new Response('ingest-builders is running')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // 1. Get source rows for both builder tweets and podcasts (1 subrequest)
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&source_type=in.(github_feed,podcast,github_trending,producthunt,nowcoder,arxiv,aihot)&select=id,name,source_type,metadata`,
      { headers: SB(env) }
    )
    const sources: { id: string; name: string; source_type: string; metadata?: Record<string, unknown> }[] = await sourcesRes.json()

    const builderSource        = sources.find(s => s.source_type === 'github_feed')
    const podcastSource        = sources.find(s => s.source_type === 'podcast')
    const githubTrendingSource = sources.find(s => s.source_type === 'github_trending')
    const productHuntSource    = sources.find(s => s.source_type === 'producthunt')
    const nowcoderSource       = sources.find(s => s.source_type === 'nowcoder')
    const arxivSources         = sources.filter(s => s.source_type === 'arxiv')
    const aihotSource          = sources.find(s => s.source_type === 'aihot')

    // ── Builder tweets ──────────────────────────────────────────────────────

    if (!builderSource) {
      console.log('No github_feed source configured. Run the INSERT SQL first.')
    } else {
      console.log(`Builder source: ${builderSource.name} (${builderSource.id})`)

      // 2. Fetch feed-x.json from GitHub (public URL, no auth needed)
      const feedRes = await fetch(FEED_X_URL, {
        headers: { 'User-Agent': 'NewsProject-IngestBuilders/1.0' },
      })

      if (!feedRes.ok) {
        console.error(`Failed to fetch feed-x.json: ${feedRes.status} ${feedRes.statusText}`)
      } else {
        const rawData: unknown = await feedRes.json()
        const accounts = extractAccounts(rawData)
        const tweets = accounts.flatMap(a => a.tweets ?? [])
        console.log(`Fetched ${tweets.length} builder tweets from feed-x.json`)

        // 3. Extract AI-interpreted positions from bios → cache in sources.metadata
        // Only process net-new handles to avoid LLM truncation and wasted tokens.
        const existingBioMap: Record<string, string> =
          (builderSource.metadata?.bio_map as Record<string, string> | undefined) ?? {}
        const withBio = accounts.filter((a: { handle?: string; bio?: string }) =>
          a.handle && a.bio && !existingBioMap[a.handle.toLowerCase()]
        )
        const biosText = withBio.map((a: { handle: string; bio: string }) => `@${a.handle}: ${a.bio}`).join('\n')
        const newlyExtracted = biosText ? await extractBioMap(biosText, env) : {}
        const mergedBioMap = { ...existingBioMap, ...newlyExtracted }
        if (Object.keys(newlyExtracted).length > 0) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/sources?id=eq.${builderSource.id}`, {
            method: 'PATCH',
            headers: { ...SB(env), 'Prefer': 'return=minimal' },
            body: JSON.stringify({ metadata: { ...builderSource.metadata, bio_map: mergedBioMap } }),
          })
          console.log(`Bio map updated: ${Object.keys(newlyExtracted).length} new handles, ${Object.keys(mergedBioMap).length} total`)
        } else {
          console.log(`Bio map: no net-new handles (${Object.keys(existingBioMap).length} already cached)`)
        }

        // 4. Filter valid tweets (must have id, text, and url)
        const validTweets = tweets.filter(t => t.id && t.text && t.url)
        console.log(`Inserting ${validTweets.length} valid tweets`)

        // 5. Batch insert surviving tweets — bulk dedup + per-author grading applied first
        const tweetRows: BuilderTweetRow[] = validTweets.map(tweet => {
          const author = extractAuthor(tweet.url)
          return {
            source_id: builderSource.id,
            url: tweet.url,
            raw_content: author ? `@${author}: ${tweet.text}` : tweet.text,
            status: 'pending',
            metadata: { likes: tweet.likes ?? 0, retweets: tweet.retweets ?? 0 },
            published_at: tweet.createdAt ?? null,
          }
        })

        // Bulk dedup + per-author grading
        const allTweetUrls = tweetRows.map(r => r.url)
        const knownUrls = await fetchKnownUrls(allTweetUrls, env.SUPABASE_URL, SB(env))
        const survivingTweets = gradeTweets(tweetRows, knownUrls)
        console.log(`Tweet grading: ${tweetRows.length} total → ${survivingTweets.length} survivors`)

        if (survivingTweets.length > 0) {
          const tweetInsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?on_conflict=url`, {
            method: 'POST',
            headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
            body: JSON.stringify(survivingTweets),
          })
          if (!tweetInsertRes.ok) {
            const err = await tweetInsertRes.text()
            console.error(`Tweet batch insert failed: ${tweetInsertRes.status} — ${err.substring(0, 300)}`)
          } else {
            console.log(`Inserted ${survivingTweets.length} surviving tweets (duplicates silently skipped)`)
          }
        }
      }
    }

    // ── Podcasts ─────────────────────────────────────────────────────────────

    if (!podcastSource) {
      console.log('No podcast source configured — skipping podcasts.')
    } else {

    console.log(`Podcast source: ${podcastSource.name} (${podcastSource.id})`)

    // 6. Fetch feed-podcasts.json from GitHub
    const podcastFeedRes = await fetch(FEED_PODCASTS_URL, {
      headers: { 'User-Agent': 'NewsProject-IngestBuilders/1.0' },
    })

    if (!podcastFeedRes.ok) {
      console.error(`Failed to fetch feed-podcasts.json: ${podcastFeedRes.status} ${podcastFeedRes.statusText}`)
    } else {

    const podcastRawData: unknown = await podcastFeedRes.json()
    const episodes = extractPodcasts(podcastRawData).filter(e => e.url && e.transcript)
    console.log(`Fetched ${episodes.length} podcast episodes from feed-podcasts.json`)

    if (episodes.length > 0) {
    // 7. Batch insert all episodes in ONE subrequest — duplicates silently skipped
    const podcastRows = episodes.map(ep => ({
      source_id: podcastSource.id,
      url: ep.url,
      raw_content: `${ep.name}: ${ep.title}\n\n${ep.transcript}`,
      status: 'pending',
      metadata: { show_name: ep.name },
      published_at: ep.publishedAt ?? null,
    }))

    const podcastInsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?on_conflict=url`, {
      method: 'POST',
      headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
      body: JSON.stringify(podcastRows),
    })

    if (!podcastInsertRes.ok) {
      const err = await podcastInsertRes.text()
      console.error(`Podcast batch insert failed: ${podcastInsertRes.status} — ${err.substring(0, 300)}`)
    } else {
      console.log(`Attempted ${episodes.length} podcast inserts (duplicates silently skipped)`)
    }
    } // end if (episodes.length > 0)
    } // end if (podcastFeedRes.ok)
    } // end if (podcastSource)

    // ── GitHub Trending + Product Hunt + Nowcoder + arXiv + Reddit ───────────
    const newRows: object[] = []

    // GitHub Trending — HTML scrape, no auth
    if (githubTrendingSource) {
      const ghRes = await fetch(GITHUB_TRENDING_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsProject/1.0)' },
      })
      if (ghRes.ok) {
        const html = await ghRes.text()
        const chunks = html.split(/<article\b/i).slice(1)
        const ghRepos: { repoPath: string; desc: string; stars: string }[] = []
        for (const chunk of chunks) {
          const hrefMatch = chunk.match(/href="(\/[^"\/]+\/[^"\/]+)"/)
          const descMatch = chunk.match(/<p[^>]*col-9[^>]*>([\s\S]*?)<\/p>/i)
          const starsMatch = chunk.match(/stargazers[^>]*>[\s\S]*?<\/svg>\s*([\d,]+)/i)
          if (!hrefMatch) continue
          const repoPath = hrefMatch[1]
          const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : ''
          const stars = starsMatch ? starsMatch[1].replace(/,/g, '') : ''
          ghRepos.push({ repoPath, desc, stars })
        }
        for (const { repoPath, desc, stars } of ghRepos) {
          const url = `https://github.com${repoPath}`
          const repoName = repoPath.slice(1)
          const raw_content = `${repoName}${desc ? ': ' + desc : ''}${stars ? ' (★ ' + stars + ' stars today)' : ''}`
          newRows.push({ source_id: githubTrendingSource.id, url, raw_content, status: 'pending', metadata: { stars: stars ? parseInt(stars) : 0 }, published_at: null })
        }
        console.log(`GitHub Trending: ${ghRepos.length} repos queued`)
      } else {
        console.error(`GitHub Trending fetch failed: ${ghRes.status}`)
      }
    }

    // Product Hunt — GraphQL API, requires PRODUCTHUNT_API_TOKEN
    if (productHuntSource) {
      if (!env.PRODUCTHUNT_API_TOKEN) {
        console.log('Product Hunt: PRODUCTHUNT_API_TOKEN not set, skipping')
      } else {
        const phRes = await fetch(PRODUCTHUNT_GQL_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.PRODUCTHUNT_API_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            query: `{ posts(first: 30, order: VOTES) { edges { node { id name tagline votesCount url createdAt } } } }`,
          }),
        })
        if (phRes.ok) {
          const phData = await phRes.json() as {
            data?: { posts?: { edges?: { node: { id: string; name: string; tagline: string; votesCount: number; url: string; createdAt?: string } }[] } }
          }
          const edges = phData?.data?.posts?.edges ?? []
          const countBefore = newRows.length
          for (const { node } of edges) {
            newRows.push({
              source_id: productHuntSource.id,
              url: node.url,
              raw_content: `${node.name}: ${node.tagline} (△ ${node.votesCount} votes)`,
              status: 'pending',
              metadata: { votes: node.votesCount },
              published_at: node.createdAt ?? null,
            })
          }
          console.log(`Product Hunt: ${newRows.length - countBefore} posts queued`)
        } else {
          console.error(`Product Hunt fetch failed: ${phRes.status}`)
        }
      }
    }

    // Nowcoder — undocumented public JSON API, no auth.
    // Hot-list returns title only; the post body is server-rendered into the
    // detail page's <script>window.__INITIAL_STATE__ = ...</script>. The
    // documented JSON detail endpoint (/api/sparta/discuss-pc/detail) returns
    // 404, so we scrape the SSR state instead. Top 5 only — every detail page
    // is one extra subrequest, and the hot list is sorted; items past the top
    // few rarely deliver the AI signal we want.
    if (nowcoderSource) {
      const ts = Date.now()
      const ncRes = await fetch(`${NOWCODER_HOT_URL}?size=20&_=${ts}&t=`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsProject/1.0)' },
      })
      if (ncRes.ok) {
        const typed = await ncRes.json() as { data?: { result?: { id: string; uuid?: string; title: string; type: number }[] } }
        const items = (typed?.data?.result ?? []).filter(it => it.title)
        const topItems = items.slice(0, 5)
        const countBefore = newRows.length

        // Parallel detail fetch — one HTML scrape per top item. Failure on any
        // single item falls back to title-only (matches today's behaviour, no
        // regression).
        const details = await Promise.all(topItems.map(async (item) => {
          const url = item.type === 74
            ? `https://www.nowcoder.com/feed/main/detail/${item.uuid}`
            : `https://www.nowcoder.com/discuss/${item.id}`
          let body = ''
          try {
            const detailRes = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsProject/1.0)' },
            })
            if (detailRes.ok) {
              const html = await detailRes.text()
              body = extractNowcoderContent(html)
            } else {
              console.error(`Nowcoder detail ${url} failed: ${detailRes.status}`)
            }
          } catch (err) {
            console.error(`Nowcoder detail ${url} error:`, (err as Error).message)
          }
          return { item, url, body }
        }))

        for (const { item, url, body } of details) {
          const raw_content = body ? `${item.title}\n\n${body}` : item.title
          newRows.push({ source_id: nowcoderSource.id, url, raw_content, status: 'pending', metadata: null, published_at: null })
        }
        console.log(`Nowcoder: ${newRows.length - countBefore} items queued (${details.filter(d => d.body).length} with body)`)
      } else {
        console.error(`Nowcoder fetch failed: ${ncRes.status}`)
      }
    }

    // ── arXiv — Atom API, one call per category ──────────────────────────────
    for (const src of arxivSources) {
      const category = src.name.replace('arXiv ', '') // "cs.AI" or "cs.LG"
      const arXivRes = await fetch(
        `https://export.arxiv.org/api/query?search_query=cat:${category}&max_results=10&sortBy=submittedDate&sortOrder=descending`,
        { headers: { 'User-Agent': 'NewsProject/1.0' } }
      )
      if (!arXivRes.ok) {
        console.error(`arXiv ${category} fetch failed: ${arXivRes.status}`)
        continue
      }
      const xml = await arXivRes.text()
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
      const countBefore = newRows.length
      let match: RegExpExecArray | null
      while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1]
        const idMatch      = entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([\d.]+)/)
        const titleMatch   = entry.match(/<title>([\s\S]*?)<\/title>/)
        const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/)
        const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/)
        if (!idMatch || !titleMatch) continue
        const arxivId = idMatch[1]
        const title   = titleMatch[1].trim().replace(/\s+/g, ' ')
        const summary = summaryMatch ? summaryMatch[1].trim().replace(/\s+/g, ' ') : ''
        const published_at = publishedMatch ? publishedMatch[1].trim() : null
        const url = `https://arxiv.org/abs/${arxivId}`
        const raw_content = summary ? `${title}\n\n${summary}` : title
        newRows.push({ source_id: src.id, url, raw_content, status: 'pending', metadata: { category }, published_at })
      }
      console.log(`arXiv ${category}: ${newRows.length - countBefore} papers queued`)
    }

    // ── AIHot ───────────────────────────────────────────────────────────────────
    if (aihotSource) {
      const aihotRows = await fetchAIHot(aihotSource, env.SUPABASE_URL, SB(env))
      newRows.push(...aihotRows)
    }

    // Batch INSERT all sources in one subrequest
    if (newRows.length > 0) {
      const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?on_conflict=url`, {
        method: 'POST',
        headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
        body: JSON.stringify(newRows),
      })
      if (!insertRes.ok) {
        const err = await insertRes.text()
        console.error(`Batch insert failed: ${insertRes.status} — ${err.substring(0, 300)}`)
      } else {
        console.log(`Batch inserted ${newRows.length} rows (duplicates silently skipped)`)
      }
    }
  },
}
