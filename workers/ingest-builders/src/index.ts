export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

const FEED_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json'

interface BuilderTweet {
  id: string
  text: string
  createdAt: string
  url: string
  likes?: number
  retweets?: number
  replies?: number
  isQuote?: boolean
  quotedTweetId?: string | null
}

// Extract @handle from tweet URL: https://x.com/karpathy/status/... → "karpathy"
function extractAuthor(url: string): string | null {
  const match = url.match(/x\.com\/([^/]+)\/status\//)
  return match ? match[1] : null
}

// Flatten feed-x.json regardless of whether it's an array or keyed object
function flattenFeed(data: unknown): BuilderTweet[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    return Object.values(data as Record<string, BuilderTweet[]>).flat()
  }
  return []
}

export default {
  async fetch() {
    return new Response('ingest-builders is running')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // 1. Get source row for follow-builders feed
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&source_type=eq.github_feed&select=id,name`,
      { headers: SB(env) }
    )
    const sources: { id: string; name: string }[] = await sourcesRes.json()

    if (sources.length === 0) {
      console.log('No github_feed sources configured. Run the INSERT SQL first.')
      return
    }

    const source = sources[0]
    console.log(`Source: ${source.name} (${source.id})`)

    // 2. Fetch feed-x.json from GitHub (public URL, no auth needed)
    const feedRes = await fetch(FEED_URL, {
      headers: { 'User-Agent': 'NewsProject-IngestBuilders/1.0' },
    })

    if (!feedRes.ok) {
      console.error(`Failed to fetch feed-x.json: ${feedRes.status} ${feedRes.statusText}`)
      return
    }

    const rawData: unknown = await feedRes.json()
    const tweets = flattenFeed(rawData)
    console.log(`Fetched ${tweets.length} builder tweets from feed-x.json`)

    // 3. Filter valid tweets (must have id, text, and url)
    const validTweets = tweets.filter(t => t.id && t.text && t.url)

    if (validTweets.length === 0) {
      console.log('No valid tweets found in feed.')
      return
    }

    // 4. Insert into raw_ingestion — duplicates silently skipped via ON CONFLICT (url)
    await Promise.all(
      validTweets.map(tweet => {
        const author = extractAuthor(tweet.url)
        // Prepend @handle so Groq understands who said what when summarizing
        const rawContent = author ? `@${author}: ${tweet.text}` : tweet.text

        return fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion`, {
          method: 'POST',
          headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            source_id: source.id,
            url: tweet.url,         // canonical x.com URL — UNIQUE key for deduplication
            raw_content: rawContent,
            status: 'pending',
          }),
        })
      })
    )

    console.log(`Attempted ${validTweets.length} inserts (duplicates silently skipped)`)
  },
}
