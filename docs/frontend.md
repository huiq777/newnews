# Frontend

React Native (Expo) targeting web-first. The entire UI lives in a single file: `news-app/App.tsx`. No Expo Router, no auth, no chat screens — a single-screen feed with inline per-article Q&A.

---

## Project Setup

```bash
cd news-app
npm install

# Start dev server (web)
npx expo start --web
```

The Supabase client is initialized inline in `App.tsx` using `EXPO_PUBLIC_*` environment variables from `.env.local`:

```
EXPO_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here
```

**Critical:** `EXPO_PUBLIC_*` vars are baked into the static bundle at build time (like `REACT_APP_*` in CRA). They cannot be injected at runtime by a CDN. They must be present in the shell environment before running `npx expo export --platform web`.

---

## Architecture

Single-file app (`App.tsx`) with no navigation library. The main structure:

```
App
└── FlatList (paginated feed)
    └── ArticleCard (one per article)
        ├── Header (source label + engagement badge + ? Questions pill)
        ├── Title (title_en or title_zh based on lang)
        ├── Summary (3 bullets via MarkdownText)
        ├── Read more → (only tap target for URL open)
        └── Questions section (expand/collapse)
            ├── Question rows (Q1, Q2, Q3)
            └── Answer block (streaming via answer-question SSE)
```

---

## Key Components

### `MarkdownText`
Renders `• **Label:** text` lines with proper bullet indentation and bold inline. Replaces the old `BoldText` component.

```typescript
// Handles: "• **AI:** OpenAI cut prices by 40%" → bullet + bold "AI:" + normal text
function MarkdownText({ text, style }: { text: string; style?: TextStyle }) { ... }
```

Applied to: summary bullets, answer content lines.

### `fmtNum()`
Formats engagement counts with K-suffix.

```typescript
fmtNum(1500)  // → "1.5K"
fmtNum(900)   // → "900"
```

### Language Toggle
- State: `lang: 'en' | 'zh'` — controls which title/summary/questions to display
- Scroll position preserved via proportional mapping:
  - On toggle: capture `proportion = currentOffset / contentHeightRef[currentLang]`
  - After re-render: `onContentSizeChange` fires → `scrollToOffset(proportion × newHeight)`
  - Refs: `contentHeightRef`, `pendingProportionRef`, `langRef`
- Open answers reset on toggle (stale answers from other language discarded)

### Pagination
- 20 articles per page; page number nav buttons
- Fetches from Supabase REST API with `limit=20&offset=page*20`

---

## Data Fetching

**Sources fetched separately** (not via embedded join):
```typescript
// Correct — fetch separately, build client-side lookup map
const [articles, sources] = await Promise.all([
  fetch(`${url}/daily_news?select=...&limit=20`),
  fetch(`${url}/sources?select=id,name,metadata`)
])
const sourceMap = Object.fromEntries(sources.map(s => [s.id, s]))
```

PostgREST embedded joins are cache-sensitive and can silently return null for recently added columns. Always fetch separately.

---

## Streaming (answer-question)

Use native `fetch` with `ReadableStream`. **Never use `supabase.functions.invoke()`** — it buffers the full response, defeating streaming.

```typescript
async function handleAsk(articleId: string, question: string) {
  const res = await fetch(`${supabaseUrl}/functions/v1/answer-question`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ article_id: articleId, question, lang }),
  })

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        const event = JSON.parse(line.slice(6))
        if (event.type === 'content') {
          // append to answer state, re-render word-by-word
        }
      }
    }
  }
}
```

The `▌` cursor is appended to the last non-empty line during streaming and removed on `[DONE]`.

---

## Visual Design

**Warm editorial aesthetic:**

| Token | Value | Usage |
|-------|-------|-------|
| Background | `#F7F6F2` | Screen bg |
| Accent / pills | `#1A1A1A` | Q pill, page nav |
| Borders | `#E0DDD6` | Card dividers |
| Answer block bg | `#F0EDE8` | Answer container |
| Title weight | 700 | `letterSpacing: -0.3` |
| Engagement pill | `#D97706` (amber) | 🔥 likes for tweets |

---

## Deployment — Cloudflare Pages

**Stage 4 target.** Cloudflare Pages is used over Vercel because the project is already in the Cloudflare ecosystem (`wrangler` is installed; Workers + Pages share the same dashboard).

### Option A — Local deploy

Ensure `.env.local` has both `EXPO_PUBLIC_*` vars, then:

```bash
cd news-app

# First-time setup
npx wrangler pages project create news-app

# Build (env vars must be in shell/env at this point)
npx expo export --platform web    # output: news-app/dist/

# Deploy
npx wrangler pages deploy dist --project-name news-app
```

### Option B — CI/CD via GitHub

1. Cloudflare Dashboard → Pages → Create a project → Connect to Git
2. Build command: `cd news-app && npx expo export --platform web`
3. Output directory: `news-app/dist`
4. Set env vars in Pages → Settings → Environment variables → Production:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`

These are injected at build time by Cloudflare Pages CI — same effect as a local `.env.local`.

### Verify

Open the Pages URL → articles load → Q&A streaming works → language toggle works.

---

## Local Development

```bash
cd news-app
npx expo start --web   # opens at http://localhost:8081
```

No console errors should appear. SSE streaming requires the Supabase Edge Functions to be deployed — local testing of streaming uses the deployed function (not a local mock).
