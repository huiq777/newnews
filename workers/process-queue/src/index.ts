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

export default {
  async fetch() {
    return new Response('ok')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?status=eq.pending&limit=5&select=id,source_id,url,raw_content`,
      { headers: SB(env) }
    )
    const articles: { id: string; source_id: string; url: string; raw_content: string }[] = await res.json()

    if (articles.length === 0) {
      console.log('No pending articles.')
      return
    }

    console.log(`Processing ${articles.length} articles`)

    await Promise.all(
      articles.map(a =>
        fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${a.id}`, {
          method: 'PATCH',
          headers: SB(env),
          body: JSON.stringify({ status: 'processing' }),
        })
      )
    )

    await Promise.all(articles.map(a => processArticle(a, env)))
    console.log('Done.')
  },
}

async function generateQuestions(
  summary_en: string,
  summary_zh: string,
  env: Env
): Promise<{ en: string[]; zh: string[] } | null> {
  try {
    const [enRes, zhRes] = await Promise.all([
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.7,
          max_tokens: 300,
          messages: [
            { role: 'system', content: 'You are an expert news analyst. Return ONLY a valid JSON array of 3 strings. Do not use markdown blocks (```json), no preamble, no numbering.' },
            { role: 'user', content: `Based on the article summary below, generate exactly 3 highly analytical questions that a critical reader would ask to explore the topic deeper.\n\nRequirements:\n1. Focus on implications, root causes, or future impacts (avoid simple yes/no or basic factual questions).\n2. Each question must be thorough, well-articulated, and a complete sentence (aim for 10-25 words each).\n3. Return strictly a JSON array of 3 strings. Example: ["How might this development impact X in the long term?", "What are the underlying systemic causes of Y?", "Why did the stakeholders choose this specific approach to Z?"]\n\nSummary:\n${summary_en}` },
          ],
        }),
      }),
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.7,
          max_tokens: 300,
          messages: [
            { role: 'system', content: '你是一位资深新闻分析师。只返回包含3个字符串的合规JSON数组。绝不要输出Markdown格式（如```json），不要任何前言、解释或编号。' },
            { role: 'user', content: `根据以下文章摘要，生成3个具有深度和洞察力的问题，引导读者进行批判性思考。\n\n要求：\n1. 问题需探讨深层影响、根本原因或未来发展（绝不能是简单的"是/否"或基础事实核查）。\n2. 每个问题必须是完整、具体的句子（约15-35个汉字），避免过于简短。\n3. 严格返回包含3个字符串的JSON数组。示例：["这一发展在长远来看将如何影响该行业的生态？", "导致这一事件爆发的深层结构性原因是什么？", "为什么相关利益方会选择这种特定的应对策略？"]\n\n摘要：\n${summary_zh}` },
          ],
        }),
      }),
    ])

    if (!enRes.ok || !zhRes.ok) return null

    const [enData, zhData]: any[] = await Promise.all([enRes.json(), zhRes.json()])
    const enText = enData.choices?.[0]?.message?.content?.trim() || '[]'
    const zhText = zhData.choices?.[0]?.message?.content?.trim() || '[]'

    const en: string[] = JSON.parse(enText)
    const zh: string[] = JSON.parse(zhText)

    if (!Array.isArray(en) || !Array.isArray(zh)) return null
    return { en: en.slice(0, 3), zh: zh.slice(0, 3) }
  } catch {
    return null
  }
}

async function fetchArticleContent(url: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timeout)
    if (!res.ok) return ''

    const texts: string[] = []
    const STRIP = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript']
    let rewriter = new HTMLRewriter()
    for (const sel of STRIP) {
      rewriter = rewriter.on(sel, { element(el) { el.remove() } })
    }
    rewriter = rewriter.on('p, h1, h2, h3', {
      text(chunk) { if (chunk.text.trim()) texts.push(chunk.text.trim()) },
    })

    // Must consume the output stream or HTMLRewriter never runs
    await rewriter.transform(res).text()

    const result = texts.join(' ').replace(/\s+/g, ' ').trim()

    // Paywall detection: fall back if content looks like a subscription wall
    const lede = result.slice(0, 300).toLowerCase()
    if (lede.includes('subscribe') && lede.includes('sign in')) return ''

    return result
  } catch {
    clearTimeout(timeout)
    return ''
  }
}

async function insertAndMarkDone(
  article: { id: string; source_id: string; url: string },
  title: string,
  summary: string,
  title_en: string,
  summary_en: string,
  title_zh: string,
  summary_zh: string,
  questions: { en: string[]; zh: string[] } | null,
  articleContent: string,
  env: Env
) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/daily_news`, {
    method: 'POST',
    headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      source_id: article.source_id,
      raw_ingestion_id: article.id,
      url: article.url,
      title,
      summary,
      title_en,
      summary_en,
      title_zh,
      summary_zh,
      questions,
      article_content: articleContent || null,
    }),
  })

  // For articles already in daily_news (duplicate URL), patch article_content separately
  // since ignore-duplicates silently skips the insert without updating existing rows
  if (articleContent) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/daily_news?url=eq.${encodeURIComponent(article.url)}`, {
      method: 'PATCH',
      headers: SB(env),
      body: JSON.stringify({ article_content: articleContent }),
    })
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
    method: 'PATCH',
    headers: SB(env),
    body: JSON.stringify({ status: 'done', processed_at: new Date().toISOString() }),
  })
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function parseSection(text: string, tag: string): string {
  const match = text.match(new RegExp(`${tag}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`))
  return match?.[1]?.trim() || ''
}

