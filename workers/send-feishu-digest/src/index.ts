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
  summary_en: string | null
  url: string
  source_id: string
  created_at: string
}

interface Source {
  id: string
  name: string
}

// Extract first N bullet points from summary_en (format: "• **Label:** text")
function extractBullets(summaryEn: string | null, count: number): string {
  if (!summaryEn) return ''
  return summaryEn
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('•'))
    .slice(0, count)
    .join('\n')
}

function buildFeishuCard(
  articles: Article[],
  sourceMap: Record<string, string>,
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
    const sourceName = sourceMap[article.source_id] || 'Unknown'
    const title = article.title_en || article.title_zh || 'Untitled'
    const bullets = extractBullets(article.summary_en, 2)

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**[${title}](${article.url})**\n\`${sourceName}\`${bullets ? '\n' + bullets : ''}`,
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

    // Fetch articles and sources in parallel — two separate calls (avoid PostgREST join staleness)
    const [articlesRes, sourcesRes] = await Promise.all([
      fetch(
        `${env.SUPABASE_URL}/rest/v1/daily_news?created_at=gte.${since}&order=created_at.desc&limit=10&select=id,title_en,title_zh,summary_en,url,source_id,created_at`,
        { headers: SB(env) }
      ),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/sources?select=id,name`,
        { headers: SB(env) }
      ),
    ])

    const articles: Article[] = await articlesRes.json()
    const sources: Source[] = await sourcesRes.json()

    console.log(`Fetched ${articles.length} articles for digest`)

    const sourceMap: Record<string, string> = {}
    for (const s of sources) sourceMap[s.id] = s.name

    const card = buildFeishuCard(articles, sourceMap, today)

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
