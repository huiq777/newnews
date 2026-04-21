export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  FEISHU_WEBHOOK_URL: string            // required
  SLACK_WEBHOOK_URL?: string            // optional
  DISCORD_WEBHOOK_URL?: string          // optional
  NOTION_API_KEY?: string               // optional
  NOTION_DATABASE_ID?: string           // optional
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
  summary_zh: string | null
  url: string
  source_id: string
  created_at: string
  engagement?: { likes?: number; retweets?: number } | null
}

interface Source {
  id: string
  name: string
  metadata?: { bio_map?: Record<string, string> }
}

interface TrendBrief {
  synthesis_en: string | null
  synthesis_zh: string | null
}

function extractBullets(summary: string | null, count: number): string {
  if (!summary) return ''
  return summary
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('•'))
    .slice(0, count)
    .join('\n')
}

// ── Feishu (Chinese, unchanged format from send-feishu-digest) ────────────────
function buildFeishuCard(
  articles: Article[],
  trendBrief: TrendBrief | null,
  sourceMap: Record<string, string>,
  bioMap: Record<string, string>,
  today: string,
) {
  const elements: object[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**${articles.length} articles today · ${today}**` },
    },
    { tag: 'hr' },
  ]

  if (trendBrief?.synthesis_zh) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**趋势简报**\n${trendBrief.synthesis_zh.substring(0, 2000)}` },
    })
    elements.push({ tag: 'hr' })
  }

  if (articles.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '_No articles ingested in the last 24 hours._' },
    })
  }

  for (const article of articles) {
    const xHandle = article.url.match(/x\.com\/([^/]+)\/status\//)?.[1]
    const xBio = xHandle ? bioMap[xHandle.toLowerCase()] : undefined
    const sourceName = xHandle
      ? `X - @${xHandle}${xBio ? ` - **${xBio}**` : ''}`
      : (sourceMap[article.source_id] || 'Unknown')
    const title = article.title_zh || article.title_en || 'Untitled'
    const bullets = extractBullets(article.summary_zh, 3)
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**[${title}](${article.url})**\n${sourceName}${article.engagement?.likes ? ` · 🔥 **${article.engagement.likes}** likes` : ''}${bullets ? '\n' + bullets : ''}`,
      },
    })
    elements.push({ tag: 'hr' })
  }

  return {
    msg_type: 'interactive',
    card: {
      header: { title: { content: 'Daily Tech Digest', tag: 'plain_text' }, template: 'blue' },
      elements,
    },
  }
}

async function sendFeishu(
  articles: Article[],
  trendBrief: TrendBrief | null,
  sourceMap: Record<string, string>,
  bioMap: Record<string, string>,
  today: string,
  env: Env,
): Promise<void> {
  const card = buildFeishuCard(articles, trendBrief, sourceMap, bioMap, today)
  const res = await fetch(env.FEISHU_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error(`Feishu failed: ${res.status} — ${errText.substring(0, 300)}`)
    return
  }
  console.log(`Feishu sent: ${articles.length} articles`)
}

// ── Slack (English) ───────────────────────────────────────────────────────────
async function sendSlack(
  articles: Article[],
  trendBrief: TrendBrief | null,
  today: string,
  env: Env,
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return

  const blocks: object[] = [
    { type: 'header', text: { type: 'plain_text', text: `Daily Tech Digest — ${today}` } },
  ]

  if (trendBrief?.synthesis_en) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Trend Brief*\n${trendBrief.synthesis_en.substring(0, 2900)}` },
    })
    blocks.push({ type: 'divider' })
  }

  for (const article of articles.slice(0, 10)) {
    const title = article.title_en || article.title_zh || 'Untitled'
    const bullets = extractBullets(article.summary_en, 3)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*<${article.url}|${title.substring(0, 150)}>*\n${bullets}` },
    })
  }

  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  })
  if (!res.ok) console.error(`Slack failed: ${res.status} — ${await res.text().catch(() => '')}`)
  else console.log('Slack sent')
}

// ── Discord (English, embed format) ──────────────────────────────────────────
async function sendDiscord(
  articles: Article[],
  trendBrief: TrendBrief | null,
  today: string,
  env: Env,
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return

  const embeds: object[] = []

  if (trendBrief?.synthesis_en) {
    embeds.push({
      title: `Trend Brief — ${today}`,
      description: trendBrief.synthesis_en.substring(0, 4096),
      color: 0x3B82F6,
    })
  }

  for (const article of articles.slice(0, 5)) {
    const title = article.title_en || article.title_zh || 'Untitled'
    const bullets = extractBullets(article.summary_en, 2)
    embeds.push({
      title: title.substring(0, 256),
      url: article.url,
      description: bullets.substring(0, 4096),
      color: 0x6B7280,
    })
  }

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds }),
  })
  if (!res.ok) console.error(`Discord failed: ${res.status} — ${await res.text().catch(() => '')}`)
  else console.log('Discord sent')
}

// ── Notion (English, new page in database) ────────────────────────────────────
async function sendNotion(
  articles: Article[],
  trendBrief: TrendBrief | null,
  today: string,
  env: Env,
): Promise<void> {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return

  const children: object[] = []

  if (trendBrief?.synthesis_en) {
    children.push({
      object: 'block', type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'Trend Brief' } }] },
    })
    const syn = trendBrief.synthesis_en
    for (let i = 0; i < syn.length; i += 2000) {
      children.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: syn.slice(i, i + 2000) } }] },
      })
    }
    children.push({ object: 'block', type: 'divider', divider: {} })
  }

  children.push({
    object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: 'Articles' } }] },
  })

  for (const article of articles) {
    const title = (article.title_en || article.title_zh || 'Untitled').substring(0, 100)
    const bullets = extractBullets(article.summary_en, 3)
    children.push({
      object: 'block', type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [
          { type: 'text', text: { content: title, link: { url: article.url } } },
          { type: 'text', text: { content: bullets ? `\n${bullets}` : '' } },
        ],
      },
    })
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties: {
        title: { title: [{ type: 'text', text: { content: `Tech Digest — ${today}` } }] },
      },
      children,
    }),
  })
  if (!res.ok) console.error(`Notion failed: ${res.status} — ${await res.text().catch(() => '')}`)
  else console.log('Notion page created')
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch() {
    return new Response('send-digest is running')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const today = new Date().toISOString().split('T')[0]

    // Fetch articles, sources, and today's trend brief in parallel
    const [articlesRes, sourcesRes, trendBriefRes] = await Promise.all([
      fetch(
        `${env.SUPABASE_URL}/rest/v1/daily_news?created_at=gte.${since}&order=created_at.desc&limit=10&select=id,title_en,title_zh,summary_en,summary_zh,url,source_id,created_at,engagement`,
        { headers: SB(env) }
      ),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/sources?select=id,name,metadata`,
        { headers: SB(env) }
      ),
      fetch(
        `${env.SUPABASE_URL}/rest/v1/trend_briefs?anchor_date=eq.${today}&step_days=eq.1&order=generated_at.desc&limit=1&select=synthesis_en,synthesis_zh`,
        { headers: SB(env) }
      ),
    ])

    if (!articlesRes.ok) {
      console.error(`Supabase articles fetch failed: ${articlesRes.status}`)
      return
    }
    if (!sourcesRes.ok) {
      console.error(`Supabase sources fetch failed: ${sourcesRes.status}`)
      return
    }
    const articles: Article[] = await articlesRes.json()
    const sources: Source[] = await sourcesRes.json()
    const trendBriefs: TrendBrief[] = trendBriefRes.ok ? await trendBriefRes.json() : []
    const trendBrief: TrendBrief | null = trendBriefs[0] ?? null

    console.log(`Fetched ${articles.length} articles, trend brief: ${trendBrief ? 'present' : 'absent'}`)

    const sourceMap: Record<string, string> = {}
    const bioMap: Record<string, string> = {}
    for (const s of sources) {
      sourceMap[s.id] = s.name
      if (s.metadata?.bio_map) Object.assign(bioMap, s.metadata.bio_map)
    }

    // Deliver to all channels independently — one failure does not block others
    await Promise.all([
      sendFeishu(articles, trendBrief, sourceMap, bioMap, today, env).catch(e => console.error('Feishu error:', e)),
      sendSlack(articles, trendBrief, today, env).catch(e => console.error('Slack error:', e)),
      sendDiscord(articles, trendBrief, today, env).catch(e => console.error('Discord error:', e)),
      sendNotion(articles, trendBrief, today, env).catch(e => console.error('Notion error:', e)),
    ])

    console.log(`Digest complete for ${today}`)
  },
}
