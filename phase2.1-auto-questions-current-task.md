# Phase 2.1: Auto-Questions Feature

> **This document replaces `phase2-chatbots-current-task.md` entirely.**
> The original Phase 2 plan (dual chatbots, auth, frontend rebuild) is superseded by this spec.

---

## Context & Motivation

The original Phase 2 planned two standalone chatbots — a general-purpose "chat-live" and a RAG-powered "chat-rag" — behind a login wall. Both required a blank chat box where the user had to think of questions themselves. After product review, this pattern was rejected for two reasons:

1. **Cognitive burden**: blank chat boxes require the user to know what to ask. Most users (including the primary user — yourself) will open it and close it without engaging.
2. **Discoverability is zero**: features hidden behind a tab that requires a question to activate are functionally invisible.

The replacement is an **Auto-Questions** feature. The product surfaces 3 contextually relevant questions per article, pre-generated at ingestion time, inline on every article card. The user only needs to click. Answers stream back with visible AI reasoning. No chat box. No login. No blank canvas.

This is also a stronger resume artifact — it demonstrates product judgment (AI UX, not just AI output) and a full pipeline: ingestion → AI generation → streaming → bilingual support.

---

## What Changes vs. Original Plan

| Original Phase 2 | Revised |
|---|---|
| `chat-live` edge function (general Q&A chatbot — was in original doc, never designed by us) | **Dropped entirely — never building this** |
| `chat-rag` as standalone chat screen | **Repurposed** as `answer-question` endpoint |
| Auth / login screen | **Dropped** — personal tool, no gatekeeping needed |
| `chat_sessions` + `messages` DB tables | **Dropped** — no sessions, no persistence |
| Full frontend rebuild with Expo Router | **Dropped** — evolve existing `news-app` in place |
| User types questions manually | **Replaced** — 3 questions auto-generated per article |

**What carries forward from the original plan unchanged:**
- `embed-batch` Cloudflare Worker — still needed for vector embeddings
- `GROQ_API_KEY` — same key already used by `process-queue`; also add as Edge Function secret
- `COHERE_API_KEY` — same setup, add as both Worker and Edge Function secret
- `match_articles` pgvector RPC function in Supabase — still needed

---

## Step 0: API Keys & Secrets

No new accounts required. All keys already exist or are set up in the original plan.

**Groq** — reuse existing `GROQ_API_KEY` from `process-queue` worker. Add it as:
- Cloudflare Worker secret: `embed-batch`
- Supabase Edge Function secret: `answer-question`, `refresh-questions`

**Cohere** — reuse or create at dashboard.cohere.com. Add as:
- Cloudflare Worker secret: `embed-batch`
- Supabase Edge Function secret: `answer-question`

