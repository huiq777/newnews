import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const { article_id, question, lang } = await req.json()

  // System-role context caps (Principle 4 / Spec 2026-04-26).
  // Total system-role budget = MAIN_CONTEXT_CAP + MAX_RELATED * RELATED_CONTEXT_CAP
  // = 12,000 + 3 * 800 = 14,400 chars ≈ 3,600 tokens.
  const MAIN_CONTEXT_CAP = 12_000
  const RELATED_CONTEXT_CAP = 800
  const MAX_RELATED = 3

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? ''
  const TOKENROUTER_API_KEY = Deno.env.get('TOKENROUTER_API_KEY') ?? ''
  const LLM_MODEL           = Deno.env.get('LLM_MODEL') ?? 'qwen/qwen3.6-plus'
  const OPENROUTER_API_KEY  = Deno.env.get('OPENROUTER_API_KEY') ?? ''
  const OPENROUTER_MODEL    = Deno.env.get('OPENROUTER_MODEL') ?? ''
  const sbHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }

  // Fetch primary article
  const sbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_news?id=eq.${article_id}&select=title,summary_en,summary_zh,article_content`,
    { headers: sbHeaders }
  )
  const rows: any[] = await sbRes.json()
  const article = rows[0]
  if (!article) return new Response('Article not found', { status: 404, headers: corsHeaders })

  // Use full article content when available; fall back to summary
  const summary = lang === 'zh' ? article.summary_zh : article.summary_en
  const fullContent = article.article_content || summary
  const mainContext = fullContent.length > MAIN_CONTEXT_CAP
    ? fullContent.slice(0, MAIN_CONTEXT_CAP)
    : fullContent

  // RAG: embed question with Cohere, find related articles
  let relatedContext = ''
  let filtered: { id: string; title: string; summary: string }[] = []
  try {
    const cohereRes = await fetch('https://api.cohere.com/v1/embed', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('COHERE_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'embed-english-v3.0',
        input_type: 'search_query',
        texts: [question],
      }),
    })

    if (cohereRes.ok) {
      const cohereData: any = await cohereRes.json()
      const queryEmbedding: number[] = cohereData.embeddings[0]

      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_articles`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ query_embedding: queryEmbedding, match_count: 4 }),
      })

      if (rpcRes.ok) {
        const related: { id: string; title: string; summary: string }[] = await rpcRes.json()
        filtered = related.filter(r => r.id !== article_id).slice(0, MAX_RELATED)
        if (filtered.length > 0) {
          const label = lang === 'zh' ? '相关文章' : 'Related article'
          relatedContext = '\n\n' + filtered.map((r, i) => {
            const trimmed = (r.summary || '').slice(0, RELATED_CONTEXT_CAP)
            return `[${label} ${i + 1}] ${r.title}\n${trimmed}`
          }).join('\n\n')
        }
      }
    }
  } catch {
    // RAG failure is non-blocking — answer still streams from primary article
  }

  console.log(`[answer-question] context: main=${mainContext.length}c, related=${filtered.length}x, total=${mainContext.length + relatedContext.length}c`)

  const systemPrompt = lang === 'zh'
    ? `你是一位犀利的科技新闻分析师。主要根据下方文章内容回答问题，用中文作答。如有相关背景文章，可作为补充参考。\n\n规则：\n- 不要编造内容。如果文章没有覆盖问题的答案，直接说明："文章没有直接提到这一点，但根据文章的说法……"\n  失败模式：对文章中没有出现的具体数字或事件给出确定性回答。如果你不确定某个事实是否在提供的内容中，请明确标注。\n- 不要复述摘要。用户已经看过摘要了。直接回答问题。\n  错误示范："这篇文章讨论了OpenAI的新模型发布。文章提到……"\n  正确示范："40%这个数字来自OpenAI的内部评测——文章没有提到外部基准测试，这本身就是值得追问的地方。"\n\n文章标题：${article.title}\n\n文章内容：\n${mainContext}${relatedContext}`
    : `You are a sharp tech news analyst. Answer primarily based on the main article. Use related articles as supplementary context when relevant.\n\nRules:\n- Do not fabricate. If the article does not contain the answer, say so directly: "The article doesn't cover this, but based on what it does say..."\n  FAILURE MODE: Answering confidently about a specific number or event that isn't in the article. If you're not sure the fact is in the provided context, flag it.\n- Do not summarize the article back to the user. They already read the summary. Answer the question.\n  BAD: "This article discusses OpenAI's new model release. The article mentions that..."\n  GOOD: "The 40% figure comes from OpenAI's internal evals — the article doesn't name an external benchmark, which is the suspicious part."\n\nMain article: ${article.title}\n\nContent:\n${mainContext}${relatedContext}`

  // Build base request body (same for all providers)
  const llmBody = {
    stream: true,
    temperature: 0.6,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
  }

  let llmRes: Response | null = null

  // Tier 1: TokenRouter
  if (TOKENROUTER_API_KEY) {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      console.log('[answer-question][TokenRouter] calling...')
      const r = await fetch('https://api.tokenrouter.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Authorization': `Bearer ${TOKENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...llmBody, model: LLM_MODEL }),
      })
      clearTimeout(timerId)
      if (r.ok) { llmRes = r }
      else if (r.status === 429) { console.log('[answer-question][TokenRouter] 429, trying OpenRouter') }
      else { throw new Error(`TokenRouter ${r.status}`) }
    } catch (e) {
      clearTimeout(timerId)
      const err = e as Error
      if (err.message.startsWith('TokenRouter')) {
        console.log('[answer-question][TokenRouter] non-429 error, trying OpenRouter:', err.message)
      } else {
        console.log('[answer-question][TokenRouter] timeout or unreachable, trying OpenRouter:', err.message)
      }
    }
  }

  // Tier 2: OpenRouter
  if (!llmRes && OPENROUTER_API_KEY && OPENROUTER_MODEL) {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      console.log('[answer-question][OpenRouter] calling...')
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://news-app.internal',
          'X-Title': 'NewsApp',
        },
        body: JSON.stringify({ ...llmBody, model: OPENROUTER_MODEL }),
      })
      clearTimeout(timerId)
      if (r.ok) { llmRes = r }
      else if (r.status === 429) { console.log('[answer-question][OpenRouter] 429, trying Groq') }
      else { throw new Error(`OpenRouter ${r.status}`) }
    } catch (e) {
      clearTimeout(timerId)
      const err = e as Error
      if (err.message.startsWith('OpenRouter')) {
        console.log('[answer-question][OpenRouter] non-429 error, trying Groq:', err.message)
      } else {
        console.log('[answer-question][OpenRouter] timeout or unreachable, trying Groq:', err.message)
      }
    }
  }

  // Tier 3: Groq (always available as last resort)
  if (!llmRes) {
    console.log('[answer-question][Groq] calling...')
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...llmBody, model: 'llama-3.3-70b-versatile' }),
    })
    if (!r.ok) {
      const errText = await r.text()
      return new Response(`LLM unavailable: ${errText.substring(0, 200)}`, { status: 502, headers: corsHeaders })
    }
    llmRes = r
  }

  const reader = llmRes!.body!.getReader()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const stream = new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }

        const chunk = decoder.decode(value)
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') continue

          try {
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta
            if (!delta) continue

            if (delta.reasoning_content) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'thinking', content: delta.reasoning_content })}\n\n`
              ))
            }
            if (delta.content) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'content', content: delta.content })}\n\n`
              ))
            }
          } catch {}
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  })
})
