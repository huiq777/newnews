import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

// Pre-LLM keyword gate — same as process-queue and ingest-builders. Keep in sync manually.
const EN_AI_KEYWORDS = /\b(ai|agi|asi|llm|gpt|claude|gemini|openai|anthropic|deepmind|mistral|llama|groq|cohere|sora|midjourney|runway|nvidia|hugging|transformers|neural|multimodal|generative|agents?|embedding|rag|inference|benchmark|fine.tun|training\s+run|gpu|h100|a100|compute|foundation\s+model|reasoning\s+model|o1|o3|o4)\b/i

const ZH_AI_KEYWORDS = [
  '人工智能','大模型','语言模型','神经网络','深度学习','机器学习',
  '生成式','多模态','算力','英伟达',
  '智谱','文心','通义','混元','月之暗面','零一万物','阶跃星辰',
  'DeepSeek','百川','商汤','科大讯飞','华为盘古',
]

type ApifyItem = {
  url: string
  text: string
  author: { userName: string }
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

serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!
  const APIFY_WEBHOOK_SECRET = Deno.env.get('APIFY_WEBHOOK_SECRET')!

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
    `${SUPABASE_URL}/rest/v1/sources?source_type=eq.apify_tweet&is_active=eq.true&select=id`,
    { headers: sbHeaders }
  )
  const sources: { id: string }[] = await sourceRes.json()
  if (!sources.length) {
    return new Response('No active apify_tweet source found', { status: 500 })
  }
  const sourceId = sources[0].id

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
    const relevant = netNew.filter(item => {
      const text = `@${item.author.userName}: ${item.text}`
      return EN_AI_KEYWORDS.test(text) || ZH_AI_KEYWORDS.some(kw => text.includes(kw))
    })
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
  return new Response(JSON.stringify({ inserted: rows.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