async function processArticle(
  article: { id: string; source_id: string; url: string; raw_content: string },
  env: Env
) {
  try {
    const rawContent = stripHtml((article.raw_content || '').trim())

    if (rawContent.length === 0) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
        method: 'PATCH',
        headers: SB(env),
        body: JSON.stringify({ status: 'error', last_error: 'empty raw_content' }),
      })
      console.log(`SKIP (empty): ${article.url}`)
      return
    }

    // Attempt full article fetch; fall back to RSS snippet if scraping fails or content is thin
    const articleContent = await fetchArticleContent(article.url)
    const contentForGroq = (articleContent.length > 500 ? articleContent : rawContent).substring(0, 24000)
    console.log(`Content source: ${articleContent.length > 500 ? `scraped (${articleContent.length} chars)` : `rss snippet (${rawContent.length} chars)`}`)

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content: `You are an expert tech editor. Analyze the article and produce a bilingual title and summary for a mobile news feed.

Output EXACTLY this structure — no deviations, no extra text:

TITLE_EN: [Punchy English title under 60 characters. No clickbait.]
TITLE_ZH: [Concise Chinese title under 20 characters.]

SUMMARY_EN:
• **[Core Event]:** [1-2 sentences on what happened or the main thesis.]
• **[Crucial Detail]:** [1-2 sentences on the key data point, spec, or figure.]
• **[The Impact]:** [1-2 sentences on why this matters to tech/business.]

SUMMARY_ZH:
• **[核心事件]:** [1-2句话说明发生了什么或主要论点。]
• **[关键细节]:** [1-2句话说明最重要的数据点、技术规格或财务数字。]
• **[影响]:** [1-2句话说明这对科技/商业领域意味着什么。]

Strict rules:
1. Start immediately with "TITLE_EN:". No intro or outro.
2. CRITICAL — never translate proper nouns, brand names, or product names. They must appear character-for-character identical in both the English and Chinese versions. If the source text says "OpenClaw", write "OpenClaw" in TITLE_ZH and SUMMARY_ZH — not "开放爪" or any phonetic/semantic translation. If the source text says "飞书", write "飞书" in TITLE_EN and SUMMARY_EN — not "Feishu" or "FlyBook". Translating a proper noun is a critical error.
3. Ignore boilerplate, ads, nav menus, and newsletter signups.
4. If the text lacks enough signal, output exactly: INSUFFICIENT_CONTENT`,
          },
          {
            role: 'user',
            content: `Summarize this article:\n\n${contentForGroq}`,
          },
        ],
      }),
    })

    if (!groqRes.ok) {
      const errText = await groqRes.text()
      throw new Error(`Groq ${groqRes.status}: ${errText.substring(0, 200)}`)
    }

    const data: any = await groqRes.json()
    const responseText = (data.choices?.[0]?.message?.content || '').trim()

    if (!responseText) {
      throw new Error('Groq returned empty response')
    }

    if (responseText === 'INSUFFICIENT_CONTENT') {
      await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
        method: 'PATCH', headers: SB(env),
        body: JSON.stringify({ status: 'error', last_error: 'INSUFFICIENT_CONTENT' }),
      })
      console.log(`SKIP (insufficient): ${article.url}`)
      return
    }

    const title_en = parseSection(responseText, 'TITLE_EN')
    const title_zh = parseSection(responseText, 'TITLE_ZH')
    const summary_en = parseSection(responseText, 'SUMMARY_EN')
    const summary_zh = parseSection(responseText, 'SUMMARY_ZH')

    const title = title_en || title_zh || 'Untitled'
    const summary = summary_en || summary_zh || ''

    const questions = await generateQuestions(summary_en, summary_zh, env)

    await insertAndMarkDone(article, title, summary, title_en, summary_en, title_zh, summary_zh, questions, articleContent, env)
    console.log(`OK: ${article.url}`)

  } catch (err: any) {
    console.error(`FAIL: ${article.url}`, err.message)

    const countRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}&select=retry_count`,
      { headers: SB(env) }
    )
    const countData = await countRes.json() as { retry_count: number }[]
    const newCount = (countData[0]?.retry_count ?? 0) + 1

    await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
      method: 'PATCH',
      headers: SB(env),
      body: JSON.stringify({
        retry_count: newCount,
        last_error: err.message || String(err),
        status: newCount >= 3 ? 'error' : 'pending',
      }),
    })
  }
}
