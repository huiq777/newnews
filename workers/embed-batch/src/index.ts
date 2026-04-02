export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  COHERE_API_KEY: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

export default {
  async fetch() {
    return new Response('ok')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // Fetch up to 45 articles with no embedding yet
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/daily_news?embedding=is.null&select=id,summary,article_content&order=created_at.desc,id.desc&limit=45`,
      { headers: SB(env) }
    )
    const articles: { id: string; summary: string; article_content: string | null }[] = await res.json()

    if (articles.length === 0) {
      console.log('No articles to embed.')
      return
    }

    console.log(`Embedding ${articles.length} articles`)

    // Send all summaries to Cohere in a single batch call
    const cohereRes = await fetch('https://api.cohere.com/v1/embed', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'embed-english-v3.0',
        input_type: 'search_document',
        // Prefer full article content for richer embeddings; fall back to summary.
        // Cohere embed-english-v3.0 supports 512 tokens ≈ 2000 chars.
        texts: articles.map(a => (a.article_content || a.summary || '').substring(0, 2000)),
      }),
    })

    if (!cohereRes.ok) {
      const err = await cohereRes.text()
      console.error(`Cohere error ${cohereRes.status}: ${err.substring(0, 200)}`)
      return
    }

    const cohereData: any = await cohereRes.json()
    const embeddings: number[][] = cohereData.embeddings

    // Write each embedding back to daily_news
    await Promise.all(
      articles.map((article, i) =>
        fetch(`${env.SUPABASE_URL}/rest/v1/daily_news?id=eq.${article.id}`, {
          method: 'PATCH',
          headers: SB(env),
          body: JSON.stringify({ embedding: `[${embeddings[i].join(',')}]` }),
        })
      )
    )

    console.log(`Done. Embedded ${articles.length} articles.`)
  },
}
