export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  X_BEARER_TOKEN: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

export default {
  async fetch() { return new Response('ingest-x worker is running') },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // 1. Get active X sources (source_type = 'x_api')
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&source_type=eq.x_api&select=id,name,rss_url`,
      { headers: SB(env) }
    )
    const sources: { id: string; name: string; rss_url: string }[] = await sourcesRes.json()
    if (sources.length === 0) { console.log('No X sources configured.'); return }
    console.log(`Fetching tweets for ${sources.length} X accounts`)

    // 2. Fetch recent tweets for each account in parallel
    await Promise.all(sources.map(source => fetchAndIngest(source, env)))

    console.log('Done.')
  },
}

async function fetchAndIngest(
  source: { id: string; name: string; rss_url: string },
  env: Env
) {
  // rss_url stores the X user ID in format "x://user/<numeric_id>"
  const userIdMatch = source.rss_url.match(/^x:\/\/user\/(\d+)$/)
  if (!userIdMatch) {
    console.error(`Invalid rss_url format for X source "${source.name}": ${source.rss_url}`)
    return
  }
  const userId = userIdMatch[1]

  try {
    // X API v2 free tier: user timeline, last 10 tweets
    const res = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=created_at,text&exclude=retweets,replies`,
      {
        headers: {
          'Authorization': `Bearer ${env.X_BEARER_TOKEN}`,
        },
      }
    )

    if (!res.ok) {
      const errText = await res.text()
      console.error(`X API error for user ${userId} (${source.name}): ${res.status} ${errText.substring(0, 200)}`)
      return
    }

    const data: any = await res.json()
    const tweets: { id: string; text: string }[] = data.data || []

    if (tweets.length === 0) {
      console.log(`No new tweets for ${source.name}`)
      return
    }

    // 3. Insert each tweet into raw_ingestion — duplicates skipped via ON CONFLICT
    await Promise.all(
      tweets.map(tweet => {
        const tweetUrl = `https://x.com/i/web/status/${tweet.id}`
        return fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion`, {
          method: 'POST',
          headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            source_id: source.id,
            url: tweetUrl,
            raw_content: tweet.text,
            status: 'pending',
          }),
        })
      })
    )

    console.log(`${source.name}: attempted ${tweets.length} tweet inserts`)
  } catch (e) {
    console.error(`Failed to fetch tweets for ${source.name}:`, e)
  }
}
