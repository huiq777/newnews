# Bilingual Trend Brief — Design Spec

**Date:** 2026-04-17  
**Status:** Approved, ready for implementation  
**Architecture:** Refined B2 (Server-Side Parallel)

---

## Problem

A trend brief is currently generated one language at a time. When the user toggles the language after generating EN, `TrendBriefCard` resets to `idle_ready` and shows the "Generate Trend Brief" button again — requiring a second tap and a second full Groq generation to produce ZH. This is wasteful (doubles Groq cost across two sessions) and creates a broken UX (users expect the brief to exist in both languages after one trigger).

---

## Goal

Generate both `synthesis_en` and `synthesis_zh` in a single Edge Function invocation. When the user toggles the language toggle, the card must display the cached secondary-language brief immediately — the "Generate" button must not appear.

---

## Architecture: Refined B2 (Server-Side Parallel)

The primary language requested by the mobile client is streamed via SSE exactly as today. The secondary language is generated server-to-server using a blocking (non-streaming) Groq call that starts simultaneously. Both are written to `trend_briefs` in a single atomic DB operation after both complete.

The frontend is entirely unaware that two languages were generated. It only receives the primary language stream. Language toggle fires a direct Supabase REST query (not the Edge Function) to surface the cached secondary synthesis.

**Why not two frontend requests (Approach A)?**  
The Edge Function catches `AbortError` and returns immediately, skipping the DB persist block. A mobile client "silently draining" a secondary SSE stream is unreliable — app backgrounding, screen lock, or navigation will abort the fetch before the DB write completes. Using the mobile client as a keepalive pipe for a server-side cache operation is an inversion of responsibility.

**Why not Edge Function self-invocation (Approach C)?**  
Sequential (secondary only starts after primary completes), uses a subrequest slot, and self-invocation is an anti-pattern without a proper queue.

---

## Token Budget

| Path | Tokens/trigger |
|---|---|
| Previous (one language at a time) | ~3,250 |
| After this change (both languages) | ~6,500 |

On-demand only — no automated pipeline impact. Groq TPD headroom on trend briefs is not a bottleneck (trend briefs are user-triggered, infrequent, and not part of the 266,890 token/day automated demand).

---

## Files Modified

| File | Change |
|---|---|
| `supabase/functions/generate-trend-brief/index.ts` | Parameterize prompt building; parallel Groq calls; atomic bilingual DB write; AbortError resilience |
| `news-app/components/TrendBriefCard.tsx` | Split `useEffect` by dependency type; add direct DB cache check on lang toggle |

---

## Edge Function Design

### 1. Parameterize Prompt Building

**Current state:** `systemPrompt`, `userPrompt`, and the `bulletLines` helper all close over `lang` from the outer scope. Building a second-language prompt requires this to be parameterized.

**Change:** Extract into `buildMessages(targetLang: 'en' | 'zh')` that returns the full `messages` array. Move the static system prompt strings to module-level constants `EN_SYSTEM_PROMPT` and `ZH_SYSTEM_PROMPT` (no content changes — extraction only). The `bulletLinesFor` helper inside `buildMessages` uses `targetLang` to select `summary_en` vs `summary_zh`.

### 2. Parallel Groq Calls — Parallel Start, Sequential Await

Start both Groq fetch calls without awaiting either, then proceed to process the primary stream:

```typescript
const secondaryLang: 'en' | 'zh' = resolvedLang === 'en' ? 'zh' : 'en'
const secondarySynthesisField = secondaryLang === 'zh' ? 'synthesis_zh' : 'synthesis_en'

// Secondary: server-to-server, blocking JSON. No req.signal.
const secondaryPromise = fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: groqHeaders,
  body: JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    stream: false,
    temperature: 0.7,
    max_tokens: 1024,
    messages: buildMessages(secondaryLang),
  }),
})

// Primary: streaming, tied to req.signal (mobile disconnect cancels this, not the secondary)
groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  signal: req.signal,
  headers: groqHeaders,
  body: JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    max_tokens: 1024,
    messages: buildMessages(resolvedLang),
  }),
})
```

**Critical constraint:** `secondaryPromise` must NOT carry `req.signal`. The mobile disconnect signal must not cancel the server-to-server Groq call.

### 3. `resolveSecondary` Helper

```typescript
async function resolveSecondary(p: Promise<Response>): Promise<string | null> {
  try {
    const res = await Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('secondary_timeout')), 25_000)
      ),
    ])
    if (!res.ok) return null
    const json = await res.json()
    return (json.choices?.[0]?.message?.content as string) ?? null
  } catch {
    return null
  }
}
```

