# Follow-up Spec: Two-Phase Timeout + String-Aware JSON Extractor

**Date:** 2026-04-15
**Status:** Design only — no implementation
**Parent spec:** `2026-04-15-gemma-multi-model-design.md`
**Preceded by:** `2026-04-15-gemma-schema-flatten.md`

---

## Context

After the schema flatten fix resolved the 400 errors, two new failure modes surfaced from live testing:

- **3/4 requests timed out** at the 8-second AbortController
- **1/4 requests** hit `Unexpected non-whitespace character after JSON at position 254`

Empirical latency data collected: Gemma 4 31B on Google AI Studio free tier reports **1.59s TTFT, 27 tps throughput**.

This data reframes both root causes precisely.

---

## Fix 1 — Two-Phase Timeout

### Root Cause

The 8-second AbortController fires during body streaming, not during connection establishment. At 27 tps and ~510 output tokens, full body receipt takes:

```
1.59s (TTFT) + (510 tokens / 27 tps) = 1.59 + 18.9 ≈ 20.5s total
```

The AbortController fires at second 8 — approximately 6 seconds into body streaming. The model is healthy and producing output; the timeout is killing valid in-progress responses.

### Why a Simple Threshold Raise Doesn't Work

Raising the AbortController to 22 seconds leaves:
```
30s wall-clock − 22s AI Studio timeout − ~5s Groq fallback = 3s safety margin
```
3 seconds is insufficient margin before the Cloudflare Worker is forcefully killed, orphaning the row.

### The Correct Reframe

The AbortController is solving the wrong problem. The timeout should guard against *"is AI Studio reachable and responding?"* — not *"how long does generation take?"*.

Once a 200 OK status header is received, the health check has passed. Generation time at 27 tps is predictable and fits the wall-clock budget without assistance from the AbortController.

### Two-Phase Design

**Phase 1 — Connection timeout (5s):**
Start an AbortController with a 5-second timeout. This covers:
- AI Studio unreachable (TCP failure → triggers Groq fallback)
- AI Studio rate-limiting before headers (429 → triggers Groq fallback)
- AI Studio unresponsive / no headers within 5s → throw, fail the row

**Phase 2 — Clear on 200:**
Once `aiRes.status === 200` is confirmed, call `clearTimeout()` on the AbortController timer. The body read (`aiRes.json()`) proceeds with no timeout. Generation completes in ~20s.

**Budget verification:**

| Scenario | Timing | Outcome |
|---|---|---|
| AI Studio 200, body reads fully | 1.59s + 20s body + 2s Supabase write = ~24s | ✅ Within 30s wall-clock |
| AI Studio 429 (fast, ~1.59s) → Groq (~10s) + Supabase (2s) | ~14s total | ✅ Comfortable |
| AI Studio no headers (5s timeout) → fail row | 5s | ✅ Queue retries next pass |

**Why 5s, not 8s for Phase 1:**
The TTFT is 1.59s. A 5-second connection timeout is 3× the observed TTFT — sufficient buffer for variance without burning wall-clock time on a genuinely unresponsive endpoint.

### Implementation Sketch

```typescript
async function callLLM(isTweet: boolean, content: string, env: Env): Promise<LLMResult> {
  const controller = new AbortController()
  // Phase 1: 5s to receive response HEADERS (TTFT = 1.59s, 5s = 3x buffer)
  const connectionTimeoutId = setTimeout(() => controller.abort(), 5000)

  let aiRes: Response
  try {
    aiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (fetchErr) {
    clearTimeout(connectionTimeoutId)
    if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
      // No headers within 5s — service unresponsive, fail the row
      throw new Error('AI Studio connection timeout (5s) — failing row')
    }
    // TCP rejection — fast failure → Groq fallback
    return await callGroqFallback(isTweet, content, env)
  }

  // Phase 2: headers received — clear the connection timeout
  // Body receipt (~20s at 27 tps) proceeds freely within wall-clock budget
  clearTimeout(connectionTimeoutId)

  if (aiRes.status === 429) {
    return await callGroqFallback(isTweet, content, env)
  }
  if (!aiRes.ok) {
    const errBody = await aiRes.text().catch(() => '(unreadable)')
    throw new Error(`AI Studio ${aiRes.status} — failing row. Body: ${errBody}`)
  }

  // Body read: unconstrained — predictable at ~20s
  const rawJson = await aiRes.json()
  ...
}
```

