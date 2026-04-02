import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

// Cosine similarity between two equal-length vectors
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!

  const sbHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }

  const { category, anchor_date, step_days, date_start, date_end, lang, force_refresh } = await req.json()
  if (!category || !anchor_date || !step_days || !date_start || !date_end) {
    return new Response('Missing required fields', { status: 400, headers: corsHeaders })
  }

  const startMs = Date.now()

  // ── Cache check ───────────────────────────────────────────────────────────
  if (!force_refresh) {
    const cacheRes = await fetch(
      `${SUPABASE_URL}/rest/v1/trend_briefs?category=eq.${encodeURIComponent(category)}&anchor_date=eq.${anchor_date}&step_days=eq.${step_days}&expires_at=gt.${new Date().toISOString()}&order=generated_at.desc&limit=1&select=synthesis,sources_json,generated_at`,
      { headers: sbHeaders }
    )
    if (cacheRes.ok) {
      const cached: { synthesis: string; sources_json: unknown; generated_at: string }[] = await cacheRes.json()
      if (cached.length > 0) {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'cached', synthesis: cached[0].synthesis, sources_json: cached[0].sources_json, generated_at: cached[0].generated_at })}\n\n`
            ))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return new Response(stream, {
          headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }
    }
  }

  // ── Fetch articles in window ──────────────────────────────────────────────
  const s = date_start
  const e = date_end
  const categoryFilter = category !== 'all'
    ? `&sources.category=eq.${encodeURIComponent(category)}`
    : ''
  const selectCols = 'id,title,summary_en,summary_zh,url,published_at,created_at,engagement,embedding'
  const orFilter = encodeURIComponent(`and(published_at.gte.${s},published_at.lt.${e}),and(published_at.is.null,created_at.gte.${s},created_at.lt.${e})`)

  let articlesUrl = `${SUPABASE_URL}/rest/v1/daily_news?or=${orFilter}&select=${selectCols}&limit=200`
  if (category !== 'all') {
    articlesUrl = `${SUPABASE_URL}/rest/v1/daily_news?or=${orFilter}&select=${selectCols},sources!inner(category)&sources.category=eq.${encodeURIComponent(category)}&limit=200`
  }

  const articlesRes = await fetch(articlesUrl, { headers: sbHeaders })
  if (!articlesRes.ok) {
    return new Response('Failed to fetch articles', { status: 502, headers: corsHeaders })
  }

  type ArticleRow = {
    id: string; title: string; summary_en: string | null; summary_zh: string | null
    url: string; published_at: string | null; created_at: string
    engagement: Record<string, number> | null; embedding: number[] | null
  }
  const allArticles: ArticleRow[] = await articlesRes.json()

  if (allArticles.length === 0) {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  // ── Two-pass clustering ───────────────────────────────────────────────────
  function engagementScore(a: ArticleRow): number {
    if (!a.engagement) return 0
    return a.engagement.likes ?? a.engagement.votes ?? a.engagement.score ?? 0
  }

  const sorted = [...allArticles].sort((a, b) => {
    const diff = engagementScore(b) - engagementScore(a)
    if (diff !== 0) return diff
    return new Date(b.published_at || b.created_at).getTime() - new Date(a.published_at || a.created_at).getTime()
  })

  const CLUSTER_THRESHOLD = 0.82
  const effectiveTarget = Math.min(sorted.length, 12)

  type Cluster = { representative: ArticleRow; members: ArticleRow[]; clusterSize: number }
  const clusters: Cluster[] = []

  for (const article of sorted) {
    if (!article.embedding) {
      // No embedding — create solo cluster
      clusters.push({ representative: article, members: [article], clusterSize: 1 })
      continue
    }
    let found = false
    for (const cluster of clusters) {
      if (!cluster.representative.embedding) continue
      const sim = cosineSimilarity(article.embedding, cluster.representative.embedding)
      if (sim >= CLUSTER_THRESHOLD) {
        cluster.members.push(article)
        cluster.clusterSize++
        found = true
        break
      }
    }
    if (!found) {
      clusters.push({ representative: article, members: [article], clusterSize: 1 })
    }
  }

  // Pass 2 — allocate slots
  const totalArticles = sorted.length
  const dominantCap = Math.ceil(effectiveTarget * 0.40)
  const mediumCap = Math.ceil(effectiveTarget * 0.20)

  clusters.sort((a, b) => b.clusterSize - a.clusterSize)

  const selected: ArticleRow[] = []
  for (const cluster of clusters) {
    if (selected.length >= effectiveTarget) break
    const threshold = cluster.clusterSize / totalArticles
    const cap = threshold >= 0.20 ? dominantCap : threshold >= 0.05 ? mediumCap : 1
    const slots = Math.min(cluster.clusterSize, cap, effectiveTarget - selected.length)
    const picks = cluster.members
      .sort((a, b) => engagementScore(b) - engagementScore(a))
      .slice(0, slots)
    selected.push(...picks)
  }

  // ── Historical enrichment ─────────────────────────────────────────────────
  const windowStart = new Date(date_start).getTime()
  const windowEnd = new Date(date_end).getTime()

  const historicalMap = new Map<string, { id: string; title: string; published_at: string | null; summary_en: string | null; summary_zh: string | null }>()

  await Promise.all(
    selected
      .filter(a => a.embedding)
      .map(async (a) => {
        try {
          const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_articles`, {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({ query_embedding: a.embedding, match_count: 10 }),
          })
          if (!rpcRes.ok) return
          const results: { id: string; title: string; summary: string; score: number }[] = await rpcRes.json()
          for (const r of results) {
            if (historicalMap.has(r.id)) continue
            if (selected.some(s => s.id === r.id)) continue
            // We need published_at — fetch it
            const detailRes = await fetch(
              `${SUPABASE_URL}/rest/v1/daily_news?id=eq.${r.id}&select=id,title,published_at,created_at,summary_en,summary_zh`,
              { headers: sbHeaders }
            )
            if (!detailRes.ok) continue
            const rows: { id: string; title: string; published_at: string | null; created_at: string; summary_en: string | null; summary_zh: string | null }[] = await detailRes.json()
            if (!rows[0]) continue
            const row = rows[0]
            const articleDate = new Date(row.published_at || row.created_at).getTime()
            // Exclude articles within the current window
            if (articleDate >= windowStart && articleDate < windowEnd) continue
            historicalMap.set(r.id, { id: row.id, title: row.title, published_at: row.published_at || row.created_at, summary_en: row.summary_en, summary_zh: row.summary_zh })
          }
        } catch { /* non-blocking */ }
      })
  )

  const historical = Array.from(historicalMap.values()).slice(0, 8)

  // ── Build sources_json ────────────────────────────────────────────────────
  const sourcesJson = [
    ...selected.map((a, i) => ({
      index: i + 1,
      id: a.id,
      title: a.title,
      url: a.url,
      published_at: a.published_at || a.created_at,
      is_historical: false,
    })),
    ...historical.map((h, i) => ({
      index: selected.length + i + 1,
      id: h.id,
      title: h.title,
      url: null,
      published_at: h.published_at,
      is_historical: true,
    })),
  ]

  // ── Build prompt ──────────────────────────────────────────────────────────
  function fmtDate(d: string | null): string {
    if (!d) return ''
    const dt = new Date(d)
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${mo[dt.getMonth()]} ${dt.getDate()}`
  }

  function bulletLines(a: ArticleRow | typeof historical[0]): string {
    const summary = lang === 'zh'
      ? ('summary_zh' in a ? a.summary_zh : null)
      : ('summary_en' in a ? a.summary_en : null)
    if (!summary) return ''
    // Extract bullet lines (lines starting with • or -)
    return summary.split('\n').filter(l => l.trim().startsWith('•') || l.trim().startsWith('-')).join(' | ')
  }

  const windowLabel = step_days === 1
    ? fmtDate(date_start)
    : `${fmtDate(date_start)} – ${fmtDate(date_end)}`

  const currentBlock = selected.map((a, i) =>
    `[${i + 1}] ${a.title} | ${fmtDate(a.published_at || a.created_at)} | ${bulletLines(a)}`
  ).join('\n')

  const historicalBlock = historical.length > 0
    ? '\n\nHistorical context:\n' + historical.map((h, i) =>
        `[${selected.length + i + 1}] ${h.title} | ${fmtDate(h.published_at)} | ${bulletLines(h)}`
      ).join('\n')
    : ''

  const systemPrompt = `You are a ruthless, high-conviction senior technology analyst writing for a sophisticated, time-poor audience. You cut through industry hype to identify structural shifts, asymmetric risks, and changing leverage.

You have been given a set of articles from ${windowLabel} plus historically related articles for context.

Your task: Write a unified, highly critical trend analysis (3–5 paragraphs) that answers the "So What?" of this news cycle.

1. The Structural Shift: Do not just summarize what happened. Extract the underlying shift in power, capital, or architecture. Who is gaining leverage? What bottleneck is being bypassed or created?
2. The "So What" Test: For every trend identified, you must explicitly state why the reader should care. How does this change the strategic landscape?
3. The Blast Radius: Map the second-order effects. Identify the non-obvious casualties, beneficiaries, or friction points in adjacent domains.
4. Weak Signals & Skepticism: Highlight emerging details that contradict the mainstream narrative, or point out where the current hype ignores physical, economic, or regulatory reality.
5. Inline Citations: Every analytical claim must be grounded in the text. Cite sources inline using [N] notation where N matches the article index.
6. The Catalyst: End with a concrete "Watch For" conclusion. Identify the specific metric, upcoming event, or failure mode that will prove or disprove this trend in the near future.

IMPORTANT: If the articles do not form a cohesive structural trend, DO NOT force a narrative. Instead, identify the 2–3 most significant standalone stories, critically evaluate why they matter individually, and explicitly note the fragmentation of the current news cycle.

Style constraints: Dense, specific, opinionated, and skeptical. NO bullet points. NO introductory filler ("In recent news," "This is a significant development"). Write with the authority of an insider explaining the real stakes to a peer.`

  const userPrompt = `Current window articles [${windowLabel}${category !== 'all' ? ', ' + category : ''}]:\n${currentBlock}${historicalBlock}`

  // ── Stream to client ──────────────────────────────────────────────────────
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // Send sources immediately
  const sourcesPreamble = encoder.encode(
    `data: ${JSON.stringify({ type: 'sources', sources_json: sourcesJson })}\n\n`
  )

  let groqRes: Response
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: req.signal,
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.7,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.log(JSON.stringify({ event: 'client_disconnected', duration_ms: Date.now() - startMs, chars_streamed: 0, category, anchor_date, step_days }))
      return new Response(null, { status: 499, headers: corsHeaders })
    }
    throw err
  }

  if (!groqRes.ok) {
    if (groqRes.status === 429) {
      console.log(JSON.stringify({ event: 'rate_limited_429', category, anchor_date, step_days }))
      return new Response('Rate limited', { status: 429, headers: corsHeaders })
    }
    return new Response('Groq error', { status: 502, headers: corsHeaders })
  }

  const reader = groqRes.body!.getReader()
  let synthesisAccum = ''
  let charsStreamed = 0
  let tokensUsed: number | null = null

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sourcesPreamble)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6).trim()
            if (payload === '[DONE]') continue
            try {
              const parsed = JSON.parse(payload)
              // Capture token usage from final chunk
              if (parsed.usage?.total_tokens) tokensUsed = parsed.usage.total_tokens
              const content = parsed.choices?.[0]?.delta?.content
              if (!content) continue
              synthesisAccum += content
              charsStreamed += content.length
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'content', content })}\n\n`
              ))
            } catch { /* malformed chunk — skip */ }
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          console.log(JSON.stringify({ event: 'client_disconnected', duration_ms: Date.now() - startMs, chars_streamed: charsStreamed, category, anchor_date, step_days }))
          controller.close()
          return
        }
        throw err
      }

      // Full completion — persist to cache
      if (synthesisAccum.length > 0) {
        const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
        await fetch(`${SUPABASE_URL}/rest/v1/trend_briefs`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            category, anchor_date, step_days,
            synthesis: synthesisAccum,
            sources_json: sourcesJson,
            model: 'llama-3.3-70b-versatile',
            tokens_used: tokensUsed,
            expires_at: expiresAt,
          }),
        })
        console.log(JSON.stringify({
          event: 'brief_generated',
          duration_ms: Date.now() - startMs,
          tokens_used: tokensUsed,
          source_count: selected.length,
          historical_count: historical.length,
          category, anchor_date, step_days,
        }))
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
})
