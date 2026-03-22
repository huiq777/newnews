export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  FEISHU_WEBHOOK_URL: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

interface Article {
  id: string
  title_en: string | null
  title_zh: string | null
  summary_zh: string | null
  url: string
  source_id: string
  created_at: string
  engagement?: { likes?: number; retweets?: number; hn_score?: number; hn_comments?: number } | null
}

interface Source {
  id: string
  name: string
  metadata?: { bio_map?: Record<string, string> }
}

// Extract first N bullet points from summary_zh (format: "• **Label:** text")
function extractBullets(summaryZh: string | null, count: number): string {
  if (!summaryZh) return ''
  return summaryZh
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('•'))
    .slice(0, count)
    .join('\n')
}

function buildFeishuCard(
  articles: Article[],
  sourceMap: Record<string, string>,
  bioMap: Record<string, string>,
  today: string
) {
  const elements: object[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${articles.length} articles today · ${today}**`,
      },
    },
    { tag: 'hr' },
  ]

  if (articles.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '_No articles ingested in the last 24 hours._',
      },
    })
  }

  for (const article of articles) {
    const xHandle = article.url.match(/x\.com\/([^/]+)\/status\//)?.[1]
    const xBio = xHandle ? bioMap[xHandle.toLowerCase()] : undefined
    const sourceName = xHandle ? `X - @${xHandle}${xBio ? ` - ${xBio}` : ''}` : (sourceMap[article.source_id] || 'Unknown')
    const title = article.title_zh || article.title_en || 'Untitled'
    const bullets = extractBullets(article.summary_zh, 3)

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**[${title}](${article.url})**\n\`${sourceName}\`${article.engagement?.likes ? ` · 🔥 ${article.engagement.likes} likes` : article.engagement?.hn_score ? ` · ▲ ${article.engagement.hn_score} HN` : ''}${bullets ? '\n' + bullets : ''}`,
      },
    })
    elements.push({ tag: 'hr' })
  }

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { content: 'Daily Tech Digest', tag: 'plain_text' },
        template: 'blue',
      },
      elements,
    },
  }
}

export default {
  async fetch() {
    return new Response('send-feishu-digest is running')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const today = new Date().toISOString().split('T')[0]

    // Fetch articles and sources in parallel
    const [articlesRes, sourcesRes] = await Promise.all([
      fetch(
        `${env.SUPABASE_URL}/rest/v1/daily_news?created_at=gte.${since}&order=created_at.desc&limit=10&select=id,title_en,title_zh,summary_zh,url,source_id,created_at,engagement`,
        { headers: SB(env) }
      ),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/sources?select=id,name,metadata`,
        { headers: SB(env) }
      ),
    ])

    const articles: Article[] = await articlesRes.json()
    const sources: Source[] = await sourcesRes.json()

    console.log(`Fetched ${articles.length} articles for digest`)

    const sourceMap: Record<string, string> = {}
    const bioMap: Record<string, string> = {}
    for (const s of sources) {
      sourceMap[s.id] = s.name
      if (s.metadata?.bio_map) Object.assign(bioMap, s.metadata.bio_map)
    }

    const card = buildFeishuCard(articles, sourceMap, bioMap, today)

    try {
      const feishuRes = await fetch(env.FEISHU_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      })

      if (!feishuRes.ok) {
        const errText = await feishuRes.text()
        console.error(`Feishu webhook failed: ${feishuRes.status} — ${errText.substring(0, 300)}`)
        return
      }

      console.log(`Feishu digest sent: ${articles.length} articles for ${today}`)
    } catch (e) {
      console.error('Feishu POST threw:', e)
    }
  },
}
