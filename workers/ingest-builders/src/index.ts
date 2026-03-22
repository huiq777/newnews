export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GROQ_API_KEY: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

const FEED_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json'
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions'

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

// One batch Groq call → {handle: "current position"} for all accounts with bios
async function extractBioMap(accounts: BuilderAccount[], groqApiKey: string): Promise<Record<string, string>> {
  const withBio = accounts.filter(a => a.handle && a.bio)
  if (withBio.length === 0) return {}

  const prompt = withBio.map(a => `@${a.handle}: ${a.bio}`).join('\n')

  const res = await fetch(GROQ_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You extract professional titles, roles, and credentials from Twitter bios. Output ONE flat JSON object where keys are handles and values are the exact, unabbreviated title strings extracted directly from the bio.\n\nRules:\n1. For people: DO NOT summarize, abbreviate, or alter the titles. Extract the exact relevant text verbatim. Include previous roles, multiple affiliations, or degrees if listed. Exclude conversational filler or hobbies (e.g., drop "I like to train large deep neural nets.").\n2. For products: Use the format "[Name] is [Exact Description] @[Company]".\n\nExample output:\n{"karpathy": "Previously Director of AI @ Tesla, founding team @ OpenAI, PhD @ Stanford", "claudeai": "Claude is LLM @Anthropic"}\n\nNo arrays, no extra keys, no markdown blocks (like ```json), no explanation.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 600,
      temperature: 0,
    }),
  })

  if (!res.ok) {
    console.error(`Groq bio extraction failed: ${res.status}`)
    return {}
  }

  const data = await res.json() as { choices: [{ message: { content: string } }] }
  const content = data.choices[0].message.content.trim()

  // Try flat object first: {"karpathy": "Director of AI"}
  try {
    return JSON.parse(content) as Record<string, string>
  } catch { /* fall through */ }

  // Fallback: Groq returned JSONL — one {"handle": x, "role": y} per line
  try {
    const result: Record<string, string> = {}
    content.split('\n').forEach(line => {
      const trimmed = line.trim()
      if (!trimmed) return
      const obj = JSON.parse(trimmed) as { handle?: string; role?: string }
      if (obj.handle && obj.role) result[obj.handle.toLowerCase()] = obj.role
    })
    if (Object.keys(result).length > 0) return result
  } catch { /* fall through */ }

  console.error('Failed to parse bio map JSON from Groq:', content.slice(0, 200))
  return {}
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
    const accounts = extractAccounts(rawData)
    const tweets = accounts.flatMap(a => a.tweets ?? [])
    console.log(`Fetched ${tweets.length} builder tweets from feed-x.json`)

    // 3. Extract AI-interpreted positions from bios → cache in sources.metadata
    const bioMap = await extractBioMap(accounts, env.GROQ_API_KEY)
    if (Object.keys(bioMap).length > 0) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/sources?id=eq.${source.id}`, {
        method: 'PATCH',
        headers: { ...SB(env), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ metadata: { bio_map: bioMap } }),
      })
      console.log(`Bio map updated: ${Object.keys(bioMap).length} handles`)
    }

    // 4. Filter valid tweets (must have id, text, and url)
    const validTweets = tweets.filter(t => t.id && t.text && t.url)

    if (validTweets.length === 0) {
      console.log('No valid tweets found in feed.')
      return
    }

    // 5. Insert into raw_ingestion — duplicates silently skipped via ON CONFLICT (url)
    await Promise.all(
      validTweets.map(tweet => {
        const author = extractAuthor(tweet.url)
        const rawContent = author ? `@${author}: ${tweet.text}` : tweet.text

        return fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion`, {
          method: 'POST',
          headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            source_id: source.id,
            url: tweet.url,
            raw_content: rawContent,
            status: 'pending',
            metadata: { likes: tweet.likes ?? 0, retweets: tweet.retweets ?? 0 },
          }),
        })
      })
    )

    console.log(`Attempted ${validTweets.length} inserts (duplicates silently skipped)`)
  },
}
