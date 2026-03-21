import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

async function callGroq(prompt: string, systemMsg: string, apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt },
      ],
    }),
  })
  const data: any = await res.json()
  const text = data.choices?.[0]?.message?.content?.trim() || '[]'
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.slice(0, 3) : []
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const { article_id } = await req.json()
  const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sbHeaders = { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

  // Fetch article summaries
  const sbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_news?id=eq.${article_id}&select=summary_en,summary_zh`,
    { headers: sbHeaders }
  )
  const rows: any[] = await sbRes.json()
  const article = rows[0]
  if (!article) return new Response('Not found', { status: 404, headers: corsHeaders })

  const [en, zh] = await Promise.all([
    callGroq(
      `Based on the article summary below, generate exactly 3 highly analytical questions that a critical reader would ask to explore the topic deeper.

Requirements:
1. Focus on implications, root causes, or future impacts (avoid simple yes/no or basic factual questions).
2. Each question must be thorough, well-articulated, and a complete sentence (aim for 10-25 words each).
3. Return strictly a JSON array of 3 strings. Example: ["How might this development impact X in the long term?", "What are the underlying systemic causes of Y?", "Why did the stakeholders choose this specific approach to Z?"]

Summary:
${article.summary_en}`,
      'You are an expert news analyst. Return ONLY a valid JSON array of 3 strings. Do not use markdown blocks (```json), no preamble, no numbering.',
      GROQ_API_KEY
    ),
    callGroq(
      `根据以下文章摘要，生成3个具有深度和洞察力的问题，引导读者进行批判性思考。

要求：
1. 问题需探讨深层影响、根本原因或未来发展（绝不能是简单的"是/否"或基础事实核查）。
2. 每个问题必须是完整、具体的句子（约15-35个汉字），避免过于简短。
3. 严格返回包含3个字符串的JSON数组。示例：["这一发展在长远来看将如何影响该行业的生态？", "导致这一事件爆发的深层结构性原因是什么？", "为什么相关利益方会选择这种特定的应对策略？"]

摘要：
${article.summary_zh}`,
      '你是一位资深新闻分析师。只返回包含3个字符串的合规JSON数组。绝不要输出Markdown格式（如```json），不要任何前言、解释或编号。',
      GROQ_API_KEY
    ),
  ])

  const questions = { en, zh }

  // Persist new questions to DB
  await fetch(`${SUPABASE_URL}/rest/v1/daily_news?id=eq.${article_id}`, {
    method: 'PATCH',
    headers: sbHeaders,
    body: JSON.stringify({ questions }),
  })

  return new Response(JSON.stringify(questions), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
