import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')!
  const APIFY_WEBHOOK_SECRET = Deno.env.get('APIFY_WEBHOOK_SECRET')!

  // Validate webhook secret
  const authHeader = req.headers.get('Authorization') || ''
  if (authHeader !== `Bearer ${APIFY_WEBHOOK_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await req.json()
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

  // Map items to raw_ingestion rows
  const rows = items
    .filter((item: any) => item.url && item.text && item.author?.userName)
    .map((item: any) => ({
      source_id: sourceId,
      url: item.url,
      raw_content: `@${item.author.userName}: ${item.text}`,
      metadata: { likes: item.likeCount ?? 0, retweets: item.retweetCount ?? 0 },
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
