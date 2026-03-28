# Current Task: MVP Ingestion Pipeline + Rough Frontend

## What We're Building Right Now

**In scope:**
- Supabase database (3 tables only)
- Cloudflare Worker 1: Pull RSS feeds → store raw articles
- Cloudflare Worker 2: Summarize with Groq → store clean articles
- A single-screen Expo app to display article summaries

**Out of scope (for now):**
- Cohere embeddings and vector search (Worker 3)
- Both AI chatbots
- Auth / login screen
- UI design / polish
- iOS build

**Why this order:** The entire product depends on having good, reliable article data in the database. Validate that the pipeline produces quality summaries before building anything on top of it.

---

## Step 0: Create Your Accounts

Do this before writing a single line of code.

### Supabase (your database)
1. Go to supabase.com → Create account → New Project
2. Pick a name, set a strong database password, choose the nearest region
3. Once created, go to: **Settings → API**
4. Copy and save these three values:
   - **Project URL** (`https://xxxxx.supabase.co`)
   - **anon / public key** — safe for the frontend
   - **service_role key** — bypasses all security; never expose this client-side

### Cloudflare (your automation runtime)
1. Go to cloudflare.com → Create a free account
2. No credit card required. The Workers free tier is permanent, not a trial.
3. Install the Wrangler CLI on your machine:
   ```bash
   npm install -g wrangler
   wrangler login   # opens browser to authenticate
   ```

### Groq (your AI summarizer)
1. Go to console.groq.com → Create account
2. Go to **API Keys** → **Create API Key**
3. Copy and save it — you only see it once

---

## Step 1: Set Up the Database

Go to your Supabase project → **SQL Editor** → paste and run this SQL.

This is a trimmed version of the full schema — only what you need right now. No chat tables, no RLS yet.

```sql
-- Enable pgvector (safe to run now, needed in Phase 2)
CREATE EXTENSION IF NOT EXISTS vector;

-- Source registry: one row per RSS feed
CREATE TABLE sources (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT        NOT NULL,
    rss_url    TEXT        UNIQUE NOT NULL,
    is_active  BOOLEAN     NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ingestion queue: raw articles waiting to be processed
CREATE TYPE ingestion_status AS ENUM ('pending', 'processing', 'done', 'error');

CREATE TABLE raw_ingestion (
    id           UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id    UUID              NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url          TEXT              UNIQUE NOT NULL,
    raw_content  TEXT,
    fetched_at   TIMESTAMPTZ       NOT NULL DEFAULT now(),
    status       ingestion_status  NOT NULL DEFAULT 'pending',
    retry_count  INTEGER           NOT NULL DEFAULT 0,
    last_error   TEXT,
    processed_at TIMESTAMPTZ
);

-- Clean articles: AI-summarized, ready to display
CREATE TABLE daily_news (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id        UUID        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    raw_ingestion_id UUID        NOT NULL REFERENCES raw_ingestion(id) ON DELETE RESTRICT,
    url              TEXT        UNIQUE NOT NULL,
    title            TEXT        NOT NULL,
    summary          TEXT        NOT NULL,
    published_at     TIMESTAMPTZ,
    embedding        vector(1024),   -- null for now, filled in Phase 2
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_raw_ingestion_pending ON raw_ingestion (status) WHERE status = 'pending';
CREATE INDEX idx_daily_news_no_embedding ON daily_news (id) WHERE embedding IS NULL;
```

Then seed your RSS sources:
```sql
INSERT INTO sources (name, rss_url) VALUES
    ('TechCrunch',   'https://techcrunch.com/feed/'),
    ('The Verge',    'https://www.theverge.com/rss/index.xml'),
    ('Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index');
```

**Verify:** Go to **Table Editor** — you should see 3 tables and 3 rows in `sources`.

---

## Step 2: Create the Workers Project

In your project repo, create this folder structure:
```
workers/
├── ingest-rss/
│   ├── wrangler.toml
│   └── src/index.ts
└── process-queue/
    ├── wrangler.toml
    └── src/index.ts
```