Returns `null` on timeout, non-200, or JSON parse failure. Callers treat `null` as "skip this column" — do not write a null over an existing value.

### 4. Atomic DB Write — Normal Completion Path

After the primary stream finishes and `synthesisAccum` is complete:

```typescript
const secondaryText = await resolveSecondary(secondaryPromise)

const writePayload = {
  [synthesisField]: synthesisAccum,
  ...(secondaryText !== null ? { [secondarySynthesisField]: secondaryText } : {}),
  sources_json: sourcesJson,
  model: 'llama-3.3-70b-versatile',
  tokens_used: tokensUsed,
  expires_at: expiresAt,
}

// PATCH first (updates existing row, leaves other fields intact)
const patchRes = await fetch(
  `${SUPABASE_URL}/rest/v1/trend_briefs?anchor_date=eq.${anchor_date}&step_days=eq.${step_days}`,
  { method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=minimal,count=exact' }, body: JSON.stringify(writePayload) }
)
const updatedCount = parseInt(patchRes.headers.get('content-range')?.split('/')[1] ?? '0')

// INSERT if no row exists
if (updatedCount === 0) {
  await fetch(`${SUPABASE_URL}/rest/v1/trend_briefs`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      anchor_date, step_days, date_range: dateRangeLabel,
      synthesis_en: resolvedLang === 'en' ? synthesisAccum : (secondaryText ?? null),
      synthesis_zh: resolvedLang === 'zh' ? synthesisAccum : (secondaryText ?? null),
      sources_json: sourcesJson,
      model: 'llama-3.3-70b-versatile',
      tokens_used: tokensUsed,
      expires_at: expiresAt,
    }),
  })
}
console.log(JSON.stringify({
  event: 'brief_generated', lang: resolvedLang,
  secondary_lang: secondaryLang, secondary_ok: secondaryText !== null,
  duration_ms: Date.now() - startMs, tokens_used: tokensUsed,
  source_count: selected.length, historical_count: historical.length,
  anchor_date, step_days,
}))
```

### 5. AbortError Path — Resilient Secondary Write

When the mobile client disconnects mid-stream, `synthesisAccum` is truncated. The DB must never persist a truncated synthesis. The secondary (server-to-server) is unaffected by the mobile disconnect and can still complete.

