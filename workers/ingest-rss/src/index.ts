export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return new Response('ingest-rss worker is running')
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Get active sources
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&source_type=eq.rss&select=id,rss_url`,
      { headers: SB(env) }
    )
    const sources: { id: string; rss_url: string }[] = await sourcesRes.json()
    console.log(`Fetching ${sources.length} sources`)

    // 2. Fetch all RSS feeds in parallel
    const feedResults = await Promise.all(
      sources.map(async (source) => {
        try {
          const res = await fetch(source.rss_url)
          const xml = await res.text()
          const items = parseRSS(xml)
          console.log(`${source.rss_url}: ${items.length} items`)
          return { source_id: source.id, items }
        } catch (e) {
          console.error(`Failed: ${source.rss_url}`, e)
          return { source_id: source.id, items: [] }
        }
      })
    )

    // 3. Insert all items in parallel — duplicates silently skipped
    const allItems = feedResults.flatMap(({ source_id, items }) =>
      items.map(item => ({ source_id, ...item }))
    )

    const rows = allItems.map(item => ({
      source_id: item.source_id,
      url: item.url,
      raw_content: item.content,
      status: 'pending',
    }))

    const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?on_conflict=url`, {
      method: 'POST',
      headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
      body: JSON.stringify(rows),
    })
    if (!insertRes.ok) {
      const err = await insertRes.text()
      console.error(`Batch insert failed ${insertRes.status}: ${err.substring(0, 500)}`)
    }

    console.log(`Done. Attempted ${allItems.length} inserts.`)
  },
}

function parseRSS(xml: string): { url: string; content: string }[] {
  const items: { url: string; content: string }[] = []
  // Support both RSS <item> and Atom <entry>
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    // Atom <link href="..."/> or RSS <link>...</link>
    const atomLink = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || ''
    const url = atomLink || extract(block, 'link') || extract(block, 'guid') || ''
    const content =
      extract(block, 'content') ||
      extract(block, 'content:encoded') ||
      extract(block, 'description') ||
      extract(block, 'summary') || ''
    if (url) items.push({ url: url.trim(), content: content.trim() })
  }
  return items
}

function extract(xml: string, tag: string): string {
  const m =
    xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')) ||
    xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m?.[1] ?? ''
}
