# Design Spec: Trend Brief UX Redesign

## Problem

Three UX gaps in `TrendBriefCard`:
1. The button always says "Generate Trend Brief" even when a brief already exists in Supabase — the user triggers a wasteful LLM generation when they only want to read a cached result
2. No feedback on how long generation is taking — the skeleton shows static text with no progress signal
3. When a brief is loaded for one language, switching to the other language reverts the card to the generate button and requires a second click, even when the other language is already cached

---

## Change 1: New `idle_cached` State

**File**: `news-app/lib/config.ts` — line 55

```ts
// Before
export type BriefState = 'idle' | 'idle_ready' | 'loading' | 'streaming' | 'loaded' | 'error' | 'rate_limited'

// After
export type BriefState = 'idle' | 'idle_ready' | 'idle_cached' | 'loading' | 'streaming' | 'loaded' | 'error' | 'rate_limited'
```

`idle_cached` = a brief row exists in DB for the current window; user has not revealed it yet.

---

## Change 2: Effect A — Lightweight Existence Check on Window Change

**File**: `news-app/components/TrendBriefCard.tsx` — Effect A

Replace the synchronous `setBriefState('idle_ready')` with an async DB check. Query only `id` — do **not** download synthesis columns here. The full text is fetched in `showCached()` only when the user acts; downloading and discarding it on every window change wastes egress bandwidth.

```ts
useEffect(() => {
  abortRef.current?.abort()
  if (!hasArticles || !dateRange) {
    setBriefState('idle')
    return
  }
  setSynthesis('')
  setSourcesJson([])
  setGeneratedAt(null)
  setSourcesExpanded(false)
  setCachedRow(null)

  const ctrl = new AbortController()
  abortRef.current = ctrl

  const anchor = new Date(dateRange.end)
  anchor.setDate(anchor.getDate() - 1)
  const anchorDate = anchor.toISOString().slice(0, 10)

  ;(async () => {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/trend_briefs` +
        `?anchor_date=eq.${anchorDate}` +
        `&step_days=eq.${stepDays}` +
        `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
        `&select=id&limit=1`,
        { signal: ctrl.signal, headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      )
      if (ctrl.signal.aborted) return
      if (res.ok) {
        const rows = await res.json()
        setBriefState(rows.length > 0 ? 'idle_cached' : 'idle_ready')
      } else {
        setBriefState('idle_ready')
      }
    } catch {
      if (!ctrl.signal.aborted) setBriefState('idle_ready')
    }
  })()

  return () => { ctrl.abort() }
}, [dateRange, stepDays, hasArticles])
```

`lang` is NOT a dependency — language switches are handled by Effect B.

---

## Change 3: In-Memory Bilingual Row Cache

**File**: `TrendBriefCard.tsx` — state declarations

Store the full bilingual DB row in memory after the first load. Effect B reads from this cache instead of making a network round-trip on every language toggle.

```ts
type CachedBriefRow = {
  synthesis_en: string | null
  synthesis_zh: string | null
  sources_json: BriefSource[]
  generated_at: string
}
const [cachedRow, setCachedRow] = useState<CachedBriefRow | null>(null)
```

Reset alongside other state in Effect A: `setCachedRow(null)`

---

## Change 4: `showCached()` — Fetch Full Row Once, Cache in Memory

**File**: `TrendBriefCard.tsx`

Loads the bilingual row, stores it in `cachedRow`, and sets the active language. Subsequent language switches read from memory.

```ts
async function showCached() {
  if (!dateRange) return
  abortRef.current?.abort()
  const ctrl = new AbortController()
  abortRef.current = ctrl

  setBriefState('loading')
  setSynthesis('')
  setSourcesJson([])
  setGeneratedAt(null)

  const anchor = new Date(dateRange.end)
  anchor.setDate(anchor.getDate() - 1)
  const anchorDate = anchor.toISOString().slice(0, 10)

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/trend_briefs` +
      `?anchor_date=eq.${anchorDate}` +
      `&step_days=eq.${stepDays}` +
      `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
      `&select=synthesis_en,synthesis_zh,sources_json,generated_at` +
      `&order=generated_at.desc&limit=1`,
      { signal: ctrl.signal, headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    )
    if (!res.ok) { setBriefState('idle_ready'); return }
    const rows = await res.json()
    const row = rows[0]
    const synthesis = row?.[lang === 'en' ? 'synthesis_en' : 'synthesis_zh'] ?? null
    if (synthesis) {
      setCachedRow(row)
      setSynthesis(synthesis)
      setSourcesJson(row.sources_json ?? [])
      setGeneratedAt(row.generated_at)
      setBriefState('loaded')
    } else {
      setBriefState('idle_ready')
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    setBriefState('idle_ready')
  }
}
```

---

## Change 5: `generate()` — Store Result in `cachedRow`

**File**: `TrendBriefCard.tsx` — inside `generate()`, after stream completes and `synthesisAccum` is finalized

```ts
setCachedRow({
  synthesis_en: resolvedLang === 'en' ? synthesisAccum : (secondaryText ?? null),
  synthesis_zh: resolvedLang === 'zh' ? synthesisAccum : (secondaryText ?? null),
  sources_json: sourcesJson,
  generated_at: new Date().toISOString(),
})
```

---

## Change 6: Effect B — Memory-First Language Switch

**File**: `TrendBriefCard.tsx` — Effect B

Add `idle_cached` to the early-exit guard. If `cachedRow` is populated, serve from memory and skip the network call. Fall through to the existing DB query only if memory cache is absent.

