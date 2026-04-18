import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

// ── Module-level prompt constants ─────────────────────────────────────────────

const ZH_SYSTEM_PROMPT = `你是一位直言不讳、观点鲜明的资深科技分析师，为虎嗅或36氪的核心读者写作——他们是国内的AI从业者和投资人，信息密集，节奏快，对硅谷叙事有自己的判断。

你拿到了 {WINDOW_LABEL} 内的一批文章，以及相关历史背景文章。

你的任务：写一篇统一的、批判性的趋势分析，回答这个新闻周期的"所以呢？"

首先用一句加粗的话写出这个周期的核心判断——必须点名具体公司或技术，并给出方向性结论。
原因：只有30秒的读者需要一个锚点。判断句让他们在决定要不要继续读之前就拿到了论点。
错误示范："**本周AI领域发生了若干重要进展。**"
正确示范："**在Anthropic完成安全差异化之前，OpenAI正在用价格战锁死推理市场。**"
失败模式：判断句含糊其辞（"有待观察"）、没有点名具体主体、或只是在复述新闻而非解读。如果你实在无法写出方向性判断，写："**本周没有单一主线——以下是三个独立事件。**"

然后写3-5段，覆盖以下内容：

1. 结构性转变：这批文章共同揭示了什么底层变化——权力、资本、技术架构层面的转变？点名站在转变两侧的公司。
2. "所以呢"测试：对你识别出的每个趋势，明确说明为什么一个开发者或投资人应该在意。不要假设读者知道为什么这件事重要。
3. 冲击半径：映射二阶效应——哪些相邻领域（云厂商、开源社区、企业买家、监管机构）受到影响，怎么受影响。
4. 弱信号与质疑：找出至少一处这批文章中主流叙事存在错误、不完整、或对某方明显有利的地方。点名谁从这个叙事框架中获益。
5. 验证催化剂：说出一个具体的指标、事件或产品发布，将在未来90天内证明或证伪你的趋势判断。

引用规则：每个分析性判断都要在行文中点名来源——"据Anthropic定价公告"、"根据路透社调查报道"——不用数字脚注[N]。
原因：数字脚注需要读者滚动到不存在的参考列表。行内命名引用读起来更快，可信度更强。
错误示范："OpenAI降价80%[1]，而Anthropic定价未变[2]。"
正确示范："据OpenAI API更新日志，价格降幅达80%——而截至本文写作时，Anthropic定价页面未见变化。"

碎片化规则：如果这批文章没有形成连贯的趋势，不要强行统一叙事。改为识别2-3个独立事件，在判断句后明确说明碎片化。
原因：强行将不相关文章串成一个趋势，是最危险的幻觉——听起来合理，但结构上是假的。

写作规范：密度高、具体、有观点、保持质疑。正文段落不用项目符号。不写开场白废话。有把握地写——如果要保留不确定性，用证据来表达，不要用"有待观察"。
禁用词：重大、里程碑、值得注意的是、生态系统、格局。`

