# Design Spec: Replace Google AI Studio with OpenRouter

**Date:** 2026-04-18  
**Status:** Approved — Ready for implementation  
**Review:** `docs/superpowers/specs/2026-04-18-openrouter-migration-review.md`

---

## Context

The current pipeline uses Google AI Studio (Gemma 4 31B) as the primary LLM and Groq (Llama 3.3 70B) as a fallback. AI Studio's constrained JSON decoding enforces valid schema output at the token level — a reliability advantage. However, it locks the pipeline to Gemma models only.

The goal is **model flexibility**: swap models by updating a Cloudflare secret, with no redeployment. OpenRouter provides an OpenAI-compatible endpoint that routes to 200+ models. Only free models on OpenRouter will be used (e.g., `google/gemma-2-9b-it:free`), preserving the free-tier constraint.

**Critical risk acknowledged:** OpenRouter free-tier routes through an additional proxy hop (Cloudflare → OpenRouter → backend provider). Free models are subject to heavier 429s and longer cold-start TTFB than AI Studio. The Groq fallback will fire more often. Since Groq is already at 267% of its 100K TPD cap, a high fallback rate will cause rows to get stuck. Fallback rate must be monitored aggressively in the first 48 hours.

**Second risk acknowledged:** OpenRouter's `response_format: json_object` is best-effort, not constrained decoding. Models frequently wrap output in markdown fences (` ```json { } ``` `). `extractFirstJson()` already handles this in `process-queue` — it must also be added to `ingest-builders`.

---

## What Changes vs What Stays the Same

**Unchanged:**
- 8s Phase 1 connection timeout (AbortController pattern)
- Fallback triggers: AbortError → Groq, TCP rejection → Groq, 429 → Groq, non-429 non-2xx → throw
- `callGroqFallback()` — untouched
- `groqResponseToResult()`, `parseSection()`, `parseJsonSection()`, `extractFirstJson()` — untouched
- `normalizeGemmaResponse()` — logic unchanged (not renamed — internal function)
- All sentinel detection (`INSUFFICIENT_CONTENT`, `NOT_AI_RELEVANT`)
- Validation throw for empty `summary_en`/`summary_zh`
- `insertAndMarkDone()`, `processArticle()`, `scheduled()` — untouched
- `fetchArticleContent()` — untouched
- All prompt *content* — prompt constant names change, content does not

**Changed:**
- API endpoint: `generativelanguage.googleapis.com` → `openrouter.ai/api/v1`
- Request format: AI Studio `generateContent` body → OpenAI `chat/completions` body
- Response envelope: `candidates[0].content.parts[0].text` → `choices[0].message.content`
- No constrained decoding (`responseMimeType`/`responseSchema` removed) → `response_format: json_object` (best-effort)
- Env vars: `GOOGLE_AI_STUDIO_API_KEY` → `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` (process-queue), `OPENROUTER_BIO_MODEL` (ingest-builders)
- Prompt constant names: `ARTICLE_SYSTEM_PROMPT_GEMMA` → `ARTICLE_SYSTEM_PROMPT_JSON`, `TWEET_SYSTEM_PROMPT_GEMMA` → `TWEET_SYSTEM_PROMPT_JSON`
- `buildAIStudioSummaryRequest()` → `buildOpenRouterRequest()`
- `parseAIStudioResponse()` deleted — replaced inline
- `ingest-builders`: bio extraction call + `extractFirstJson()` added

---

## Files Affected

| File | Changes |
|------|---------|
| `workers/process-queue/src/index.ts` | Env interface, constants, prompt renames, replace `buildAIStudioSummaryRequest()`, delete `parseAIStudioResponse()`, replace `callLLM()` |
| `workers/ingest-builders/src/index.ts` | Env interface, constants, add `extractFirstJson()`, replace `extractBioMap()` primary path |
| `docs/api-keys-and-env.md` | Add OpenRouter secrets, remove AI Studio key, update cost table |
| `docs/architect-role.md` | Update Fixed Stack table, add Active Risk for OpenRouter |
| `keep-in-mind.md` | Add lesson: model-as-secret is invisible to Git history |