Add secrets to each worker (you'll be prompted to paste each value):
```bash
cd workers/ingest-rss
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

cd ../process-queue
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GROQ_API_KEY
```

> **What are Worker secrets?** They're encrypted environment variables stored in Cloudflare's system. They never appear in your code or git history. This is the equivalent of what n8n's "credential store" was for — but it's free and built into the platform.

---

## Step 3: Build Worker 1 — RSS Fetch

**What it does:** Reads your `sources` table, fetches all RSS feeds in parallel, stores new articles in `raw_ingestion`. Runs once a day.

### `workers/ingest-rss/wrangler.toml`
```toml
name = "ingest-rss"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["0 7 * * *"]   # Every day at 07:00 UTC
```

### `workers/ingest-rss/src/index.ts`
```typescript
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
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Get active sources from Supabase
    const sourcesRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sources?is_active=eq.true&select=id,rss_url`,
      { headers: SB(env) }
    )
    const sources: { id: string; rss_url: string }[] = await sourcesRes.json()

    // 2. Fetch all RSS feeds in parallel (not one-by-one)
    const feedResults = await Promise.all(
      sources.map(async (source) => {
        try {
          const res = await fetch(source.rss_url)
          const xml = await res.text()
          return { source_id: source.id, items: parseRSS(xml) }
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

    await Promise.all(
      allItems.map(item =>
        fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion`, {
          method: 'POST',
          headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            source_id: item.source_id,
            url: item.url,
            raw_content: item.content,
            status: 'pending',
          }),
        })
      )
    )

    console.log(`Done. Attempted to insert ${allItems.length} articles.`)
  },
}

function parseRSS(xml: string): { url: string; content: string }[] {
  const items: { url: string; content: string }[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const url = extract(block, 'link') || extract(block, 'guid') || ''
    const content =
      extract(block, 'content:encoded') ||
      extract(block, 'description') ||
      extract(block, 'summary') || ''
    if (url) items.push({ url: url.trim(), content: content.trim() })
  }
  return items
}

function extract(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
    || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m?.[1] ?? ''
}
```

**Deploy and test:**
```bash
cd workers/ingest-rss
wrangler deploy

# Test without waiting for the cron (triggers it immediately):
wrangler dev &
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```

**What to check:** Go to Supabase → Table Editor → `raw_ingestion`. You should see rows with `status = pending`. Run the test again — the row count should NOT increase (idempotency working).

**Common issues:**
- Feed returns 0 items → Check the raw XML in Worker logs. Some feeds use `<entry>` (Atom format) instead of `<item>` — the parser above handles RSS only. Check the feed URL manually in a browser.
- URL column is empty → The feed uses `<guid>` instead of `<link>`. The parser already handles this, but verify by logging `url` in the parseRSS function.

---

## Step 4: Build Worker 2 — Groq Summarization

**What it does:** Picks up pending articles from `raw_ingestion`, summarizes them with Groq in parallel, writes clean summaries to `daily_news`. Runs every 15 minutes.

### `workers/process-queue/wrangler.toml`
```toml
name = "process-queue"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["*/15 * * * *"]   # Every 15 minutes
```

### `workers/process-queue/src/index.ts`
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

export default {
  async fetch() {
    return new Response('ok')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // limit=5: free tier allows 50 subrequests; 1 + 5×4 = 21, safe headroom
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?status=eq.pending&limit=5&select=id,source_id,url,raw_content`,
      { headers: SB(env) }
    )
    const articles: { id: string; source_id: string; url: string; raw_content: string }[] = await res.json()

    if (articles.length === 0) {
      console.log('No pending articles.')
      return
    }

    console.log(`Processing ${articles.length} articles`)

    // Lock rows before calling Groq — prevents double-processing on retry
    await Promise.all(
      articles.map(a =>
        fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${a.id}`, {
          method: 'PATCH',
          headers: SB(env),
          body: JSON.stringify({ status: 'processing' }),
        })
      )
    )

    await Promise.all(articles.map(a => processArticle(a, env)))
    console.log('Done.')
  },
}

async function insertAndMarkDone(
  article: { id: string; source_id: string; url: string },
  title: string,
  summary: string,
  env: Env
) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/daily_news`, {
    method: 'POST',
    headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      source_id: article.source_id,
      raw_ingestion_id: article.id,
      url: article.url,
      title,
      summary,
    }),
  })

  await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
    method: 'PATCH',
    headers: SB(env),
    body: JSON.stringify({ status: 'done', processed_at: new Date().toISOString() }),
  })
}

const SOCIAL_DOMAINS = ['x.com', 'twitter.com', 'reddit.com']

async function fetchPageTitle(url: string): Promise<string | null> {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    if (SOCIAL_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
    clearTimeout(timer)

    if (!res.ok) return null
    const html = await res.text()

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const raw = titleMatch?.[1]?.trim() || ''
    if (raw) {
      const cleaned = raw.split(/\s+[|\-–]\s+/)[0].trim()
      if (cleaned.length > 0) return cleaned
    }

    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    return h1Match?.[1]?.trim() || null
  } catch {
    return null
  }
}

async function processArticle(
  article: { id: string; source_id: string; url: string; raw_content: string },
  env: Env
) {
  try {
    const rawContent = (article.raw_content || '').trim()

    // No content at all — skip and mark as error
    if (rawContent.length === 0) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
        method: 'PATCH',
        headers: SB(env),
        body: JSON.stringify({ status: 'error', last_error: 'empty raw_content' }),
      })
      console.log(`SKIP (empty): ${article.url}`)
      return
    }

    // Fetch real page title (null for social media or on failure)
    const pageTitle = await fetchPageTitle(article.url)

    // Too short to summarize — use content directly
    if (rawContent.length < 300) {
      const title = pageTitle || rawContent.split(/[.\n]/)[0]?.trim() || 'No title'
      await insertAndMarkDone(article, title, rawContent, env)
      console.log(`SHORT: ${article.url}`)
      return
    }

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
            content: 'You are a news summarizer. Output exactly 3 concise bullet points capturing the core facts. Plain text only. No markdown. Each line starts with •',
          },
          {
            role: 'user',
            content: `Summarize this article:\n\n${rawContent.substring(0, 24000)}`,
          },
        ],
      }),
    })

    if (!groqRes.ok) {
      const errText = await groqRes.text()
      throw new Error(`Groq ${groqRes.status}: ${errText.substring(0, 200)}`)
    }

    const data: any = await groqRes.json()
    const summary = (data.choices?.[0]?.message?.content || '').trim()

    if (!summary) {
      throw new Error('Groq returned empty summary')
    }

    const title = pageTitle
      || summary.split('\n').find((l: string) => l.trim())?.replace(/^[•\-\*]\s*/, '')
      || 'Untitled'

    await insertAndMarkDone(article, title, summary, env)
    console.log(`OK: ${article.url}`)

  } catch (err: any) {
    console.error(`FAIL: ${article.url}`, err.message)

    const countRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}&select=retry_count`,
      { headers: SB(env) }
    )
    const countData = await countRes.json() as { retry_count: number }[]
    const newCount = (countData[0]?.retry_count ?? 0) + 1

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

**Deploy and test:**
```bash
cd workers/process-queue
wrangler deploy

wrangler dev &
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

**What to check:**
- Supabase → `daily_news` should have rows with real summaries
- Supabase → `raw_ingestion` should show those rows with `status = done`
- Inspect a summary — does it look like 3 coherent bullet points about the article?

**How to read Worker logs:**
```bash
wrangler tail process-queue
```
Every `console.log` and `console.error` from the worker appears here in real time.

**Common issues:**
- `raw_ingestion` rows stay as `processing` forever → the Worker crashed mid-run. Manually reset them: `UPDATE raw_ingestion SET status = 'pending' WHERE status = 'processing'`
- Groq returns garbled output → check the `raw_content` column in `raw_ingestion`. If it's full of HTML tags, the RSS feed returned full HTML instead of article text. The truncation will still protect Groq but the output quality will suffer. This is a data quality issue, not a code bug.

---

## Step 5: Rough Frontend

One screen. No auth. No design. Just prove the data shows up.

### Setup
```bash
npx create-expo-app@latest news-test --template blank-typescript
cd news-test
npx expo install @supabase/supabase-js
```

Create `.env.local`:
```
EXPO_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here
```

### `App.tsx` (replace the entire file)
```typescript
import { useEffect, useState } from 'react'
import { FlatList, Text, View, StyleSheet, ActivityIndicator, SafeAreaView } from 'react-native'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
)

type Article = {
  id: string
  title: string
  summary: string
  created_at: string
  sources: { name: string }
}

export default function App() {
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('daily_news')
      .select('id, title, summary, created_at, sources(name)')
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (error) console.error(error)
        else setArticles(data as Article[])
        setLoading(false)
      })
  }, [])

  if (loading) return <ActivityIndicator style={{ flex: 1 }} />

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>News Feed</Text>
      <FlatList
        data={articles}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.source}>{item.sources?.name}</Text>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.summary}>{item.summary}</Text>
          </View>
        )}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header:    { fontSize: 24, fontWeight: 'bold', padding: 16 },
  card:      { backgroundColor: '#fff', margin: 8, padding: 16, borderRadius: 8 },
  source:    { fontSize: 12, color: '#888', marginBottom: 4 },
  title:     { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  summary:   { fontSize: 14, color: '#333', lineHeight: 20 },
})
```

```bash
npx expo start --web
```

Open `http://localhost:8081`. You should see your articles.