const EN_SYSTEM_PROMPT = `You are a ruthless, high-conviction senior technology analyst writing for a sophisticated, time-poor audience. You cut through industry hype to identify structural shifts, asymmetric risks, and changing leverage. You write for builders and curious professionals — people who can spot a weak argument.

You have been given a set of articles from {WINDOW_LABEL} plus historically related articles for context.

Your task: Write a unified, highly critical trend analysis that answers the "So What?" of this news cycle.

BEGIN with a single bolded sentence — the verdict of this news cycle in plain language. This sentence must name a specific company or technology and make a directional claim.
WHY: Readers who have 30 seconds need something to hold. The verdict gives them the thesis before they decide whether to read on.
BAD: "**This week saw several significant developments across the AI landscape.**"
GOOD: "**OpenAI is racing to commoditize inference before Anthropic can differentiate on safety.**"
FAILURE MODE: A verdict that hedges ("it remains to be seen"), names no specific actor, or summarizes rather than interprets. If you cannot write a directional verdict, write: "**This cycle has no single thesis — three independent stories follow.**"

Then write 3-5 paragraphs covering:

1. The Structural Shift: What underlying shift in power, capital, or technical architecture do these articles collectively reveal? Name the companies on each side.
2. The "So What" Test: For each trend you identify, state explicitly why a builder or investor should care. Do not assume the reader knows why it matters.
3. The Blast Radius: Map second-order effects — which adjacent domains (cloud providers, open-source maintainers, enterprise buyers, regulators) are affected and how.
4. Weak Signals & Skepticism: Identify at least one place where the mainstream narrative in these articles is wrong, incomplete, or suspiciously convenient for someone. Name who benefits from the framing.
5. The Catalyst: Name one specific metric, event, or product release that will prove or disprove the trend you've identified within the next 90 days.

CITATION RULE: Ground every analytical claim by naming the source inline — "per Anthropic's pricing announcement," "according to the Reuters investigation" — not with numbered footnotes [N].
WHY: Numbered footnotes require the reader to scroll to a reference list that doesn't exist in a mobile card. Named attribution reads faster and builds credibility inline.
BAD: "OpenAI cut prices by 80% [1], while Anthropic held pricing steady [2]."
GOOD: "Per OpenAI's API changelog, prices dropped 80% — while Anthropic's pricing page remained unchanged as of this writing."

FRAGMENTATION RULE: If the articles don't form a cohesive trend, do not force one. Instead, identify 2-3 standalone stories and explicitly note fragmentation after the verdict sentence.
WHY: Forcing a unified narrative from unrelated articles produces the worst kind of hallucination — plausible-sounding but structurally false analysis.
BAD: Connecting a model release, a regulatory hearing, and a funding round into a single "trend" with no actual causal link.
GOOD: "**This cycle has no single thesis — three independent stories follow.** First: [story A]. Second: [story B]. Third: [story C]."

Style constraints: Dense, specific, opinionated, and skeptical. No bullet points in the body paragraphs. No introductory filler ("In today's fast-paced AI landscape..."). Write with authority — if you hedge, hedge with evidence, not with "it remains to be seen."
Banned words: "significant," "major," "key," "milestone," "landscape," "ecosystem," "it is worth noting."`

