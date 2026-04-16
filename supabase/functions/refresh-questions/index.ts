import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const AI_STUDIO_MODEL = 'gemma-3-27b-it'
const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

const QUESTIONS_SYSTEM_PROMPT = `Respond with valid JSON only. No reasoning. No verification. No self-correction.
Output the JSON object once, directly. Do not narrate your process.

You are an expert news analyst generating questions for a bilingual AI news feed.

Given an article's English and Chinese summaries, generate exactly 3 questions in English and 3 in Chinese that a curious reader would ask a knowledgeable friend.

Output a single JSON object:
{
  "questions_en": ["question 1", "question 2", "question 3"],
  "questions_zh": ["问题1", "问题2", "问题3"]
}

Rules for questions_en:
1. Each must reference a specific named company, exact number, or outcome from the summary — no floating generalities.
2. No question starting with "What is," "Can you explain," "How does."
3. Exactly one must be skeptical — challenging an assumption or claim, not hostile but not credulous.
4. Sound like a message to a smart friend, not an essay question.

Rules for questions_zh:
1. 每个必须引用摘要中的具体公司名、数字或结果，不能是套用任何文章的泛泛问题。
2. 禁止以"什么是"、"请解释"、"如何理解"开头。
3. 三个中必须有一个带质疑性——追问某个假设、数据或叙事框架，不是否定，是追问。
4. 15-35汉字。

IMPORTANT: Both question sets are generated in the same context window — the EN and ZH sets should probe the same aspects of the article, not diverge.`

// Single combined AI Studio call — both EN and ZH questions in one context window
// Primary: Gemma 3 27B (bilingual coherence: both sets see each other)
// Fallback: Two parallel Groq calls (fast failures only — 429 or connection error)
async function generateQuestions(
  summaryEn: string,
  summaryZh: string,
  aiStudioKey: string,
  groqApiKey: string,
): Promise<{ en: string[]; zh: string[] } | null> {
  const userContent = `English summary:\n${summaryEn}\n\nChinese summary:\n${summaryZh}`

  // --- AI Studio primary (8s timeout) ---
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)
  let useGroqFallback = false

  try {
    const url = `${AI_STUDIO_BASE}/${AI_STUDIO_MODEL}:generateContent?key=${aiStudioKey}`
    const body = {
      systemInstruction: { parts: [{ text: QUESTIONS_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            questions_en: { type: 'array', items: { type: 'string' } },
            questions_zh: { type: 'array', items: { type: 'string' } },
          },
        },
        temperature: 0.7,
      },
    }

    let aiRes: Response
    try {
      aiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (fetchErr: unknown) {
      clearTimeout(timeoutId)
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        console.error('AI Studio questions timeout — falling back to Groq')
        useGroqFallback = true
        aiRes = undefined as unknown as Response
      } else {
        console.log('AI Studio questions unreachable, falling back to Groq:', (fetchErr as Error).message)
        useGroqFallback = true
        aiRes = undefined as unknown as Response
      }
    }

    if (!useGroqFallback) {
      clearTimeout(timeoutId)

      if (aiRes!.status === 429) {
        console.log('AI Studio questions 429, falling back to Groq')
        useGroqFallback = true
      } else if (!aiRes!.ok) {
        console.error(`AI Studio questions ${aiRes!.status} — failing`)
        return null
      } else {
        const rawJson = await aiRes!.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        const text = rawJson?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) return null
        const parsed = JSON.parse(text) as { questions_en?: string[]; questions_zh?: string[] }
        const en = Array.isArray(parsed.questions_en) ? parsed.questions_en.slice(0, 3) : null
        const zh = Array.isArray(parsed.questions_zh) ? parsed.questions_zh.slice(0, 3) : null
        if (en && zh) return { en, zh }
        return null
      }
    }
  } catch (err) {
    clearTimeout(timeoutId)
    console.error('AI Studio questions error:', (err as Error).message)
    return null
  }

  if (!useGroqFallback) return null

  // --- Groq fallback (two parallel calls, existing approach) ---
  const [en, zh] = await Promise.all([
    callGroq(
      `Based on the article summary below, generate exactly 3 highly analytical questions that a critical reader would ask to explore the topic deeper.

Requirements:
1. Focus on implications, root causes, or future impacts (avoid simple yes/no or basic factual questions).
2. Each question must be thorough, well-articulated, and a complete sentence (aim for 10-25 words each).
3. Return strictly a JSON array of 3 strings. Example: ["How might this development impact X in the long term?", "What are the underlying systemic causes of Y?", "Why did the stakeholders choose this specific approach to Z?"]

Summary:
${summaryEn}`,
      'You are an expert news analyst. Return ONLY a valid JSON array of 3 strings. Do not use markdown blocks (```json), no preamble, no numbering.',
      groqApiKey
    ),
    callGroq(
      `根据以下文章摘要，生成3个具有深度和洞察力的问题，引导读者进行批判性思考。

要求：
1. 问题需探讨深层影响、根本原因或未来发展（绝不能是简单的"是/否"或基础事实核查）。
2. 每个问题必须是完整、具体的句子（约15-35个汉字），避免过于简短。
3. 严格返回包含3个字符串的JSON数组。示例：["这一发展在长远来看将如何影响该行业的生态？", "导致这一事件爆发的深层结构性原因是什么？", "为什么相关利益方会选择这种特定的应对策略？"]

摘要：
${summaryZh}`,
      '你是一位资深新闻分析师。只返回包含3个字符串的合规JSON数组。绝不要输出Markdown格式（如```json），不要任何前言、解释或编号。',
      groqApiKey
    ),
  ])

  if (en.length > 0 && zh.length > 0) return { en, zh }
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
  const GOOGLE_AI_STUDIO_API_KEY = Deno.env.get('GOOGLE_AI_STUDIO_API_KEY')!
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
    GOOGLE_AI_STUDIO_API_KEY,
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
