# App.tsx Split — Design Spec

## Context

`App.tsx` is a 1436-line monolith containing 7 components, all shared types, all styles, and all data-fetching logic. Splitting it improves navigability, reduces TypeScript compile time, and isolates components for future changes.

---

## Target Structure

```
news-app/
├── App.tsx                          ← shell only (~280 lines)
├── lib/
│   └── config.ts                    ← all shared types, constants, helpers
└── components/
    ├── MarkdownText.tsx             ← pure, no deps
    ├── WebHTML.tsx                  ← pure, no deps
    ├── FilterTag.tsx                ← pure, no deps
    ├── NavBar.tsx                   ← imports Category from lib/config
    ├── DrumWheelSidebar.tsx         ← no lib/config deps
    ├── ArticleCard.tsx              ← imports Article, AnswerState, utils from lib/config; MarkdownText, WebHTML
    └── TrendBriefCard.tsx           ← imports BriefSource, BriefState, SUPABASE_URL/KEY from lib/config
```

---

## Dependency Graph

```
lib/config.ts  (root — zero internal imports)
    ↑
    ├── NavBar.tsx          (Category)
    ├── ArticleCard.tsx     (Article, AnswerState, SUPABASE_URL, SUPABASE_ANON_KEY, FIRE_SVG, formatPublishedDate, fmtNum)
    │       ├── MarkdownText.tsx
    │       └── WebHTML.tsx
    ├── TrendBriefCard.tsx  (BriefSource, BriefState, SUPABASE_URL, SUPABASE_ANON_KEY)
    └── App.tsx             (supabase, FEED_PAGE_SIZE, Article, Category)
```

No circular imports. `lib/config.ts` has zero internal imports — it is the root of the dependency graph.

---

## File Specs

### `lib/config.ts`

**Exports:**
- `supabase` — `createClient(...)` instance (used by App.tsx for Supabase JS queries)
- `SUPABASE_URL` — raw string (used by ArticleCard, TrendBriefCard for raw `fetch` streaming calls)
- `SUPABASE_ANON_KEY` — raw string (same consumers)
- `FEED_PAGE_SIZE` — number constant
- `FIRE_SVG` — SVG string (fire icon used by ArticleCard)

**Types:**
- `AnswerState` — `{ thinking, content, thinkingDone, streaming }`
- `Article` — full daily_news row shape
- `Category` — `'all' | 'industry' | 'technical_frontier' | 'career_community'`
- `BriefSource` — `{ index, id, title, url, published_at, is_historical }`
- `BriefState` — `'idle' | 'loading' | 'streaming' | 'loaded' | 'error' | 'rate_limited'`

**Helpers:**
- `formatPublishedDate(dateStr, lang)` — formats ISO date as "Mon DD" (en) or "M月DD日" (zh)
- `fmtNum(n)` — formats numbers: 1000+ → "1.0K"

**Note:** `EXPO_PUBLIC_*` env vars must remain as direct `process.env.EXPO_PUBLIC_*` references — Expo replaces them statically at build time.

---

### `components/MarkdownText.tsx`

Source: lines 18–40 of App.tsx verbatim.

- Exports default `MarkdownText`
- Props: `{ text: string; style?: object }`
- Pure functional, no StyleSheet (defers to `style` prop)
- No internal imports

---

### `components/WebHTML.tsx`

Source: lines 84–92 of App.tsx verbatim.

- Exports default `WebHTML`
- Props: `{ html: string; style?: object }`
- Preserve `ref.current as unknown as HTMLElement` cast — react-native-web renders View as div but types don't expose DOM APIs
- No internal imports

---

### `components/FilterTag.tsx`

Source: lines 539–549 + `filterTagRow`, `filterTag`, `filterTagText` styles.

- Exports default `FilterTag`
- Props: `{ label: string; onClear: () => void }`
- No internal imports

---

### `components/NavBar.tsx`

Source: lines 97–182 + all `nav*` styles.

- Exports default `NavBar`
- Props: `{ lang: 'en' | 'zh'; activeCategory: Category; onLangChange: (l: 'en' | 'zh') => void; onCategoryChange: (cat: Category) => void }`
- Imports: `{ Category } from '../lib/config'`
- Preserve `position: 'fixed' as any` cast on nav style

---

### `components/DrumWheelSidebar.tsx`

Source: lines 185–536 + `aside`, `tfRow`, `tfBtn*`, `wheelContainer` styles.

- Exports default `DrumWheelSidebar`
- Props: `{ lang: 'en' | 'zh'; onFilterChange: (start: Date, end: Date, label: string, stepDays: number) => void; onMountedControls: (controls: { resetToToday: () => void }) => void }`
- No lib/config imports
- **Critical:** `handleTfRef.current = handleTf` inside effect body breaks stale closure — preserve exactly
- `onMountedControls` fires inside the `useEffect` to register the imperative handle — preserve
- The `[lang]` useEffect dependency triggers full DOM wheel rebuild — intentional, `diffLabel` closes over `lang`

---

### `components/ArticleCard.tsx`

Source: lines 553–803 + all `card*`, `title`, `summary`, `engagement*`, `questions*`, `answer*`, `thinking*`, `content*` styles.