**Supabase** — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` needed in Edge Functions. All available from Supabase Dashboard → Settings → API.

---

## Step 1: Database Schema

### Add to `daily_news` table

One new column to hold pre-generated questions in both languages:

```sql
ALTER TABLE daily_news ADD COLUMN questions JSONB;
```

Stored shape:
```json
{
  "en": ["Question 1?", "Question 2?", "Question 3?"],
  "zh": ["问题一？", "问题二？", "问题三？"]
}
```

Null until `process-queue` runs on the article. Articles with null questions simply don't show the pill on the frontend — no error state needed.

### Add `match_articles` RPC function

Required by `answer-question` for potential cross-article reasoning. Run in Supabase SQL Editor:

```sql
CREATE OR REPLACE FUNCTION match_articles(
  query_embedding vector(1024),
  match_count     int DEFAULT 5
)
RETURNS TABLE (id UUID, title TEXT, summary TEXT, score FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT id, title, summary,
         1 - (embedding <=> query_embedding) AS score
  FROM daily_news
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

### What NOT to create

Skip everything else from the original plan's schema section:
- No `chat_sessions` table
- No `messages` table
- No RLS policies for the above
- No Supabase Auth setup

---

## Step 2: Modify `process-queue` Worker

**File:** `workers/process-queue/src/index.ts`

### What already happens (keep unchanged)
The worker fetches pending articles from `raw_ingestion`, calls Groq to generate bilingual titles and summaries, and writes the result to `daily_news`.

### What to add
After the summary is written to `daily_news`, fire a second Groq call to generate 3 questions per language. Use `llama-3.3-70b-versatile` (same model, same free tier key).

**English question prompt:**
> Given this article summary, generate exactly 3 insightful questions a reader would naturally ask after reading it. Return a JSON array of 3 strings only. No preamble, no numbering.

**Chinese question prompt (use summary_zh as input):**
> 根据以下文章摘要，生成读者阅读后最想深入了解的3个问题。仅返回包含3个字符串的JSON数组，无需说明。

Parse both responses into arrays and include `questions: { en: [...], zh: [...] }` in the initial `daily_news` insert body — no separate PATCH needed.

**Failure behavior:** If question generation fails for any reason, the article saves normally with `questions: null`. Non-blocking. The pill simply won't appear for that article on the frontend.

**Temperature:** Use `0.7` for question generation (slightly higher than summary's `0.1`) to encourage variety across articles and refresh cycles.

---

## Step 3: `embed-batch` Cloudflare Worker

**Directory:** `workers/embed-batch/`

This worker is unchanged from the original Phase 2 spec. It:
- Runs every 5 minutes via Cloudflare cron
- Fetches up to 45 `daily_news` rows where `embedding IS NULL`
- Sends all summaries to Cohere `embed-english-v3.0` in a single batch call (`input_type: search_document`)
- Writes 1024-dimension vectors back to each row

Required secrets for this worker:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `COHERE_API_KEY`

Deploy with `wrangler deploy` from `workers/embed-batch/`. Test by triggering the scheduled endpoint locally and verifying the `embedding` column populates in the Supabase `daily_news` table.

---

## Step 4: Edge Function — `answer-question`

**File:** `supabase/functions/answer-question/index.ts`

This replaces the original `chat-rag` concept. Article-scoped, stateless, no auth.

### Input
```json
{ "article_id": "uuid", "question": "string", "lang": "en" | "zh" }
```

### Behavior
1. Fetch the article's `title`, `summary_en`, `summary_zh`, and `published_at` from `daily_news` using the Supabase REST API with service role key
2. Build a context string directly from the article — no vector search needed since we already know exactly which article the question is about
3. Call Groq `deepseek-r1-distill-llama-70b` with streaming enabled
4. Stream two distinct SSE event types to the client:
   - `{ "type": "thinking", "content": "..." }` — DeepSeek-R1's chain-of-thought reasoning, emitted as `reasoning_content` in the delta
   - `{ "type": "content", "content": "..." }` — the final answer, emitted as `content` in the delta
5. Send `data: [DONE]` when the stream ends

### No authentication required
`daily_news` has a `public_read_daily_news` RLS policy already in place from Phase 1. Anyone (or any server) can read articles. No JWT verification needed.

### System prompt direction
The prompt should instruct the model to act as a sharp, direct news analyst answering based only on the provided article. If the article lacks enough information to answer the question, it should say so clearly rather than fabricating context. Response language should match the `lang` parameter.

### Required secrets
- `GROQ_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

---

## Step 5: Edge Function — `refresh-questions`

**File:** `supabase/functions/refresh-questions/index.ts`

Handles on-demand question regeneration when the user clicks `↻` on an article card.

### Input
```json
{ "article_id": "uuid" }
```

### Behavior
1. Fetch the article's `summary_en` and `summary_zh` from `daily_news`
2. Call Groq (same prompts as `process-queue`, same `llama-3.3-70b-versatile`) to generate 3 new EN questions and 3 new ZH questions
3. PATCH `daily_news` to update `questions` for this article — the new questions persist for future visits
4. Return the new questions as a JSON response (non-streaming — fast enough that streaming is unnecessary)

### No authentication required
Same reasoning as `answer-question` — reads and writes only public article data.

### Required secrets
- `GROQ_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

---

## Step 6: Frontend — Evolve `news-app`

**Critical file:** `news-app/App.tsx`

Do not rebuild with Expo Router. Evolve the existing app in place. The current `App.tsx` has a working FlatList feed with language toggle, pagination, and source labeling. All of that stays. The article card rendering gets extended.

### New `Article` type field
Add `questions` to the existing `Article` type:
```
questions: { en: string[], zh: string[] } | null
```
Update the Supabase select query to include `questions`.

### Extract `ArticleCard` as its own component
The current inline `renderItem` lambda becomes a standalone `ArticleCard` component. This is necessary because each card needs independent local state for its questions UI — open/closed, per-question answer state, refresh loading state — without affecting sibling cards.

### Per-card state shape
Each `ArticleCard` manages:
- `questionsOpen: boolean` — whether the questions section is expanded
- `refreshing: boolean` — whether a refresh call is in progress
- `answers: Record<number, AnswerState>` — keyed by question index (0, 1, 2)

Where `AnswerState` is:
- `thinking: string` — accumulated chain-of-thought text
- `content: string` — accumulated answer text
- `thinkingDone: boolean` — whether to auto-collapse the thinking block (true once first `content` chunk arrives)
- `streaming: boolean` — whether this answer is currently receiving chunks

### Visual layout — collapsed (default)

```
┌─────────────────────────────────────────────────┐
│ [Source Label]              [? 3 Questions]      │  ← pill top-right, only if questions non-null
│ Article Title                                    │
│ • Bullet summary line 1                          │
│ • Bullet summary line 2                          │
│ • Bullet summary line 3                          │
│                              [Read more →]       │
└─────────────────────────────────────────────────┘
```

### Visual layout — expanded

```
┌─────────────────────────────────────────────────┐
│ [Source Label]                    [✕ Close]      │
│ Article Title                                    │
│ • Bullet summary line 1                          │
│ • Bullet summary line 2                          │
│ • Bullet summary line 3                          │
│                              [Read more →]       │
│                                                  │
│ ─────────── Questions  ↻ ──────────────────────  │
│                                                  │
│ Q: [question 1]                                  │
│ Q: [question 2]                                  │
│ Q: [question 3]                                  │
└─────────────────────────────────────────────────┘
```

The `↻` refresh icon sits inline with the "Questions" divider text. The divider is a visual separator, not a button — only `↻` is tappable.

### Visual layout — question clicked, thinking in progress

```
│ Q: Why did OpenAI cut prices by 40%?             │  ← clickable row
│ ┌─ Thinking... ──────────────────────────────┐   │
│ │ The article mentions competitive pressure  │   │  ← muted grey bg, small italic text
│ │ from open-source models. I should consider │   │     animated "..." in label while streaming
│ │ what the article says about Meta's timing. │   │
│ └────────────────────────────────────────────┘   │
```

### Visual layout — answer streaming

```
│ Q: Why did OpenAI cut prices by 40%?             │
│ [Thought process ▼]                              │  ← collapsed accordion, tappable
│ ┌────────────────────────────────────────────┐   │
│ │ A: OpenAI reduced pricing primarily in     │   │  ← darker background
│ │ response to intensifying competition from  │     word-by-word, cursor ▌ at end
│ │ open-source models... ▌                    │   │
│ └────────────────────────────────────────────┘   │
```

### Thinking block lifecycle
1. While `thinking` text is arriving and `content` is empty → show expanded `Thinking...` block with animated ellipsis
2. First `content` chunk arrives → `thinkingDone = true` → thinking block auto-collapses to `Thought process ▼` accordion
3. User can tap accordion to re-expand — full reasoning text is preserved in state
4. After stream ends → cursor disappears from answer

### Language toggle behavior
- When `lang` switches EN ↔ 中, questions re-render from `article.questions.en` or `article.questions.zh`
- All open `answers` in the card reset to empty — stale answers from the other language are discarded
- The questions section stays open if it was open; only answers close

### Card tapping behavior
- The entire card is currently a `TouchableOpacity` that opens the URL. With questions expanded, tapping the card body should NOT open the URL — only tapping `Read more →` should. Wrap the existing `onPress` on the card around `Read more →` only, not the whole card.

### Streaming call pattern
- Use `fetch` with `ReadableStream` — do NOT use `supabase.functions.invoke()` (it buffers the full response)
- Parse `data: { type, content }` SSE events line by line
- Dispatch to the correct `answers[index]` state based on which question was clicked
- Edge function base URL from `process.env.EXPO_PUBLIC_SUPABASE_URL`

---

## Deployment Order

Execute in this sequence — earlier steps are dependencies for later ones:

1. **Supabase SQL** — Run schema migration (`ALTER TABLE daily_news ADD COLUMN questions JSONB`) and add `match_articles` function
2. **`process-queue` worker** — Deploy modified version; new articles ingested after this point will have questions
3. **`embed-batch` worker** — Deploy; begins embedding articles every 5 minutes
4. **`answer-question` edge function** — Deploy and set secrets
5. **`refresh-questions` edge function** — Deploy and set secrets
6. **Frontend** — Update `news-app/App.tsx` with new card UI; test locally with `npx expo start --web`
7. **Backfill** — For existing articles without questions, call `refresh-questions` manually for recent ones (last 2–3 days worth)

---

## Verification Checklist

**Pipeline:**
- [ ] `daily_news` rows ingested after the worker update have `questions` JSONB with `en` and `zh` arrays (check Supabase table view)
- [ ] `daily_news` rows have non-null `embedding` after `embed-batch` runs (check the column)

**`answer-question` edge function (test with curl):**
- [ ] Responds with SSE stream
- [ ] First events are `{ "type": "thinking" }` — not empty, not generic, references the actual article content
- [ ] Subsequent events are `{ "type": "content" }` — streams word-by-word
- [ ] Final event is `data: [DONE]`
- [ ] Works with `lang: "zh"` — answer is in Chinese

**`refresh-questions` edge function (test with curl):**
- [ ] Returns JSON with new `en` and `zh` question arrays
- [ ] Questions are visibly different from the ones currently in the DB
- [ ] DB row is updated (verify in Supabase table view)

**Frontend:**
- [ ] `? 3 Questions` pill appears only on cards with non-null questions
- [ ] Clicking pill expands questions section; summary stays visible above
- [ ] Pill label becomes `✕ Close`; clicking it collapses the section
- [ ] Clicking `Q:` shows `Thinking...` block with animated ellipsis and real reasoning text
- [ ] When answer begins streaming, thinking block auto-collapses to `Thought process ▼`
- [ ] `Thought process ▼` is tappable and re-expands to full reasoning
- [ ] Answer streams word-by-word with blinking cursor; cursor disappears on completion
- [ ] Multiple questions can be open simultaneously on the same card
- [ ] Clicking an open question again collapses its answer
- [ ] `↻` shows loading state, open answers collapse, new questions appear
- [ ] Language toggle switches question text between EN and ZH
- [ ] Switching language closes all open answers
- [ ] `Read more →` still opens the article URL correctly
- [ ] Tapping the card body (title/summary area) does NOT accidentally open URL

---

## What Comes After (Phase 3)

- iOS build via Expo EAS
- Vercel deployment for web
- UI design polish
- Additional RSS sources
- Push notifications for daily digest
