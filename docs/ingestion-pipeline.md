# Ingestion Pipeline

Four Cloudflare Workers handle all data ingestion. They are intentionally decoupled — each does one job, and they communicate through the database rather than chaining directly.

For why the pipeline is structured this way, see [architecture.md](architecture.md).

---

## Prerequisites

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
wrangler login   # opens browser to authenticate with your Cloudflare account
```

### 2. Create a Cloudflare account
Free at cloudflare.com. No credit card required for Workers.

### 3. Project structure for the workers
Create a folder in your repo:
```
workers/
├── ingest-rss/
│   ├── wrangler.toml
│   └── src/index.ts
├── ingest-x/
│   ├── wrangler.toml
│   └── src/index.ts
├── process-queue/
│   ├── wrangler.toml
│   └── src/index.ts
└── embed-batch/
    ├── wrangler.toml
    └── src/index.ts
```

---

## Required Secrets

Each Worker needs secrets added via Wrangler. Run these commands once per Worker:

```bash
# From the ingest-rss/ directory:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# From the process-queue/ directory:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GROQ_API_KEY

# From the embed-batch/ directory:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put COHERE_API_KEY
```

Secrets are encrypted at rest in Cloudflare's system. They are never in your code or your git history.

---

## Worker 1 — `ingest-rss`

**Runs:** Daily at 07:00 UTC
**Does:** Reads the `sources` table, fetches each RSS feed, inserts new articles into `raw_ingestion`.

### `wrangler.toml`
```toml
name = "ingest-rss"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["0 7 * * *"]   # Every day at 07:00 UTC
```

### `src/index.ts`
```typescript
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

const SUPABASE_HEADERS = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Get all active sources
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&select=id,rss_url`,
      { headers: SUPABASE_HEADERS(env) }
    )
    const sources: { id: string; rss_url: string }[] = await sourcesRes.json()

    // 2. Fetch all RSS feeds in parallel
    const feedResults = await Promise.all(
      sources.map(async (source) => {
        try {
          const res = await fetch(source.rss_url)
          const xml = await res.text()
          const items = parseRSS(xml)
          return { source_id: source.id, items }
        } catch (e) {
          console.error(`Failed to fetch ${source.rss_url}:`, e)
          return { source_id: source.id, items: [] }
        }
      })
    )

    // 3. Flatten all items and insert in parallel
    const allItems = feedResults.flatMap(({ source_id, items }) =>
      items.map(item => ({ source_id, ...item }))
    )

    await Promise.all(
      allItems.map(item =>
        fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion`, {
          method: 'POST',
          headers: {
            ...SUPABASE_HEADERS(env),
            'Prefer': 'resolution=ignore-duplicates',   // ON CONFLICT DO NOTHING
          },
          body: JSON.stringify({
            source_id: item.source_id,
            url: item.url,
            raw_content: item.content,
            status: 'pending',
          }),
        })
      )
    )

    console.log(`Inserted up to ${allItems.length} articles (duplicates silently skipped)`)
  },
}

// Minimal RSS parser — handles the most common feed formats
function parseRSS(xml: string): { url: string; content: string }[] {
  const items: { url: string; content: string }[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const url =
      extract(block, 'link') ||
      extract(block, 'guid') ||
      ''
    const content =
      extract(block, 'content:encoded') ||
      extract(block, 'description') ||
      extract(block, 'summary') ||
      ''

    if (url) items.push({ url: url.trim(), content: content.trim() })
  }

  return items
}

function extract(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
    || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1] ?? ''
}
```

**Deploy:**
```bash
cd workers/ingest-rss
wrangler deploy
```

**Test manually (without waiting for cron):**
```bash
wrangler dev   # runs locally
# In another terminal:
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```

---

## Worker 2 — `ingest-x`

**Runs:** Every hour (`0 * * * *`)
**Does:** Fetches recent posts from configured X/Twitter accounts via the X API v2 free tier, writes them to `raw_ingestion` as pending articles.

**Source configuration:** X accounts are rows in the `sources` table with `source_type = 'x_api'`. The `rss_url` column stores the X numeric user ID in the format `x://user/<id>`. Add any account by inserting a row — no code change needed.

```sql
-- Add an X account to track
INSERT INTO sources (name, rss_url, source_type) VALUES
  ('Elon Musk (@elonmusk)', 'x://user/44196397', 'x_api');
```

To find a user's numeric ID: look it up at tweeterid.com.

### `wrangler.toml`
```toml
name = "ingest-x"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["0 * * * *"]
```

### Required secrets
```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put X_BEARER_TOKEN
```

Get `X_BEARER_TOKEN` from: developer.twitter.com → Your App → Keys and Tokens → Bearer Token.

**X API v2 free tier limits:**
- 500K tweet reads/month (~16K/day)
- User timeline endpoint only (no keyword/hashtag search)
- Rate limit: 1 request per 15 minutes per user timeline

### How tweets flow through the pipeline
Tweets are inserted into `raw_ingestion` with `status = 'pending'` and `raw_content = tweet_text`. The `process-queue` worker picks them up like any other article. Since `fetchPageTitle` already skips `x.com` domains, the title falls back to the first line of the tweet text — which is correct behavior for short-form content.

### Deploy
```bash
cd workers/ingest-x
npm install
wrangler deploy
```

