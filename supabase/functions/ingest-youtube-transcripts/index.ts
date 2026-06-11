import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  normalizeSocialSourceUrl,
  youtubeSourceAliases,
} from '../_shared/social-source.js'

type ApifyItem = {
  url: string
  title?: string
  channelName?: string
  inputChannelUrl?: string
  likes?: number
  date?: string
  type?: string
  subtitles?: Array<{ srt?: string; srtUrl?: string; language?: string; type?: string }>
}

async function fetchKnownUrls(
  urls: string[],
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Set<string>> {
  const known = new Set<string>()
  if (urls.length === 0) return known
  const chunks: string[][] = []
  for (let i = 0; i < urls.length; i += 100) chunks.push(urls.slice(i, i + 100))
  await Promise.all(chunks.map(async chunk => {
    const filterValue = `(${chunk.map(u => `"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`
    const res = await fetch(
      `${supabaseUrl}/rest/v1/raw_ingestion?url=in.${encodeURIComponent(filterValue)}&select=url&limit=100`,
      { headers },
    )
    if (!res.ok) return
    const rows: { url: string }[] = await res.json()
    for (const r of rows) known.add(r.url)
  }))
  return known
}

serve(async (req) => {
  const SUPABASE_URL           = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY            = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const APIFY_API_KEY          = Deno.env.get('APIFY_API_KEY')!
  const APIFY_WEBHOOK_SECRET   = Deno.env.get('APIFY_WEBHOOK_SECRET')!

  // Bearer-token webhook auth — same pattern as ingest-apify-tweets
  const authHeader = req.headers.get('Authorization') ?? ''
  const expected   = `Bearer ${APIFY_WEBHOOK_SECRET}`
  if (authHeader.length !== expected.length) return new Response('Unauthorized', { status: 401 })
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) mismatch |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i)
  if (mismatch !== 0) return new Response('Unauthorized', { status: 401 })

  const rawBody   = await req.text()
  const body      = JSON.parse(rawBody)
  console.log('Apify YouTube payload:', JSON.stringify(body))

  const datasetId = body?.resource?.defaultDatasetId ?? body?.eventData?.datasetId
  if (!datasetId) return new Response('Missing datasetId', { status: 400 })

  const sbHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }

  // Fetch items from Apify dataset
  const apifyRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_KEY}`,
  )
  if (!apifyRes.ok) return new Response(`Apify fetch failed: ${apifyRes.status}`, { status: 502 })
  const items: ApifyItem[] = await apifyRes.json()
  console.log(`Fetched ${items.length} items from Apify. Sample types: ${[...new Set(items.slice(0, 5).map(i => i.type))].join(',')}`)
  console.log(`Sample inputChannelUrls: ${items.slice(0, 3).map(i => i.inputChannelUrl).join(' | ')}`)

  // Build inputChannelUrl → source_id map (matches rss_url exactly)
  const sourceRes = await fetch(
    `${SUPABASE_URL}/rest/v1/sources?source_type=eq.youtube&is_active=eq.true&select=id,name,rss_url,metadata`,
    { headers: sbHeaders },
  )
  if (!sourceRes.ok) return new Response('Source lookup failed', { status: 500 })
  const sources: { id: string; name: string; rss_url: string; metadata?: Record<string, unknown> | null }[] = await sourceRes.json()
  console.log(`Known YouTube sources (${sources.length}): ${sources.map(s => `${s.name}=${s.rss_url}`).join(' | ')}`)
  const sourceByAlias = new Map<string, { id: string; name: string; canonicalUrl: string }>()
  for (const source of sources) {
    for (const alias of youtubeSourceAliases(source)) {
      sourceByAlias.set(alias, { id: source.id, name: source.name, canonicalUrl: source.rss_url })
    }
  }

  // Filter to video items with a mapped source.
  // No code-side date cutoff — Apify's dateFilter config is the recency gate.
  const typeOk   = items.filter(i => i.type === 'video')
  const urlOk    = typeOk.filter(i => i.url && i.inputChannelUrl)
  const sourceOk = urlOk
    .map(item => ({ item, source: sourceByAlias.get(normalizeSocialSourceUrl(item.inputChannelUrl!)) }))
    .filter((row): row is { item: ApifyItem; source: { id: string; name: string; canonicalUrl: string } } => Boolean(row.source))
  const unmatched = urlOk
    .filter(item => !sourceByAlias.has(normalizeSocialSourceUrl(item.inputChannelUrl!)))
    .map(item => item.inputChannelUrl)
  console.log(`Filter stages: total=${items.length} type=video:${typeOk.length} hasUrl:${urlOk.length} knownSource:${sourceOk.length}`)
  if (unmatched.length > 0) {
    console.log(`Unmatched YouTube inputChannelUrls: ${[...new Set(unmatched)].slice(0, 10).join(' | ')}`)
  }
  const validItems = sourceOk

  // Dedup against raw_ingestion
  const allUrls    = validItems.map(row => row.item.url)
  const knownUrls  = await fetchKnownUrls(allUrls, SUPABASE_URL, sbHeaders)
  const newItems   = validItems.filter(row => !knownUrls.has(row.item.url))

  if (newItems.length === 0) {
    console.log('No new YouTube videos to insert.')
    return new Response(JSON.stringify({ inserted: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const rows = newItems.map(({ item, source }) => {
    // Apify returns subtitles as [{srt: "<SRT format string>", ...}].
    // Parse SRT: strip sequence numbers and timestamps, join text lines.
    const srtTimestamp = /^\d{2}:\d{2}:\d{1,2},\d{3} --> /
    const transcript = Array.isArray(item.subtitles)
      ? item.subtitles
          .map(s => (s.srt ?? '')
            .split('\n')
            .filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !srtTimestamp.test(l))
            .join(' '))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      : ''

    return {
      source_id:   source.id,
      url:         item.url,
      raw_content: transcript,
      fetched_at:  new Date().toISOString(),
      status:      'pending',
      metadata:    {
        likes: item.likes ?? 0,
        show_name: source.name || item.channelName || '',
        input_channel_url: item.inputChannelUrl ?? null,
        source_page: source.canonicalUrl,
      },
      published_at: item.date ?? null,
    }
  }).filter(row => row.raw_content.length >= 200)  // skip videos with no usable transcript

  console.log(`Inserting ${rows.length} YouTube videos (${newItems.length - rows.length} skipped — no transcript).`)

  const insertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/raw_ingestion?on_conflict=url`,
    {
      method:  'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
      body:    JSON.stringify(rows),
    },
  )
  if (!insertRes.ok) {
    const err = await insertRes.text()
    console.error('Insert failed:', err)
    return new Response(`Insert failed: ${insertRes.status}`, { status: 500 })
  }

  return new Response(JSON.stringify({ inserted: rows.length }), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  })
})
