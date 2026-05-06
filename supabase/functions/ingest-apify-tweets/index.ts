import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const BIO_SYSTEM_PROMPT = 'You extract professional titles, roles, and credentials from Twitter bios. Output ONE flat JSON object where keys are handles and values are the exact, unabbreviated title strings extracted directly from the bio.\n\nRules:\n1. For people: DO NOT summarize, abbreviate, or alter the titles. Extract the exact relevant text verbatim. Include previous roles, multiple affiliations, or degrees if listed. Exclude conversational filler or hobbies (e.g., drop "I like to train large deep neural nets.").\n2. For products: Use the format "[Name] is [Exact Description] @[Company]".\n\nExample output:\n{"karpathy": "Previously Director of AI @ Tesla, founding team @ OpenAI, PhD @ Stanford", "claudeai": "Claude is LLM @Anthropic"}\n\nNo arrays, no extra keys, no markdown blocks (like ```json), no explanation.'

const TOKENROUTER_API = 'https://api.tokenrouter.com/v1/chat/completions'
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions'
const BIO_MODEL_TR = 'meta-llama/llama-3.3-70b-instruct'
const BIO_MODEL_GROQ = 'llama-3.3-70b-versatile'

function extractFirstJson(text: string): string {
  const start = text.indexOf('{')
  if (start === -1) throw new Error('No JSON object found in response')
  let depth = 0, inString = false, isEscaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (isEscaped) { isEscaped = false; continue }
    if (char === '\\') { isEscaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (!inString) {
      if (char === '{') depth++
      else if (char === '}') { depth--; if (depth === 0) return text.slice(start, i + 1) }
    }
  }
  throw new Error('Unterminated JSON object in response')
}

type ApifyItem = {
  url: string
  text: string
  author: { userName: string; description?: string }
  likeCount?: number
  retweetCount?: number
  createdAt?: string
  created_at?: string
}

async function fetchKnownUrls(
  urls: string[],
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Set<string>> {
  const known = new Set<string>()
  if (urls.length === 0) return known
  const chunks: string[][] = []
  for (let i = 0; i < urls.length; i += 100) {
    chunks.push(urls.slice(i, i + 100))
  }
  await Promise.all(chunks.map(async chunk => {
    const filterValue = `(${chunk.map(u => `"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`
    const res = await fetch(
      `${supabaseUrl}/rest/v1/raw_ingestion?url=in.${encodeURIComponent(filterValue)}&select=url&limit=100`,
      { headers }
    )
    if (!res.ok) return
    const rows: { url: string }[] = await res.json()
    for (const r of rows) known.add(r.url)
  }))
  return known
}

function parseBioJson(text: string): Record<string, string> | null {
  try {
    const rawParsed = JSON.parse(extractFirstJson(text))
    const flat = (rawParsed.bios && typeof rawParsed.bios === 'object') ? rawParsed.bios : rawParsed
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(flat)) {
      if (typeof v === 'string') result[k.replace(/^@/, '').toLowerCase()] = v
    }
    return Object.keys(result).length > 0 ? result : null
  } catch {
    return null
  }
}