```ts
useEffect(() => {
  if (
    briefState === 'idle' || briefState === 'idle_ready' || briefState === 'idle_cached' ||
    !dateRange || !hasArticles
  ) return

  // Fast path: serve from in-memory cache — zero network I/O
  if (cachedRow) {
    const synthesis = cachedRow[lang === 'en' ? 'synthesis_en' : 'synthesis_zh'] ?? null
    if (synthesis) {
      setSynthesis(synthesis)
      setSourcesJson(cachedRow.sources_json ?? [])
      setGeneratedAt(cachedRow.generated_at)
      setBriefState('loaded')
    } else {
      setSynthesis('')
      setGeneratedAt(null)
      setBriefState('idle_ready')
    }
    return
  }

  // Slow path: existing Effect B DB query logic (unchanged)
  ...
}, [lang])
```

`cardExpanded` and `sourcesExpanded` are not touched by Effect B — they survive language switches automatically.

---

## Change 7: Timer — Monotonic Clock via Ref

**File**: `TrendBriefCard.tsx`

Do **not** use `[briefState]` as the sole timer dependency. When `briefState` transitions from `loading` to `streaming`, the effect unmounts and remounts, resetting `elapsedSeconds` to 0 mid-generation. Store the start timestamp in a ref so the clock is monotonic across the transition.

```ts
const [elapsedSeconds, setElapsedSeconds] = useState(0)
const startTimeRef = useRef<number>(0)

useEffect(() => {
  if (briefState === 'loading') {
    startTimeRef.current = Date.now()
    setElapsedSeconds(0)
  }
  if (briefState !== 'loading' && briefState !== 'streaming') return
  const interval = setInterval(() => {
    setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000))
  }, 1000)
  return () => clearInterval(interval)
}, [briefState])
```

Skeleton display:
```tsx
{briefState === 'loading' && synthesis.length === 0 && (
  <View style={styles.briefSkeleton}>
    <Text style={styles.briefSkeletonText}>
      {lang === 'en'
        ? `Synthesizing ${windowLabel}… (${elapsedSeconds}s)`
        : `正在分析 ${windowLabel}… (${elapsedSeconds}s)`}
    </Text>
  </View>
)}
```

---

## Change 8: Auto-Generate Time Label in Header

**File**: `TrendBriefCard.tsx`

Add a subtitle line beneath `TREND BRIEF · MM DD`. pg_cron fires at `00:00 UTC`. Use `toLocaleTimeString` — **not** manual offset arithmetic — to handle fractional timezone offsets (India UTC+5:30 → `5:30 am`, Nepal UTC+5:45 → `5:45 am`).

```ts
function cronTimeLabel(lang: 'en' | 'zh'): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)  // actual pg_cron schedule: 00:00 UTC
  const localTimeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  return lang === 'en'
    ? `auto generate daily ${localTimeStr} @ your timezone`
    : `每日自动生成 ${localTimeStr} @ 您的时区`
}
```

Header render (applies to all states including `idle_cached` and `idle_ready`):
```tsx
<View style={styles.briefHeader}>
  <View style={{ flex: 1 }}>
    <Text style={styles.briefHeaderText}>{headerLabel}</Text>
    <Text style={styles.briefCronLabel}>{cronTimeLabel(lang)}</Text>
  </View>
  {/* chevron / age / refresh */}
</View>
```

New style:
```ts
briefCronLabel: {
  fontSize: 10, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif',
  letterSpacing: 0.5, marginTop: 2,
},
```

---

## Change 9: `idle_cached` Render Block

**File**: `TrendBriefCard.tsx` — insert before the `idle_ready` return

```tsx
if (briefState === 'idle_cached') {
  return (
    <View style={styles.briefCard}>
      <View style={styles.briefHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.briefHeaderText}>{headerLabel}</Text>
          <Text style={styles.briefCronLabel}>{cronTimeLabel(lang)}</Text>
        </View>
      </View>
      <Pressable
        style={[styles.generateBtn, generateHovered && styles.generateBtnHovered]}
        onPress={() => showCached()}
        onHoverIn={() => setGenerateHovered(true)}
        onHoverOut={() => setGenerateHovered(false)}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <WebHTML html={BRIEF_ICON_SVG} />
          <Text style={styles.generateBtnText}>
            {lang === 'en' ? 'Show Trend Brief' : '查看趋势简报'}
          </Text>
        </View>
      </Pressable>
    </View>
  )
}
```

Also add `cronTimeLabel` to the existing `idle_ready` render block for consistency.

---

## Files Changed

- `news-app/lib/config.ts` — add `'idle_cached'` to `BriefState`
- `news-app/components/TrendBriefCard.tsx`:
  - `cachedRow` state (+ `CachedBriefRow` type)
  - `startTimeRef` ref
  - `elapsedSeconds` state
  - Effect A: lightweight `select=id` existence check
  - Effect B: `idle_cached` early-exit + memory-first fast path
  - `showCached()` function
  - `generate()`: store `cachedRow` on stream completion
  - `cronTimeLabel()` helper
  - `idle_cached` render block
  - Timer in skeleton
  - Cron label in both `idle_cached` and `idle_ready` headers
  - New `briefCronLabel` style

---

## Verification

1. Navigate to a date with an existing brief → button reads "Show Trend Brief" / "查看趋势简报"
2. Click it → brief loads instantly (no streaming, no LLM call)
3. Switch language → zero-network instant switch from `cachedRow`, card/source expand state preserved
4. Navigate to a date with no brief → button reads "Generate Trend Brief" / "生成趋势简报"
5. Click generate → timer starts at 0s, increments without resetting at the `loading→streaming` transition
6. Header subtitle on India locale (UTC+5:30) → shows `5:30 am`, not a float like `5.5am`