> **Note:** In this phase we skipped RLS. The `daily_news` table has no policies, so the anon key can read it freely. When you add RLS in Phase 2, add `CREATE POLICY "public_read_daily_news" ON daily_news FOR SELECT USING (true)` to keep it working.

---

## End-to-End Verification Checklist

- [ ] Supabase: `sources` table has 3 rows
- [ ] Worker secrets set: `wrangler secret list` shows expected keys in both workers
- [ ] **Trigger Worker 1 manually** → `raw_ingestion` shows rows with `status = pending`
- [ ] **Trigger Worker 1 again** → row count unchanged (idempotency works)
- [ ] **Trigger Worker 2 manually** → `daily_news` shows rows with summaries
- [ ] Read a summary — does it look like 3 real bullet points about the article?
- [ ] **Trigger Worker 2 again** → `daily_news` row count unchanged (no duplicates)
- [ ] `raw_ingestion` rows show `status = done` and `processed_at` is set
- [ ] **Open the Expo app** → articles are visible on screen

---

## What Comes Next

Once summaries look good, Phase 2 adds:

1. **Cohere embeddings** — Worker 3 (`embed-batch`), spec in [docs/ingestion-pipeline.md](docs/ingestion-pipeline.md)
2. **Auth + RLS** — full schema from [docs/schema.md](docs/schema.md)
3. **Chatbot 1 and 2** — Edge Function contracts in [docs/edge-functions.md](docs/edge-functions.md)
4. **Polished frontend** — screen specs in [docs/frontend.md](docs/frontend.md)

Don't move to Phase 2 until the summaries look good. Bad pipeline data means bad AI answers — no RAG tuning fixes a broken ingestion step.