---

## Step 1 — process-queue: Update `Env` interface

**File:** `workers/process-queue/src/index.ts`, lines 238–243

```typescript
// Before
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GROQ_API_KEY: string
  GOOGLE_AI_STUDIO_API_KEY: string
}

// After
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GROQ_API_KEY: string
  OPENROUTER_API_KEY: string
  OPENROUTER_MODEL: string   // e.g. "google/gemma-2-9b-it:free" — runtime secret, no redeploy needed
}
```

---

## Step 2 — process-queue: Update constants

**File:** `workers/process-queue/src/index.ts`, lines 251–253

```typescript
// Before
const AI_STUDIO_MODEL = 'gemma-4-31b-it'
const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions'

// After
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions'
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions'
```

`OPENROUTER_MODEL` is read from `env.OPENROUTER_MODEL` at call time — not a module-level constant — so model swaps take effect on the next cron cycle with no redeployment.

---

## Step 3 — process-queue: Rename JSON prompt constants

**File:** `workers/process-queue/src/index.ts`

Rename (content unchanged — vendor-agnostic names):
- `ARTICLE_SYSTEM_PROMPT_GEMMA` → `ARTICLE_SYSTEM_PROMPT_JSON`
- `TWEET_SYSTEM_PROMPT_GEMMA` → `TWEET_SYSTEM_PROMPT_JSON`

---

## Step 4 — process-queue: Replace `buildAIStudioSummaryRequest()`

**File:** `workers/process-queue/src/index.ts`, lines 266–293

Delete the entire function. Replace with:

```typescript
// Build OpenRouter (OpenAI-compatible) request body for article/tweet summarization.
// Uses response_format: json_object (best-effort — not constrained decoding).
// extractFirstJson() in callLLM() handles markdown-wrapped responses.
function buildOpenRouterRequest(isTweet: boolean, content: string, model: string): object {
  const systemPrompt = isTweet ? TWEET_SYSTEM_PROMPT_JSON : ARTICLE_SYSTEM_PROMPT_JSON
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Summarize this ${isTweet ? 'tweet' : 'article'}:\n\n${content}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 2000,
  }
}
```

Also delete `parseAIStudioResponse()` (lines 295–301) — its logic (one-liner envelope unwrap) moves inline into the new `callLLM()`.

---

## Step 5 — process-queue: Replace `callLLM()`

**File:** `workers/process-queue/src/index.ts`, lines 386–437

All timeout/fallback logic preserved. Only request construction and response parsing change.

```typescript
// Central LLM routing function.
// Primary: OpenRouter (model from env.OPENROUTER_MODEL — swap without redeployment)
// Fallback: Groq llama-3.3-70b (fast failures only — AbortError, TCP rejection, 429)
// Non-429 non-2xx throws immediately — no fallback, fail the row.
async function callLLM(isTweet: boolean, content: string, env: Env): Promise<LLMResult> {
  const controller = new AbortController()
  // Phase 1: 8s connection timeout — guards until headers are received
  // If >5% of invocations hit this, bump to 10s (10s + ~10s Groq + ~2s DB = 22s, within 30s)
  const connectionTimeoutId = setTimeout(() => controller.abort(), 8000)

  const body = buildOpenRouterRequest(isTweet, content, env.OPENROUTER_MODEL)

  let orRes: Response
  try {
    orRes = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://news-app.internal',
        'X-Title': 'NewsApp',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (fetchErr: unknown) {
    clearTimeout(connectionTimeoutId)
    if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
      // No headers within 8s — falling back to Groq (8s + ~10s Groq + ~2s write = ~20s, within 30s)
      console.log('OpenRouter Phase 1 timeout (8s) — no headers received, falling back to Groq')
      return await callGroqFallback(isTweet, content, env)
    }
    // TCP rejection → fast failure → Groq fallback
    console.log('OpenRouter unreachable, falling back to Groq:', (fetchErr as Error).message)
    return await callGroqFallback(isTweet, content, env)
  }

  // Phase 2: headers received — clear the connection timeout
  clearTimeout(connectionTimeoutId)

  if (orRes.status === 429) {
    console.log('OpenRouter 429, falling back to Groq')
    return await callGroqFallback(isTweet, content, env)
  }

  if (!orRes.ok) {
    const errBody = await orRes.text().catch(() => '(unreadable)')
    throw new Error(`OpenRouter ${orRes.status} — failing row. Body: ${errBody}`)
  }

  // OpenAI envelope: choices[0].message.content
  const data = await orRes.json() as { choices?: Array<{ message?: { content?: string } }> }
  const textContent = data?.choices?.[0]?.message?.content
  if (!textContent) throw new Error('OpenRouter: empty choices[0].message.content')

  // extractFirstJson handles markdown-wrapped JSON and trailing prose
  // JSON.parse failure throws → caught by processArticle catch → retry
  const parsed = JSON.parse(extractFirstJson(textContent)) as Record<string, unknown>
  return normalizeGemmaResponse(parsed)
}
```