async function extractBios(
  biosText: string,
  tokenrouterApiKey: string,
  groqApiKey: string,
): Promise<Record<string, string>> {
  const messages = [
    { role: 'system', content: 'Respond with valid JSON only. No prose. ' + BIO_SYSTEM_PROMPT },
    { role: 'user', content: biosText },
  ]

  // Tier 1: TokenRouter
  if (tokenrouterApiKey) {
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort(), 8000)
    try {
      console.log('[extractBios][TokenRouter] calling...')
      const res = await fetch(TOKENROUTER_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://news-app.internal',
          'X-Title': 'NewsApp',
        },
        body: JSON.stringify({
          model: BIO_MODEL_TR,
          messages,
          response_format: { type: 'json_object' },
          max_tokens: 600,
          temperature: 0,
        }),
        signal: controller.signal,
      })
      clearTimeout(timerId)
      if (res.ok) {
        const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
        const result = parseBioJson(json.choices?.[0]?.message?.content ?? '')
        if (result) return result
        console.log('[extractBios][TokenRouter] parse failed, trying Groq')
      } else {
        console.log(`[extractBios][TokenRouter] ${res.status}, trying Groq`)
      }
    } catch (e: unknown) {
      clearTimeout(timerId)
      console.log('[extractBios][TokenRouter] failed, trying Groq:', (e as Error).message)
    }
  }

  // Tier 2: Groq fallback
  if (!groqApiKey) return {}
  try {
    const res = await fetch(GROQ_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: BIO_MODEL_GROQ, messages, max_tokens: 600, temperature: 0 }),
    })
    if (!res.ok) { console.log(`[extractBios][Groq] ${res.status}`); return {} }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const result = parseBioJson(json.choices?.[0]?.message?.content ?? '')
    return result ?? {}
  } catch (e) {
    console.log(`[extractBios][Groq] failed: ${(e as Error).message}`)
    return {}
  }
}

serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!
  const APIFY_WEBHOOK_SECRET = Deno.env.get('APIFY_WEBHOOK_SECRET')!
  const TOKENROUTER_API_KEY = Deno.env.get('TOKENROUTER_API_KEY') ?? ''
  const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? ''

  // Bearer-token webhook auth. Apify sends the secret in the Authorization header
  // configured under the webhook's "HTTP Headers" section. This function verifies
  // the value matches APIFY_WEBHOOK_SECRET in Supabase Edge Function secrets.
  //
  // Why Bearer (not HMAC): Apify's standard webhook UI does not expose a "Secret
  // token" / signing-secret field, so HMAC verification would be unreachable from
  // any normal Apify config. Bearer is the only auth mechanism Apify natively
  // supports for outbound webhooks.
  const authHeader = req.headers.get('Authorization') ?? ''
  const expected = `Bearer ${APIFY_WEBHOOK_SECRET}`

  // Constant-time comparison (cheap insurance against timing attacks on the secret).
  if (authHeader.length !== expected.length) {
    return new Response('Unauthorized', { status: 401 })
  }
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  if (mismatch !== 0) {
    return new Response('Unauthorized', { status: 401 })
  }

  const rawBody = await req.text()


  const body = JSON.parse(rawBody)
  console.log('Apify payload:', JSON.stringify(body))
  const datasetId = body?.resource?.defaultDatasetId ?? body?.eventData?.datasetId
  if (!datasetId) {
    return new Response('Missing datasetId', { status: 400 })
  }

  const sbHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }

  // Fetch tweets from Apify dataset
  const apifyRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`
  )
  if (!apifyRes.ok) {
    return new Response(`Apify fetch failed: ${apifyRes.status}`, { status: 502 })
  }
  const items: any[] = await apifyRes.json()

  // Get apify_tweet source id
  const sourceRes = await fetch(
    `${SUPABASE_URL}/rest/v1/sources?source_type=eq.apify_tweet&is_active=eq.true&select=id,metadata`,
    { headers: sbHeaders }
  )
  const sources: { id: string; metadata?: { bio_map?: Record<string, string> } }[] = await sourceRes.json()
  if (!sources.length) {
    return new Response('No active apify_tweet source found', { status: 500 })
  }
  const sourceId = sources[0].id
  const existingBioMap: Record<string, string> = sources[0].metadata?.bio_map ?? {}

  // Filter valid items
  const validItems: ApifyItem[] = items.filter(
    (item: any) => item.url && item.text && item.author?.userName
  )


  // Bulk dedup + per-author grading (top 3 net-new AI-relevant tweets per author)
  const allUrls = validItems.map((item: ApifyItem) => item.url as string)
  const knownUrls = await fetchKnownUrls(allUrls, SUPABASE_URL, sbHeaders)

  // Group by author
  const byAuthor = new Map<string, ApifyItem[]>()
  for (const item of validItems) {
    const handle = item.author.userName.toLowerCase()
    if (!byAuthor.has(handle)) byAuthor.set(handle, [])
    byAuthor.get(handle)!.push(item)
  }

  const survivingItems: ApifyItem[] = []
  for (const [, authorItems] of byAuthor) {
    const netNew = authorItems.filter(item => !knownUrls.has(item.url))
    const relevanceChecks = await Promise.all(
      netNew.map(async (item) => {
        const text = `@${item.author.userName}: ${item.text}`
        try {
          const kwRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_ai_relevant`, {
            method: 'POST',
            headers: {
              'apikey': SERVICE_KEY,
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content: text, source_type: 'tweet' }),
          })
          return kwRes.ok ? (await kwRes.json() as boolean) : true  // fail-open
        } catch {
          return true  // fail-open on network error
        }
      })
    )
    const relevant = netNew.filter((_, i) => relevanceChecks[i])
    const sorted = relevant.sort((a, b) => {
      const scoreA = (a.likeCount ?? 0) + (a.retweetCount ?? 0)
      const scoreB = (b.likeCount ?? 0) + (b.retweetCount ?? 0)
      return scoreB - scoreA
    })
    survivingItems.push(...sorted.slice(0, 3))
  }
  console.log(`Apify tweet grading: ${validItems.length} total → ${survivingItems.length} survivors`)

  // Map surviving items to raw_ingestion rows
  const rows = survivingItems.map((item: ApifyItem) => ({
    source_id: sourceId,
    url: item.url,
    raw_content: `@${item.author.userName}: ${item.text}`,
    metadata: { likes: item.likeCount ?? 0, retweets: item.retweetCount ?? 0 },
    published_at: item.created_at ?? item.createdAt ?? null,
    status: 'pending',
  }))

  if (rows.length === 0) {
    return new Response(JSON.stringify({ inserted: 0 }), { status: 200 })
  }

  // Batch insert with dedup
  await fetch(`${SUPABASE_URL}/rest/v1/raw_ingestion?on_conflict=url`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify(rows),
  })

  console.log(`ingest-apify-tweets: inserted up to ${rows.length} tweets from dataset ${datasetId}`)

  // Extract and store author bios for handles not yet in the bio_map.
  // Uses TokenRouter (with Groq fallback) and the same BIO_SYSTEM_PROMPT as
  // ingest-builders to produce condensed professional titles rather than raw bios.
  const newRawBios: Record<string, string> = {}
  for (const item of survivingItems) {
    const handle = item.author.userName.toLowerCase()
    const bio = (item.author.description ?? (item.author as any).profileBio ?? (item.author as any).bio ?? '').trim()
    if (bio && !existingBioMap[handle]) {
      newRawBios[handle] = bio
    }
  }
  if (survivingItems.length > 0) {
    const sample = survivingItems[0]
    console.log(`ingest-apify-tweets: sample author keys: ${Object.keys(sample.author as object).join(', ')}`)
    console.log(`ingest-apify-tweets: sample author raw: ${JSON.stringify(sample.author).slice(0, 300)}`)
  }
  console.log(`ingest-apify-tweets: ${Object.keys(newRawBios).length} new bios to extract (${survivingItems.length} survivors, existing bio_map has ${Object.keys(existingBioMap).length} handles)`)

  if (Object.keys(newRawBios).length > 0 && (TOKENROUTER_API_KEY || GROQ_API_KEY)) {
    const biosText = Object.entries(newRawBios)
      .map(([handle, bio]) => `@${handle}: ${bio}`)
      .join('\n')
    const extracted = await extractBios(biosText, TOKENROUTER_API_KEY, GROQ_API_KEY)
    if (Object.keys(extracted).length > 0) {
      const mergedBioMap = { ...existingBioMap, ...extracted }
      await fetch(`${SUPABASE_URL}/rest/v1/sources?id=eq.${sourceId}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ metadata: { ...sources[0].metadata, bio_map: mergedBioMap } }),
      })
      console.log(`ingest-apify-tweets: bio_map updated with ${Object.keys(extracted).length} new handles`)
    }
  }

  return new Response(JSON.stringify({ inserted: rows.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