---

## Fix 2 — String-Aware JSON Extractor

### Root Cause

Despite `responseMimeType: 'application/json'`, Gemma 4 31B appended trailing explanatory prose after closing the JSON object on some responses:

```
{"sentinel": "NOT_AI_RELEVANT"}
This tweet does not appear to be primarily about AI...
```

`JSON.parse()` fails at the newline after the closing `}`. The fix is to extract the first complete JSON object from the string before parsing.

### The Naive Bracket Counter Is Broken

A depth-counting algorithm that only tracks `{` and `}` fails when the model generates braces inside string literals — which is common in developer-focused news:

```json
{
  "title_en": "React's use of { children } props",
  "summary_en": "..."
}
```

The naive counter increments depth on the `{` inside `"React's use of { children } props"`, treating it as a nested object opener. The matching `}` decrements depth — and the real closing `}` of the JSON object may then fail to terminate the loop correctly.

Depending on the content, this produces either:
- **Premature termination** — returns a truncated invalid JSON string
- **`throw 'Unterminated JSON object'`** — valid JSON rejected

Both are silent quality regressions: a tweet about React, Rust closures, or any content with literal `{}`  in its title would fail parsing every time.

### Corrected Implementation: String-Aware, Escape-Aware State Machine

The extractor must track three states: normal, inside-string, and escape-next-char.

```typescript
function extractFirstJson(text: string): string {
  const start = text.indexOf('{')
  if (start === -1) throw new Error('No JSON object found in response')

  let depth = 0
  let inString = false
  let isEscaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]

    // An escaped character: skip it, clear escape flag
    if (isEscaped) {
      isEscaped = false
      continue
    }

    // Backslash inside a string: next character is escaped
    if (char === '\\') {
      isEscaped = true
      continue
    }

    // Unescaped quote: toggle string boundary
    if (char === '"') {
      inString = !inString
      continue
    }

    // Only count braces outside string literals
    if (!inString) {
      if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
  }

  throw new Error('Unterminated JSON object in response')
}
```

**Why each state matters:**

| State | What it handles |
|---|---|
| `isEscaped` | `\"` inside a string — prevents the `"` from toggling `inString` |
| `inString` | Any `{` or `}` inside a quoted value — prevents depth miscounting |
| `!inString` brace check | Counts only structural braces — correct JSON boundary detection |

**Usage:** Replace `JSON.parse(textContent)` with `JSON.parse(extractFirstJson(textContent))` in `callLLM`.

---

## Files Changed

Both changes are isolated to `workers/process-queue/src/index.ts`:

| Change | Location in file |
|---|---|
| Replace single AbortController with two-phase timeout | `callLLM` function |
| Add `extractFirstJson` helper | New function, above `callLLM` |
| Replace `JSON.parse(textContent)` | Inside `callLLM`, after `parseAIStudioResponse` |

No changes to: prompts, `responseSchema`, `normalizeGemmaResponse`, Groq fallback path, any other worker, any Edge Function.

---

## Verification Plan

1. **Timeout fix — normal path:** Process 5 tweets. Confirm no timeouts. Confirm `last_error` is not set. Confirm responses arrive in ~22s.

2. **Timeout fix — connection failure path:** Set `GOOGLE_AI_STUDIO_API_KEY` to an invalid value. Confirm 401 is returned quickly, Groq fallback fires, rows process successfully.

3. **Timeout fix — no-header path:** Simulate by pointing `AI_STUDIO_BASE` at a non-responding host. Confirm `AbortError` fires at ~5s, row lands in `error` with `last_error = 'AI Studio connection timeout (5s)'`.

4. **JSON extractor — trailing prose:** Mock `parseAIStudioResponse` to return `{"sentinel": "NOT_AI_RELEVANT"}\nThis tweet is not AI-related.`. Confirm `extractFirstJson` returns only the JSON object and `JSON.parse` succeeds.

5. **JSON extractor — braces in string literals:** Mock response with `{"title_en": "React { children } pattern explained", ...}`. Confirm `extractFirstJson` returns the complete object without premature termination or error.

6. **JSON extractor — valid clean JSON (no trailing text):** Confirm the extractor returns the full object unchanged when there is no trailing prose.