---

## Step 6 — ingest-builders: Update `Env` interface

**File:** `workers/ingest-builders/src/index.ts`, lines 1–7

```typescript
// Before
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GROQ_API_KEY: string
  GOOGLE_AI_STUDIO_API_KEY: string
  PRODUCTHUNT_API_TOKEN?: string
}

// After
export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GROQ_API_KEY: string
  OPENROUTER_API_KEY: string
  OPENROUTER_BIO_MODEL: string   // separate from OPENROUTER_MODEL — bio is a cheaper task
  PRODUCTHUNT_API_TOKEN?: string
}
```

Two separate model secrets because bio extraction is simpler and can use a smaller/cheaper model than article summarization.

---

## Step 7 — ingest-builders: Update constants + add `extractFirstJson()`

**File:** `workers/ingest-builders/src/index.ts`, lines 73–74

Remove:
```typescript
const AI_STUDIO_BIO_MODEL = 'gemma-3-12b-it'
const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
```

Add:
```typescript
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions'
```

**Add `extractFirstJson()` verbatim** — copy from `process-queue/src/index.ts`. The two workers are separate Cloudflare bundles with no shared module system; duplication is required. The function is 15 lines with no dependencies.

```typescript
// Extracts the first complete JSON object from a string, ignoring surrounding prose/markdown.
// Required because response_format: json_object is best-effort — models wrap in ```json fences.
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
```

---

## Step 8 — ingest-builders: Replace `extractBioMap()` primary path

**File:** `workers/ingest-builders/src/index.ts`, lines 86–165

Replace **only the AI Studio primary block**. The Groq fallback (lines 169–214) is unchanged.

Critical behavioral preservation:
- AbortError (timeout): bio is non-critical → `return {}`, no Groq fallback. **Preserve.**
- 429: → Groq fallback. **Preserve.**
- Response parsing: AI Studio returned `{ bios: {...} }` due to `responseSchema`. OpenRouter returns flat JSON per prompt instruction. Handle both shapes defensively: `rawParsed.bios ?? rawParsed`.

```typescript
// --- OpenRouter primary ---
const controller = new AbortController()
const timeoutId = setTimeout(() => controller.abort(), 8000)
let useGroqFallback = false