// ── resolveSecondary — await secondary Groq call with 25s timeout ─────────────
// Returns null on timeout, non-200, or parse failure.
// Callers treat null as "skip this column" — never write null over an existing value.
async function resolveSecondary(p: Promise<Response>): Promise<string | null> {
  try {
    const res = await Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('secondary_timeout')), 25_000)
      ),
    ])
    if (!res.ok) return null
    const json = await res.json()
    return (json.choices?.[0]?.message?.content as string) ?? null
  } catch {
    return null
  }
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
  const resolvedLang = lang || 'en'
  const synthesisField = resolvedLang === 'zh' ? 'synthesis_zh' : 'synthesis_en'
  const secondaryLang: 'en' | 'zh' = resolvedLang === 'en' ? 'zh' : 'en'
  const secondarySynthesisField = secondaryLang === 'zh' ? 'synthesis_zh' : 'synthesis_en'

  // ── Cache check — one row per window, bilingual columns ───────────────────
  if (!force_refresh) {
    const cacheRes = await fetch(
      `${SUPABASE_URL}/rest/v1/trend_briefs?anchor_date=eq.${anchor_date}&step_days=eq.${step_days}&expires_at=gt.${new Date().toISOString()}&order=generated_at.desc&limit=1&select=${synthesisField},sources_json,generated_at`,
      { headers: sbHeaders }
    )
    if (cacheRes.ok) {
      const cached: Record<string, unknown>[] = await cacheRes.json()
      const cachedSynthesis = cached[0]?.[synthesisField] as string | null
      if (cached.length > 0 && cachedSynthesis) {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'cached', synthesis: cachedSynthesis, sources_json: cached[0].sources_json, generated_at: cached[0].generated_at })}\n\n`
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
  // Omit embedding from SELECT — fetching 1024-dim floats for 200 articles blows Deno memory/CPU limits.
  const selectCols = 'id,title,summary_en,summary_zh,url,published_at,created_at,engagement'
  const orFilter = encodeURIComponent(`(and(published_at.gte.${s},published_at.lt.${e}),and(published_at.is.null,created_at.gte.${s},created_at.lt.${e}))`)

  const articlesUrl = `${SUPABASE_URL}/rest/v1/daily_news?or=${orFilter}&select=${selectCols}&limit=200`

  const articlesRes = await fetch(articlesUrl, { headers: sbHeaders })
  if (!articlesRes.ok) {
    return new Response('Failed to fetch articles', { status: 502, headers: corsHeaders })
  }

  type ArticleRow = {
    id: string; title: string; summary_en: string | null; summary_zh: string | null
    url: string; published_at: string | null; created_at: string
    engagement: Record<string, number> | null
  }
  const allArticles: ArticleRow[] = await articlesRes.json()

  if (allArticles.length === 0) {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  // ── Select top 12 by engagement ───────────────────────────────────────────
  function engagementScore(a: ArticleRow): number {
    if (!a.engagement) return 0
    return a.engagement.likes ?? a.engagement.votes ?? a.engagement.score ?? 0
  }

  const selected = [...allArticles]
    .sort((a, b) => {
      const diff = engagementScore(b) - engagementScore(a)
      if (diff !== 0) return diff
      return new Date(b.published_at || b.created_at).getTime() - new Date(a.published_at || a.created_at).getTime()
    })
    .slice(0, 12)

  // ── Historical enrichment ─────────────────────────────────────────────────
  const windowStart = new Date(date_start).getTime()
  const windowEnd = new Date(date_end).getTime()

  const historical: { id: string; title: string; published_at: string | null; summary_en: string | null; summary_zh: string | null }[] = []

  const seedId = selected[0]?.id
  if (seedId) {
    try {
      const embRes = await fetch(
        `${SUPABASE_URL}/rest/v1/daily_news?id=eq.${seedId}&select=embedding`,
        { headers: sbHeaders }
      )
      if (embRes.ok) {
        const embRows: { embedding: number[] | null }[] = await embRes.json()
        const embedding = embRows[0]?.embedding
        if (embedding) {
          const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_articles`, {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({ query_embedding: embedding, match_count: 15 }),
          })
          if (rpcRes.ok) {
            const results: { id: string; title: string; summary: string; score: number }[] = await rpcRes.json()
            const selectedIds = new Set(selected.map(a => a.id))
            for (const r of results) {
              if (historical.length >= 8) break
              if (selectedIds.has(r.id)) continue
              const detRes = await fetch(
                `${SUPABASE_URL}/rest/v1/daily_news?id=eq.${r.id}&select=id,title,published_at,created_at,summary_en,summary_zh`,
                { headers: sbHeaders }
              )
              if (!detRes.ok) continue
              const rows: { id: string; title: string; published_at: string | null; created_at: string; summary_en: string | null; summary_zh: string | null }[] = await detRes.json()
              if (!rows[0]) continue
              const articleDate = new Date(rows[0].published_at || rows[0].created_at).getTime()
              if (articleDate >= windowStart && articleDate < windowEnd) continue
              historical.push({ id: rows[0].id, title: rows[0].title, published_at: rows[0].published_at || rows[0].created_at, summary_en: rows[0].summary_en, summary_zh: rows[0].summary_zh })
            }
          }
        }
      }
    } catch { /* non-blocking */ }
  }

  // ── Build sources_json ────────────────────────────────────────────────────
  const sourcesJson = [
    ...selected.map((a, i) => ({
      index: i + 1, id: a.id, title: a.title, url: a.url,
      published_at: a.published_at || a.created_at, is_historical: false,
    })),
    ...historical.map((h, i) => ({
      index: selected.length + i + 1, id: h.id, title: h.title, url: null,
      published_at: h.published_at, is_historical: true,
    })),
  ]

  // ── Prompt helpers ────────────────────────────────────────────────────────
  function fmtDate(d: string | null): string {
    if (!d) return ''
    const dt = new Date(d)
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${mo[dt.getMonth()]} ${dt.getDate()}`
  }

  const windowLabel = step_days === 1
    ? fmtDate(date_start)
    : `${fmtDate(date_start)} – ${fmtDate(date_end)}`

  function bulletLinesFor(a: ArticleRow | typeof historical[0], targetLang: 'en' | 'zh'): string {
    const summary = targetLang === 'zh'
      ? ('summary_zh' in a ? a.summary_zh : null)
      : ('summary_en' in a ? a.summary_en : null)
    if (!summary) return ''
    return summary.split('\n').filter(l => l.trim().startsWith('•') || l.trim().startsWith('-')).join(' | ')
  }

  // Parameterized message builder — called once for primary, once for secondary
  function buildMessages(targetLang: 'en' | 'zh'): object[] {
    const systemPrompt = (targetLang === 'zh' ? ZH_SYSTEM_PROMPT : EN_SYSTEM_PROMPT)
      .replace('{WINDOW_LABEL}', windowLabel)

    const currentBlock = selected.map((a, i) =>
      `[${i + 1}] ${a.title} | ${fmtDate(a.published_at || a.created_at)} | ${bulletLinesFor(a, targetLang)}`
    ).join('\n')

    const historicalBlock = historical.length > 0
      ? '\n\nHistorical context:\n' + historical.map((h, i) =>
          `[${selected.length + i + 1}] ${h.title} | ${fmtDate(h.published_at)} | ${bulletLinesFor(h, targetLang)}`
        ).join('\n')
      : ''

    const userPrompt = `Current window articles [${windowLabel}${category !== 'all' ? ', ' + category : ''}]:\n${currentBlock}${historicalBlock}`

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]
  }

  // ── Precompute TTL / date label (needed in all write paths) ──────────────
  const todayUtc = new Date().toISOString().slice(0, 10)
  const isPast = anchor_date < todayUtc
  const expiresAt = isPast
    ? '9999-12-31T00:00:00.000Z'
    : new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  const dateRangeLabel = `${date_start.slice(0, 10)} to ${anchor_date}`

  // ── Stream setup ──────────────────────────────────────────────────────────
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const sourcesPreamble = encoder.encode(
    `data: ${JSON.stringify({ type: 'sources', sources_json: sourcesJson })}\n\n`
  )
  const groqHeaders = {
    'Authorization': `Bearer ${GROQ_API_KEY}`,
    'Content-Type': 'application/json',
  }

  // ── Secondary: server-to-server, blocking JSON. No req.signal. ───────────
  const secondaryPromise = fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: groqHeaders,
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      stream: false,
      temperature: 0.7,
      max_tokens: 1024,
      messages: buildMessages(secondaryLang),
    }),
  })

  // ── Primary: streaming, tied to req.signal ────────────────────────────────
  let groqRes: Response
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: req.signal,
      headers: groqHeaders,
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.7,
        max_tokens: 1024,
        messages: buildMessages(resolvedLang),
      }),
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.log(JSON.stringify({ event: 'client_disconnected', duration_ms: Date.now() - startMs, chars_streamed: 0, anchor_date, step_days }))
      // Secondary still in-flight — resolve and save if complete
      const secondaryText = await resolveSecondary(secondaryPromise)
      if (secondaryText) {
        const patchRes = await fetch(
          `${SUPABASE_URL}/rest/v1/trend_briefs?anchor_date=eq.${anchor_date}&step_days=eq.${step_days}`,
          { method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=minimal,count=exact' },
            body: JSON.stringify({ [secondarySynthesisField]: secondaryText, sources_json: sourcesJson, model: 'llama-3.3-70b-versatile', expires_at: expiresAt }) }
        )
        const updatedCount = parseInt(patchRes.headers.get('content-range')?.split('/')[1] ?? '0')
        if (updatedCount === 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/trend_briefs`, {
            method: 'POST',
            headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
            body: JSON.stringify({
              anchor_date, step_days,
              synthesis_en: secondaryLang === 'en' ? secondaryText : null,
              synthesis_zh: secondaryLang === 'zh' ? secondaryText : null,
              sources_json: sourcesJson, model: 'llama-3.3-70b-versatile', expires_at: expiresAt,
            }),
          })
        }
        console.log(JSON.stringify({ event: 'abort_secondary_saved', secondary_lang: secondaryLang, anchor_date, step_days }))
      } else {
        console.log(JSON.stringify({ event: 'abort_secondary_lost', anchor_date, step_days }))
      }
      return new Response(null, { status: 499, headers: corsHeaders })
    }
    throw err
  }

  if (!groqRes.ok) {
    if (groqRes.status === 429) {
      console.log(JSON.stringify({ event: 'rate_limited_429', anchor_date, step_days }))
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
          console.log(JSON.stringify({ event: 'client_disconnected', duration_ms: Date.now() - startMs, chars_streamed: charsStreamed, anchor_date, step_days }))

          // Truncated primary — do NOT write synthesisField.
          // Await secondary with 25s timeout and write only if complete.
          const secondaryText = await resolveSecondary(secondaryPromise)
          if (secondaryText) {
            const patchRes = await fetch(
              `${SUPABASE_URL}/rest/v1/trend_briefs?anchor_date=eq.${anchor_date}&step_days=eq.${step_days}`,
              { method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=minimal,count=exact' },
                body: JSON.stringify({ [secondarySynthesisField]: secondaryText, sources_json: sourcesJson, model: 'llama-3.3-70b-versatile', expires_at: expiresAt }) }
            )
            const updatedCount = parseInt(patchRes.headers.get('content-range')?.split('/')[1] ?? '0')
            if (updatedCount === 0) {
              await fetch(`${SUPABASE_URL}/rest/v1/trend_briefs`, {
                method: 'POST',
                headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
                body: JSON.stringify({
                  anchor_date, step_days,
                  synthesis_en: secondaryLang === 'en' ? secondaryText : null,
                  synthesis_zh: secondaryLang === 'zh' ? secondaryText : null,
                  sources_json: sourcesJson, model: 'llama-3.3-70b-versatile', expires_at: expiresAt,
                }),
              })
            }
            console.log(JSON.stringify({ event: 'abort_secondary_saved', secondary_lang: secondaryLang, anchor_date, step_days }))
          } else {
            console.log(JSON.stringify({ event: 'abort_secondary_lost', anchor_date, step_days }))
          }

          controller.close()
          return
        }
        throw err
      }

      // Full completion — atomic bilingual DB write
      if (synthesisAccum.length > 0) {
        const secondaryText = await resolveSecondary(secondaryPromise)

        const writePayload = {
          [synthesisField]: synthesisAccum,
          ...(secondaryText !== null ? { [secondarySynthesisField]: secondaryText } : {}),
          sources_json: sourcesJson,
          model: 'llama-3.3-70b-versatile',
          tokens_used: tokensUsed,
          expires_at: expiresAt,
        }

        // PATCH first — updates only changed fields on existing row, leaves other lang intact
        const patchRes = await fetch(
          `${SUPABASE_URL}/rest/v1/trend_briefs?anchor_date=eq.${anchor_date}&step_days=eq.${step_days}`,
          { method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=minimal,count=exact' }, body: JSON.stringify(writePayload) }
        )
        const updatedCount = parseInt(patchRes.headers.get('content-range')?.split('/')[1] ?? '0')

        // INSERT if no row existed
        if (updatedCount === 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/trend_briefs`, {
            method: 'POST',
            headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
            body: JSON.stringify({
              anchor_date, step_days, date_range: dateRangeLabel,
              synthesis_en: resolvedLang === 'en' ? synthesisAccum : (secondaryText ?? null),
              synthesis_zh: resolvedLang === 'zh' ? synthesisAccum : (secondaryText ?? null),
              sources_json: sourcesJson,
              model: 'llama-3.3-70b-versatile',
              tokens_used: tokensUsed,
              expires_at: expiresAt,
            }),
          })
        }
        console.log(JSON.stringify({
          event: 'brief_generated', lang: resolvedLang,
          secondary_lang: secondaryLang, secondary_ok: secondaryText !== null,
          duration_ms: Date.now() - startMs, tokens_used: tokensUsed,
          source_count: selected.length, historical_count: historical.length,
          anchor_date, step_days,
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