- Exports default `ArticleCard`
- Props: `{ item: Article; lang: 'en' | 'zh'; sourceMap: Record<string, string>; bioMap: Record<string, string> }`
- Imports: `{ Article, AnswerState, SUPABASE_URL, SUPABASE_ANON_KEY, FIRE_SVG, formatPublishedDate, fmtNum } from '../lib/config'`
- Imports: `MarkdownText from './MarkdownText'`, `WebHTML from './WebHTML'`
- **Preserve:** `innerPressed.current = true` set before any state update in inner button handlers (prevents outer Pressable onPress from firing)
- **Preserve:** incomplete-line buffer pattern in `handleAsk` SSE loop (`lines.pop() ?? ''`)
- **Preserve:** `useEffect(() => { setAnswers({}) }, [lang])` — resets Q&A on language change

---

### `components/TrendBriefCard.tsx`

Source: lines 809–1018 + all `brief*` styles.

- Exports default `TrendBriefCard`
- Props: `{ lang: 'en' | 'zh'; category: string; dateRange: { start: Date; end: Date } | null; stepDays: number; hasArticles: boolean }`
- Imports: `{ BriefSource, BriefState, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/config'`
- **Preserve:** `abortRef.current?.abort()` at top of `generate()` — cancels in-flight requests on dep change
- **Preserve:** `return () => { abortRef.current?.abort() }` in useEffect cleanup — cancels on unmount
- `fmtAge` and `fmtDateShort` close over `lang` — stay as local functions, not moved to lib/config

---

### `App.tsx` (rewritten shell)

Keeps:
- All `useState`/`useRef`: `articles`, `loading`, `feedOffset`, `hasMore`, `loadingMore`, `lang`, `sourceMap`, `bioMap`, `categoryMap`, `activeCategory`, `dateRange`, `filterLabel`, `stepDays`, `wheelControlsRef`, `listRef`, `scrollOffsetRef`, `contentHeightRef`, `pendingPropRef`, `langRef`, `feedOffsetRef`
- Font + CSS injection `useEffect` (web-only, fires once)
- Sources/bioMap/categoryMap load `useEffect` (fires on mount)
- Articles fetch `useEffect` (resets on `dateRange`/`activeCategory`)
- `loadMoreArticles()` async pagination
- `handleFilterChange` (useCallback), `handleClearFilter`, `handleCategoryChange`
- SafeAreaView render tree composing all components
- App-level styles: `container`, `body`, `mainFeed`, `emptyState*`, `loadMoreSentinel`, `loadMoreText`, `loadMoreTextDone`

Imports:
- `{ supabase, FEED_PAGE_SIZE, Article, Category } from './lib/config'`
- All 7 components from `./components/*`

---

## Implementation Order

1. `lib/config.ts` — foundation, no deps
2. `MarkdownText.tsx`, `WebHTML.tsx`, `FilterTag.tsx` — parallel, no internal deps
3. `NavBar.tsx`, `DrumWheelSidebar.tsx` — parallel
4. `ArticleCard.tsx`, `TrendBriefCard.tsx` — parallel
5. `App.tsx` rewrite — last

---

## Verification

```bash
cd news-app && npx tsc --noEmit
```

Expected: same 2 pre-existing errors (line 674 engagement null checks in App.tsx area), no new errors.

Manual checks:
- App loads in browser
- Drum wheel fires date filter, articles reload
- Article cards expand/collapse, Q&A streams
- Trend Brief generates, caches, refreshes
- Language toggle preserves scroll position

---

## Safari Performance Fix (2026-04-01)

### Problem

UI/UX was smooth in Chrome but janky in Safari, specifically the drum wheel scroll.

**Root cause:** `itemStyle()` in `DrumWheelSidebar` applied `filter: blur(Xpx) grayscale(1)` to off-center wheel items via inline style. The `.wheel-wrap` parent has `perspective: 220px` (3D stacking context). **Safari/WebKit cannot GPU-composite CSS `filter` effects on children of a 3D perspective context** — it falls back to software (CPU) rendering. Chrome has full GPU compositing for this combination. On every scroll frame, Safari was CPU-painting all 7 visible wheel items from scratch.

Secondary issue: the CSS rule included `transition: filter 0.2s ease-in-out` — animating `filter` is expensive on Safari even outside scroll (transition is stripped during scroll via `.is-scrolling` class, but the settle transition still fired).

### Solution

Removed `filter` entirely from `itemStyle()` and `applyStyle()` in `DrumWheelSidebar`. Off-center items now use opacity falloff only (`Math.max(0.08, 1 - |offset| × 0.38)`), which is GPU-composited on both Chrome and Safari.

**Changed in `App.tsx` (applies to `components/DrumWheelSidebar.tsx` after split):**
- `itemStyle()`: removed `blur` variable and `filter` property from returned object
- `applyStyle()`: sets `inner.style.filter = ''` (clears any residual value) instead of writing blur string
- `itemInnerHTML()`: removed `filter:${s.filter}` from inline style string

Visual result is functionally identical — the opacity gradient already provides the depth/focus cue. The blur was decorative; removing it has no functional impact.