try {
  let orRes: Response
  try {
    orRes = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://news-app.internal',
        'X-Title': 'NewsApp',
      },
      body: JSON.stringify({
        model: env.OPENROUTER_BIO_MODEL,
        messages: [
          { role: 'system', content: 'Respond with valid JSON only. No reasoning. No self-correction.\n\n' + BIO_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 600,
        temperature: 0,
      }),
      signal: controller.signal,
    })
  } catch (fetchErr: unknown) {
    clearTimeout(timeoutId)
    if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
      // Bio is non-critical — timeout fails gracefully, no Groq fallback
      console.error('OpenRouter bio extraction timeout — failing bio step')
      return {}
    }
    // TCP rejection → Groq fallback
    console.log('OpenRouter bio unreachable, falling back to Groq:', (fetchErr as Error).message)
    useGroqFallback = true
    orRes = undefined as unknown as Response
  }

  clearTimeout(timeoutId)

  if (!useGroqFallback) {
    if (orRes!.status === 429) {
      console.log('OpenRouter bio 429, falling back to Groq')
      useGroqFallback = true
    } else if (!orRes!.ok) {
      console.error(`OpenRouter bio ${orRes!.status} — failing bio step`)
      return {}
    } else {
      const data = await orRes!.json() as { choices?: Array<{ message?: { content?: string } }> }
      const text = data?.choices?.[0]?.message?.content
      if (!text) {
        console.error('OpenRouter bio: empty choices[0].message.content — failing bio step')
        return {}
      }
      try {
        // extractFirstJson: handles markdown-wrapped JSON (```json fences)
        // bios wrapper: defensive fallback for models that emit { bios: {...} } despite flat-object prompt
        const rawParsed = JSON.parse(extractFirstJson(text)) as Record<string, unknown>
        const flat = (rawParsed.bios && typeof rawParsed.bios === 'object')
          ? rawParsed.bios as Record<string, string>
          : rawParsed as Record<string, string>
        const result: Record<string, string> = {}
        for (const [k, v] of Object.entries(flat)) {
          const handle = k.startsWith('@') ? k.slice(1).toLowerCase() : k.toLowerCase()
          result[handle] = v
        }
        if (Object.keys(result).length > 0) return result
      } catch {
        console.error('OpenRouter bio: JSON parse failure — failing bio step')
        return {}
      }
    }
  }
} catch (err) {
  clearTimeout(timeoutId)
  console.error('OpenRouter bio extraction error:', (err as Error).message)
  return {}
}

if (!useGroqFallback) return {}
// --- Groq fallback (unchanged below) ---
```

---

## Step 9 — Update `keep-in-mind.md`

Add operational lesson:

> **The live AI model is not tracked in Git history.** `OPENROUTER_MODEL` and `OPENROUTER_BIO_MODEL` are Cloudflare Worker secrets — the active model in production is invisible to `git log`. Before debugging a summarization quality regression, always check the active model: run `wrangler secret list --name process-queue` (confirms the secret exists but not its value — check the OpenRouter dashboard request logs for the actual model string). If temporarily adding `console.log('Model:', env.OPENROUTER_MODEL)` to debug, remove it before committing.

---

## Step 10 — Update `docs/api-keys-and-env.md`

- Add `OPENROUTER_API_KEY` to the secrets table: `Yes (process-queue, ingest-builders)` in the Cloudflare column
- Add `OPENROUTER_MODEL` and `OPENROUTER_BIO_MODEL`: `Yes (process-queue and ingest-builders respectively)`
- Remove `GOOGLE_AI_STUDIO_API_KEY` row (after both workers confirmed working)
- Add `wrangler secret put` commands for all three new secrets under each worker's section
- Add OpenRouter to Cost Reference: `Free (free-tier models only — subject to rate limits)`

---

## Step 11 — Update `docs/architect-role.md`

Update the Fixed Stack table LLM row:

| Layer | Technology | Why Fixed |
|---|---|---|
| LLM inference (primary) | OpenRouter, model via `OPENROUTER_MODEL` secret | OpenAI-compatible; model flexibility without redeployment; free-tier models only |
| LLM inference (fallback) | Groq `llama-3.3-70b-versatile` | Speed + free tier; fallback for OpenRouter failures |

Add to Active Architectural Risks:

| Risk | Severity | Status |
|---|---|---|
| OpenRouter free-tier fallback spillover to Groq | High | Monitor for first 48h; fallback >10% → switch model |

---

## Step 12 — Set Cloudflare Worker Secrets + Deploy

```bash
# From workers/process-queue/:
wrangler secret put OPENROUTER_API_KEY
wrangler secret put OPENROUTER_MODEL        # paste: google/gemma-2-9b-it:free
wrangler deploy

