import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

// Three-tier provider: TokenRouter → OpenRouter → Groq (parallel EN+ZH)
async function generateQuestions(
  summaryEn: string,
  summaryZh: string,
  tokenrouterApiKey: string,
  llmModel: string,
  openrouterApiKey: string,
  openrouterModel: string,
  groqApiKey: string,
): Promise<{ en: string[]; zh: string[] } | null> {
  const systemPrompt = `You are a bilingual editorial assistant. Given an article summary in English and Chinese, generate exactly 3 concise, specific discussion questions in each language.

Output ONLY valid JSON in this exact format:
{"questions_en": ["question 1", "question 2", "question 3"], "questions_zh": ["问题1", "问题2", "问题3"]}

Rules:
- Questions must be specific to the article content, not generic
- Each question under 100 characters
- No numbering, no preamble, just the JSON object`

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Generate 3 discussion questions in each language:\n\nEnglish summary:\n${summaryEn}\n\nChinese summary:\n${summaryZh}` },
  ]
  const baseBody = { messages, temperature: 0.7, max_tokens: 300 }

  // ── Tier 1: TokenRouter ─────────────────────────────────────────────────────
  if (tokenrouterApiKey) {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch('https://api.tokenrouter.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Authorization': `Bearer ${tokenrouterApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, model: llmModel, response_format: { type: 'json_object' } }),
      })
      clearTimeout(timerId)
      if (res.ok) {
        const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
        const text = json.choices?.[0]?.message?.content ?? ''
        const parsed = JSON.parse(text) as { questions_en?: string[]; questions_zh?: string[] }
        if (Array.isArray(parsed.questions_en) && Array.isArray(parsed.questions_zh)) {
          return { en: parsed.questions_en.slice(0, 3), zh: parsed.questions_zh.slice(0, 3) }
        }
      } else if (res.status !== 429) {
        console.log(`[refresh-questions][TokenRouter] ${res.status}, trying OpenRouter`)
      } else {
        console.log('[refresh-questions][TokenRouter] 429, trying OpenRouter')
      }
    } catch (e) {
      clearTimeout(timerId)
      console.log('[refresh-questions][TokenRouter] failed, trying OpenRouter:', (e as Error).message)
    }
  }

  // ── Tier 2: OpenRouter ──────────────────────────────────────────────────────
  if (openrouterApiKey && openrouterModel) {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://news-app.internal',
          'X-Title': 'NewsApp',
        },
        body: JSON.stringify({ ...baseBody, model: openrouterModel, response_format: { type: 'json_object' } }),
      })
      clearTimeout(timerId)
      if (res.ok) {
        const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
        const text = json.choices?.[0]?.message?.content ?? ''
        const parsed = JSON.parse(text) as { questions_en?: string[]; questions_zh?: string[] }
        if (Array.isArray(parsed.questions_en) && Array.isArray(parsed.questions_zh)) {
          return { en: parsed.questions_en.slice(0, 3), zh: parsed.questions_zh.slice(0, 3) }
        }
      } else if (res.status !== 429) {
        console.log(`[refresh-questions][OpenRouter] ${res.status}, trying Groq`)
      } else {
        console.log('[refresh-questions][OpenRouter] 429, trying Groq')
      }
    } catch (e) {
      clearTimeout(timerId)
      console.log('[refresh-questions][OpenRouter] failed, trying Groq:', (e as Error).message)
    }
  }

  // ── Tier 3: Groq (two parallel calls — existing pattern preserved) ──────────
  try {
    const [enQuestions, zhQuestions] = await Promise.all([
      callGroq(
        `Generate exactly 3 concise discussion questions in English about this article:\n\n${summaryEn}`,
        'You are a helpful assistant. Output ONLY a JSON array of exactly 3 strings. No other text.',
        groqApiKey,
      ),
      callGroq(
        `请针对这篇文章生成恰好3个中文讨论问题：\n\n${summaryZh}`,
        '你是一个助手。只输出一个包含3个字符串的JSON数组，不要其他文字。',
        groqApiKey,
      ),
    ])
    if (enQuestions.length > 0 && zhQuestions.length > 0) {
      return { en: enQuestions.slice(0, 3), zh: zhQuestions.slice(0, 3) }
    }
  } catch (e) {
    console.log('[refresh-questions][Groq] failed:', (e as Error).message)
  }

  return null
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
  const data: unknown = await res.json()
  const text = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content?.trim() || '[]'
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.slice(0, 3) : []
  } catch {
    return []
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const { article_id } = await req.json()
  const TOKENROUTER_API_KEY = Deno.env.get('TOKENROUTER_API_KEY') ?? ''
  const LLM_MODEL           = Deno.env.get('QA_LLM_MODEL') ?? 'qwen/qwen3.5-flash'
  const OPENROUTER_API_KEY  = Deno.env.get('OPENROUTER_API_KEY') ?? ''
  const OPENROUTER_MODEL    = Deno.env.get('OPENROUTER_MODEL') ?? ''
  const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sbHeaders = { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

  // Fetch article summaries
  const sbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_news?id=eq.${article_id}&select=summary_en,summary_zh`,
    { headers: sbHeaders }
  )
  const rows: { summary_en?: string; summary_zh?: string }[] = await sbRes.json()
  const article = rows[0]
  if (!article) return new Response('Not found', { status: 404, headers: corsHeaders })

  const questions = await generateQuestions(
    article.summary_en ?? '',
    article.summary_zh ?? '',
    TOKENROUTER_API_KEY,
    LLM_MODEL,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,
    GROQ_API_KEY,
  )

  if (!questions) return new Response('Failed to generate questions', { status: 500, headers: corsHeaders })

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