### Test manually
```bash
wrangler dev --remote
# In another terminal:
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

---

## Worker 3 — `process-queue`

**Runs:** Every 15 minutes
**Does:** Picks up pending articles from `raw_ingestion`, summarizes them with Groq, writes to `daily_news`.

### `wrangler.toml`
```toml
name = "process-queue"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["*/15 * * * *"]   # Every 15 minutes
```

### `src/index.ts`
```typescript
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GROQ_API_KEY: string
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

const BATCH_SIZE = 20

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Fetch pending articles
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?status=eq.pending&limit=${BATCH_SIZE}&select=id,source_id,url,raw_content`,
      { headers: SB(env) }
    )
    const articles: { id: string; source_id: string; url: string; raw_content: string }[] = await res.json()

    if (articles.length === 0) {
      console.log('No pending articles. Done.')
      return
    }

    // 2. Lock all rows (set to 'processing') before calling Groq
    // This is a pessimistic lock — prevents double-processing if Worker restarts
    await Promise.all(
      articles.map(a =>
        fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${a.id}`, {
          method: 'PATCH',
          headers: SB(env),
          body: JSON.stringify({ status: 'processing' }),
        })
      )
    )

    // 3. Summarize all articles in parallel with Groq
    await Promise.all(articles.map(article => processArticle(article, env)))

    console.log(`Processed ${articles.length} articles`)
  },
}

async function processArticle(
  article: { id: string; source_id: string; url: string; raw_content: string },
  env: Env
) {
  try {
    // Truncate to ~6,000 tokens (24,000 chars at ~4 chars/token)
    const truncated = (article.raw_content || '').substring(0, 24000)

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            // Article text must never appear in system role — prevents prompt injection
            content: 'You are a news summarizer. Output exactly 3 concise bullet points capturing the core facts. Use plain text. No markdown, no introductory sentence — just 3 lines each starting with •',
          },
          {
            role: 'user',
            content: `Summarize this article:\n\n${truncated}`,
          },
        ],
      }),
    })

    const groqData: any = await groqRes.json()
    const summary = groqData.choices?.[0]?.message?.content || ''
    const firstLine = summary.split('\n').find((l: string) => l.trim())
    const title = firstLine?.replace(/^[•\-\*]\s*/, '') || 'Untitled'

    // Insert into daily_news
    await fetch(`${env.SUPABASE_URL}/rest/v1/daily_news`, {
      method: 'POST',
      headers: {
        ...SB(env),
        'Prefer': 'resolution=ignore-duplicates',
      },
      body: JSON.stringify({
        source_id: article.source_id,
        raw_ingestion_id: article.id,
        url: article.url,
        title,
        summary,
      }),
    })

    // Mark as done
    await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
      method: 'PATCH',
      headers: SB(env),
      body: JSON.stringify({ status: 'done', processed_at: new Date().toISOString() }),
    })

  } catch (err: any) {
    console.error(`Failed to process article ${article.id}:`, err)

    // Increment retry count; after 3 failures → permanent error
    const countRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}&select=retry_count`,
      { headers: SB(env) }
    )
    const [{ retry_count }] = await countRes.json()
    const newCount = (retry_count || 0) + 1

    await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
      method: 'PATCH',
      headers: SB(env),
      body: JSON.stringify({
        retry_count: newCount,
        last_error: err.message || String(err),
        status: newCount >= 3 ? 'error' : 'pending',
      }),
    })
  }
}
```

**Deploy:**
```bash
cd workers/process-queue
wrangler deploy
```

---

## Worker 4 — `embed-batch`

**Runs:** Every 5 minutes
**Does:** Finds `daily_news` articles with no embedding, sends summaries to Cohere in a single batch request, writes vectors back.

### `wrangler.toml`
```toml
name = "embed-batch"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["*/5 * * * *"]   # Every 5 minutes
```

### `src/index.ts`
```typescript
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
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Get articles without embeddings
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/daily_news?embedding=is.null&limit=50&select=id,summary`,
      { headers: SB(env) }
    )
    const articles: { id: string; summary: string }[] = await res.json()

    if (articles.length === 0) {
      console.log('No articles need embedding. Done.')
      return
    }

    // 2. Send all summaries to Cohere in ONE batch request
    const cohereRes = await fetch('https://api.cohere.com/v1/embed', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'embed-english-v3.0',
        input_type: 'search_document',  // MUST be 'search_document' here (not 'search_query')
        texts: articles.map(a => a.summary),
      }),
    })

    const cohereData: any = await cohereRes.json()
    const embeddings: number[][] = cohereData.embeddings

    // 3. Write all embeddings back in parallel
    await Promise.all(
      articles.map((article, i) =>
        fetch(`${env.SUPABASE_URL}/rest/v1/daily_news?id=eq.${article.id}`, {
          method: 'PATCH',
          headers: SB(env),
          body: JSON.stringify({ embedding: `[${embeddings[i].join(',')}]` }),
        })
      )
    )

    console.log(`Embedded ${articles.length} articles`)
  },
}
```

**Deploy:**
```bash
cd workers/embed-batch
wrangler deploy
```

---

## Viewing Logs

```bash
# Tail live logs for any worker
wrangler tail ingest-rss
wrangler tail process-queue
wrangler tail embed-batch
```

Logs also appear in the Cloudflare dashboard under **Workers & Pages → your-worker → Logs**.