# From workers/ingest-builders/:
wrangler secret put OPENROUTER_API_KEY
wrangler secret put OPENROUTER_BIO_MODEL    # paste: google/gemma-2-9b-it:free (or smaller)
wrangler deploy
```

**Do NOT delete `GOOGLE_AI_STUDIO_API_KEY`** until both workers are confirmed processing articles successfully in production.

---

## Fallback Rate Monitoring (First 48 Hours — Required)

Monitor via `wrangler tail --name process-queue`:

| Log message | Meaning | Action threshold |
|---|---|---|
| `OpenRouter Phase 1 timeout (8s) — no headers received` | TTFB > 8s, fell back to Groq | >5% of invocations → bump Phase 1 timeout to 10s |
| `OpenRouter 429, falling back to Groq` | OpenRouter rate-limited | >10% of invocations → switch to a different free model via secret update |
| Groq 429 error (inside `callGroqFallback`) | Both paths rate-limited | Emergency: rows stuck. Reset after midnight UTC |

**Wall-clock budget if timeout bumped to 10s:**
10s + ~10s Groq + ~2s DB write = 22s. Within 30s. Safe.
Do NOT exceed 12s — leaves only 8s for 5 parallel articles worst-case.

**Diagnosing stuck rows after double-failure:**
```sql
UPDATE raw_ingestion SET status = 'pending'
WHERE status = 'processing' AND processed_at IS NULL;
```

---

## Edge Cases Covered

| Edge Case | Handling |
|---|---|
| OpenRouter no headers within 8s (AbortError) | `callLLM`: Groq fallback. Bio: return {} (non-critical) |
| OpenRouter TCP rejection / unreachable | `callLLM`: Groq fallback. Bio: Groq fallback |
| OpenRouter 429 | `callLLM`: Groq fallback. Bio: Groq fallback |
| OpenRouter 5xx / other 4xx | `callLLM`: throw → retry_count++ → error after 3. Bio: return {} |
| Model wraps output in ` ```json ` fences | `extractFirstJson()` strips prose → finds first `{...}` — both workers |
| Model returns `{ bios: {...} }` wrapper | Bio: `rawParsed.bios ?? rawParsed` handles both flat and wrapped |
| OpenRouter returns empty `choices[0].message.content` | `callLLM`: throws. Bio: logs + return {} |
| `response_format: json_object` ignored by model | `extractFirstJson()` handles prose; no JSON found → throws → retry |
| OpenRouter returns empty `summary_en`/`summary_zh` | `normalizeGemmaResponse` → validation throw → retry (up to 3) |
| OpenRouter returns sentinel in JSON | `normalizeGemmaResponse` checks `parsed.sentinel` → handled |
| `OPENROUTER_MODEL` secret not set | `env.OPENROUTER_MODEL` is `undefined` → OpenRouter 400 → throw → row errors |
| Wall-clock: OpenRouter slow + Groq fallback | 8s + ~10s Groq + ~2s DB = ~20s. Within 30s |
| Parallel batch of 5, one straggler hits fallback | Worst case ~20s; others finish earlier. Total < 30s |
| Duplicate URL insert | `Prefer: resolution=ignore-duplicates` unchanged |
| arXiv skip-scrape path | Unchanged — content selection before `callLLM()` |
| `ingest-builders` subrequest count | One `fetch()` replaces one `fetch()` — net: 0 |

---

## Verification

```bash
# Trigger a test run
wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"

# Tail live logs to confirm model path
wrangler tail --name process-queue
```

```sql
-- Confirm rows processed in last 10 minutes
SELECT status, COUNT(*)
FROM raw_ingestion
WHERE updated_at > NOW() - INTERVAL '10 minutes'
GROUP BY status;

-- Confirm no empty summaries reached daily_news
SELECT COUNT(*) FROM daily_news
WHERE (summary_en = '' OR summary_zh = '' OR summary_en IS NULL OR summary_zh IS NULL)
AND created_at > NOW() - INTERVAL '10 minutes';

-- Fallback health check (first 48h)
SELECT status, last_error, COUNT(*)
FROM raw_ingestion
WHERE updated_at > NOW() - INTERVAL '24 hours'
GROUP BY status, last_error
ORDER BY count DESC;
```

**Model swap test (no redeployment required):**
```bash
wrangler secret put OPENROUTER_MODEL --name process-queue
# paste new model ID (e.g. qwen/qwen3-235b-a22b:free)
# Takes effect on next cron cycle automatically
```