```typescript
} catch (err: unknown) {
  if (err instanceof Error && err.name === 'AbortError') {
    console.log(JSON.stringify({
      event: 'client_disconnected',
      duration_ms: Date.now() - startMs,
      chars_streamed: charsStreamed,
      anchor_date, step_days,
    }))

    // Truncated primary — do NOT write synthesisField.
    // Await secondary with 25s timeout and write only if complete.
    const secondaryText = await resolveSecondary(secondaryPromise)
    if (secondaryText) {
      const isPast = anchor_date < new Date().toISOString().slice(0, 10)
      const expiresAt = isPast
        ? '9999-12-31T00:00:00.000Z'
        : new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()

      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/trend_briefs?anchor_date=eq.${anchor_date}&step_days=eq.${step_days}`,
        {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Prefer': 'return=minimal,count=exact' },
          body: JSON.stringify({
            [secondarySynthesisField]: secondaryText,
            sources_json: sourcesJson,
            model: 'llama-3.3-70b-versatile',
            expires_at: expiresAt,
          }),
        }
      )
      const updatedCount = parseInt(patchRes.headers.get('content-range')?.split('/')[1] ?? '0')
      if (updatedCount === 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/trend_briefs`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({
            anchor_date, step_days,
            synthesis_en: secondaryLang === 'en' ? secondaryText : null,
            synthesis_zh: secondaryLang === 'zh' ? secondaryText : null,
            sources_json: sourcesJson,
            model: 'llama-3.3-70b-versatile',
            expires_at: expiresAt,
          }),
        })
      }
      console.log(JSON.stringify({ event: 'abort_secondary_saved', secondary_lang: secondaryLang, anchor_date, step_days }))
    } else {
      console.log(JSON.stringify({ event: 'abort_secondary_lost', anchor_date, step_days }))
    }

    controller.close()
    return
  }
  throw err
}
```

---

## Frontend Design (`TrendBriefCard.tsx`)

### Problem with Current `useEffect`

The single `useEffect` on `[dateRange, stepDays, lang, hasArticles]` resets all state to `idle_ready` on any dependency change — including lang toggle. This causes the Generate button to reappear after language switch.

### Fix: Split into Two Effects

**Effect A — Window/articles change (full reset):**  
Fires when `dateRange`, `stepDays`, or `hasArticles` changes. Resets all brief state to `idle_ready`. Behavior is identical to current.

```typescript
useEffect(() => {
  abortRef.current?.abort()
  if (!hasArticles || !dateRange) {
    setBriefState('idle')
    return
  }
  setBriefState('idle_ready')
  setSynthesis('')
  setSourcesJson([])
  setGeneratedAt(null)
  setSourcesExpanded(false)
  return () => { abortRef.current?.abort() }
}, [dateRange, stepDays, hasArticles]) // eslint-disable-line react-hooks/exhaustive-deps
```

**Effect B — Language toggle (direct DB cache check):**  
Fires only when `lang` changes. Guards against running when no brief exists for the current window (`idle` or `idle_ready` states). Queries `trend_briefs` directly via Supabase REST — no Edge Function, no token logic, no generation surface.

```typescript
useEffect(() => {
  // Guard: only intercept when a brief is already in progress or loaded
  if (briefState === 'idle' || briefState === 'idle_ready' || !dateRange || !hasArticles) return

  const anchor = new Date(dateRange.end)
  anchor.setDate(anchor.getDate() - 1)
  const anchorDate = anchor.toISOString().slice(0, 10)
  const ctrl = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/trend_briefs` +
        `?anchor_date=eq.${anchorDate}` +
        `&step_days=eq.${stepDays}` +
        `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
        `&select=synthesis_en,synthesis_zh,sources_json,generated_at` +
        `&order=generated_at.desc&limit=1`,
        {
          signal: ctrl.signal,
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        }
      )
      if (!res.ok) { setBriefState('idle_ready'); return }

      const rows: TrendBriefRow[] = await res.json()
      const row = rows[0]
      const synthesis = row?.[lang === 'en' ? 'synthesis_en' : 'synthesis_zh'] ?? null

      if (synthesis) {
        setSynthesis(synthesis)
        setSourcesJson(row.sources_json ?? [])
        setGeneratedAt(row.generated_at)
        setBriefState('loaded')
      } else {
        setSynthesis('')
        setSourcesJson([])
        setGeneratedAt(null)
        setBriefState('idle_ready')
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      setBriefState('idle_ready')
    }
  })()

  return () => ctrl.abort()
}, [lang]) // eslint-disable-line react-hooks/exhaustive-deps
```

**Why direct DB and not through the Edge Function?**  
The Edge Function runs `deduct_tokens` before the cache check. A pure cache-read for language toggle would incorrectly trip token reservation+refund logic and add Edge Function cold-start latency. `trend_briefs` is anon-readable (RLS: `public_read_trend_briefs`). A direct REST query is the correct seam.

### Data Shape Adapter

The Edge Function returns SSE chunks during generation. The direct DB query returns a flat row. Effect B maps the DB row to component state directly:

```typescript
type TrendBriefRow = {
  synthesis_en: string | null
  synthesis_zh: string | null
  sources_json: BriefSource[]
  generated_at: string
}
```

`synthesis` ← `row[lang === 'en' ? 'synthesis_en' : 'synthesis_zh']`  
`sourcesJson` ← `row.sources_json`  
`generatedAt` ← `row.generated_at`

### Guard Logic — Effect Interaction

When the window changes (Effect A fires), state resets to `idle_ready`. Effect B's guard (`briefState === 'idle_ready'`) prevents it from running until the user generates a brief. Once generation completes and state transitions to `loaded`, lang toggles are intercepted by Effect B. The two effects are mutually non-interfering.

---

## Verification Checklist

1. **Normal EN-primary generation:**
   - Click Generate (EN) → streaming text appears
   - Check `trend_briefs` table: both `synthesis_en` and `synthesis_zh` populated
   - Toggle to ZH → ZH brief appears immediately, no Generate button

2. **Normal ZH-primary generation:**
   - Switch to ZH, click Generate → streaming ZH text
   - Toggle to EN → EN brief appears, no Generate button

3. **Back-and-forth toggle:**
   - EN → ZH → EN → ZH — all transitions show `loaded` state

4. **AbortError path:**
   - Kill network mid-stream
   - DB: primary field is `null`, secondary field is populated
   - Log: `event: abort_secondary_saved`

5. **Secondary timeout path:**
   - DB: primary field written (normal completion), secondary `null`
   - Log: `event: abort_secondary_lost` (only reachable if secondary Groq hangs >25s)

6. **Window change:**
   - Change date window → card resets to `idle_ready`, Generate button appears
   - Confirms Effect A (full reset) fires and Effect B guard does nothing

7. **Token budget:**
   - Log `tokens_used` reflects primary language only
   - Log `secondary_ok: true` confirms secondary completed
