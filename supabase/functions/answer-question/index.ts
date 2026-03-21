import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const { article_id, question, lang } = await req.json()

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
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
  const mainContext = article.article_content || summary

  // RAG: embed question with Cohere, find related articles
  let relatedContext = ''
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
        const filtered = related.filter(r => r.id !== article_id).slice(0, 3)
        if (filtered.length > 0) {
          const label = lang === 'zh' ? '相关文章' : 'Related article'
          relatedContext = '\n\n' + filtered.map((r, i) =>
            `[${label} ${i + 1}] ${r.title}\n${r.summary}`
          ).join('\n\n')
        }
      }
    }
  } catch {
    // RAG failure is non-blocking — answer still streams from primary article
  }

  const systemPrompt = lang === 'zh'
    ? `你是一位犀利的科技新闻分析师。主要根据以下提供的文章内容回答问题，用中文作答。如有相关背景文章，可作为补充参考。不要编造内容。\n\n文章标题：${article.title}\n\n文章内容：\n${mainContext}${relatedContext}`
    : `You are a sharp tech news analyst. Answer primarily based on the main article. Use related articles as supplementary context when relevant. Do not fabricate.\n\nMain article: ${article.title}\n\nContent:\n${mainContext}${relatedContext}`

  // Stream from Groq
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('GROQ_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      stream: true,
      temperature: 0.6,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
    }),
  })

  if (!groqRes.ok) {
    const err = await groqRes.text()
    return new Response(err, { status: 500, headers: corsHeaders })
  }

  const reader = groqRes.body!.getReader()
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
