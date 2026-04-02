export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
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
    // 1. Get source rows for both builder tweets and podcasts (1 subrequest)
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&source_type=in.(github_feed,podcast,github_trending,producthunt,nowcoder,arxiv,reddit)&select=id,name,source_type`,
      { headers: SB(env) }
    )
    const sources: { id: string; name: string; source_type: string }[] = await sourcesRes.json()

    const builderSource        = sources.find(s => s.source_type === 'github_feed')
    const podcastSource        = sources.find(s => s.source_type === 'podcast')
    const githubTrendingSource = sources.find(s => s.source_type === 'github_trending')
    const productHuntSource    = sources.find(s => s.source_type === 'producthunt')
    const nowcoderSource       = sources.find(s => s.source_type === 'nowcoder')
    const arxivSources         = sources.filter(s => s.source_type === 'arxiv')
    const redditSources        = sources.filter(s => s.source_type === 'reddit')

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
        const bioMap = await extractBioMap(accounts, env.GROQ_API_KEY)
        if (Object.keys(bioMap).length > 0) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/sources?id=eq.${builderSource.id}`, {
            method: 'PATCH',
            headers: { ...SB(env), 'Prefer': 'return=minimal' },
            body: JSON.stringify({ metadata: { bio_map: bioMap } }),
          })
          console.log(`Bio map updated: ${Object.keys(bioMap).length} handles`)
        }

        // 4. Filter valid tweets (must have id, text, and url)
        const validTweets = tweets.filter(t => t.id && t.text && t.url)
        console.log(`Inserting ${validTweets.length} valid tweets`)

        // 5. Insert into raw_ingestion — duplicates silently skipped via ON CONFLICT (url)
        await Promise.all(
          validTweets.map(tweet => {
            const author = extractAuthor(tweet.url)
            const rawContent = author ? `@${author}: ${tweet.text}` : tweet.text

            return fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion`, {
              method: 'POST',
              headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
              body: JSON.stringify({
                source_id: builderSource.id,
                url: tweet.url,
                raw_content: rawContent,
                status: 'pending',
                metadata: { likes: tweet.likes ?? 0, retweets: tweet.retweets ?? 0 },
                published_at: tweet.createdAt ?? null,
              }),
            })
          })
        )
        console.log(`Attempted ${validTweets.length} tweet inserts (duplicates silently skipped)`)
      }
    }

    // ── Podcasts ─────────────────────────────────────────────────────────────

    if (!podcastSource) {
      console.log('No podcast source configured. Run the INSERT SQL first.')
      return
    }

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
      metadata: null,
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
          newRows.push({ source_id: githubTrendingSource.id, url, raw_content, status: 'pending', metadata: { stars: stars ? parseInt(stars) : 0 } })
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

    // Nowcoder — undocumented public JSON API, no auth
    if (nowcoderSource) {
      const ts = Date.now()
      const ncRes = await fetch(`${NOWCODER_HOT_URL}?size=20&_=${ts}&t=`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsProject/1.0)' },
      })
      if (ncRes.ok) {
        const typed = await ncRes.json() as { data?: { result?: { id: string; uuid?: string; title: string; type: number }[] } }
        const items = typed?.data?.result ?? []
        const countBefore = newRows.length
        for (const item of items) {
          if (!item.title) continue
          const url = item.type === 74
            ? `https://www.nowcoder.com/feed/main/detail/${item.uuid}`
            : `https://www.nowcoder.com/discuss/${item.id}`
          newRows.push({ source_id: nowcoderSource.id, url, raw_content: item.title, status: 'pending', metadata: null })
        }
        console.log(`Nowcoder: ${newRows.length - countBefore} items queued`)
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

    // ── Reddit — public JSON API, one call per subreddit ─────────────────────
    for (const src of redditSources) {
      const subreddit = src.name.replace('Reddit r/', '')
      const rdRes = await fetch(
        `https://www.reddit.com/r/${subreddit}/hot.json?limit=25`,
        { headers: { 'User-Agent': 'NewsProject/1.0' } }
      )
      if (!rdRes.ok) {
        console.error(`Reddit r/${subreddit} fetch failed: ${rdRes.status}`)
        continue
      }
      const rdData = await rdRes.json() as {
        data?: { children?: { data: { title: string; url: string; permalink: string; score: number; num_comments: number; is_self: boolean; subreddit: string; created_utc: number } }[] }
      }
      const posts = rdData?.data?.children ?? []
      const countBefore = newRows.length
      for (const { data: post } of posts) {
        if (!post.title) continue
        const url = post.is_self
          ? `https://reddit.com${post.permalink}`
          : post.url
        newRows.push({
          source_id: src.id,
          url,
          raw_content: `r/${post.subreddit}: ${post.title}`,
          status: 'pending',
          metadata: { score: post.score, num_comments: post.num_comments, subreddit: post.subreddit },
          published_at: new Date(post.created_utc * 1000).toISOString(),
        })
      }
      console.log(`Reddit r/${subreddit}: ${newRows.length - countBefore} posts queued`)
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
