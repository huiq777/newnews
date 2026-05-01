# App.tsx Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `news-app/App.tsx` (1434-line monolith) into 7 focused component files + 1 shared config module, leaving App.tsx as a ~280-line shell.

**Architecture:** Extract each component verbatim (no logic changes) into `news-app/components/`, move all shared types/constants/helpers into `news-app/lib/config.ts`, and split the monolithic StyleSheet into per-component local StyleSheets.

**Tech Stack:** React Native + TypeScript + Expo (web-first)

---

## File Map

| File | Action | Source in App.tsx |
|------|--------|-------------------|
| `news-app/lib/config.ts` | Create | Lines 1–14 (constants) + 43–82 (types/helpers) + 804–805 (BriefSource/BriefState) |
| `news-app/components/MarkdownText.tsx` | Create | Lines 18–40 |
| `news-app/components/WebHTML.tsx` | Create | Lines 84–92 |
| `news-app/components/FilterTag.tsx` | Create | Lines 537–548 + filterTag styles |
| `news-app/components/NavBar.tsx` | Create | Lines 97–182 + nav\* styles |
| `news-app/components/DrumWheelSidebar.tsx` | Create | Lines 185–534 + aside/tfBtn\*/wheelContainer styles |
| `news-app/components/ArticleCard.tsx` | Create | Lines 551–803 + card\*/title/summary/engagement\*/questions\*/answer\*/thinking\*/content\* styles |
| `news-app/components/TrendBriefCard.tsx` | Create | Lines 803–1016 + brief\* styles |
| `news-app/App.tsx` | Rewrite | Lines 1019–1261 (App fn) + container/body/mainFeed/emptyState\*/loadMore\* styles |

---

### Task 1: Create `lib/config.ts`

**Files:**
- Create: `news-app/lib/config.ts`

- [ ] **Step 1: Create the file**

```typescript
// news-app/lib/config.ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
)

export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
export const FEED_PAGE_SIZE = 10

// ─── Types ────────────────────────────────────────────────────────────────────
export type AnswerState = {
  thinking: string
  content: string
  thinkingDone: boolean
  streaming: boolean
}

export type Article = {
  id: string
  source_id: string
  title: string
  summary: string
  title_en: string | null
  summary_en: string | null
  title_zh: string | null
  summary_zh: string | null
  url: string
  created_at: string
  published_at?: string | null
  questions: { en: string[]; zh: string[] } | null
  engagement?: { likes?: number; retweets?: number; hn_score?: number; hn_comments?: number; stars?: number } | null
}

export type Category = 'all' | 'industry' | 'technical_frontier' | 'career_community'

export type BriefSource = {
  index: number
  id: string
  title: string
  url: string | null
  published_at: string | null
  is_historical: boolean
}

export type BriefState = 'idle' | 'loading' | 'streaming' | 'loaded' | 'error' | 'rate_limited'

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function formatPublishedDate(dateStr: string | undefined | null, lang: 'en' | 'zh'): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  if (lang === 'en') {
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${mo[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}月 ${String(d.getDate()).padStart(2, '0')}日`
}

export function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return `${n}`
}

// ─── FIRE_SVG ─────────────────────────────────────────────────────────────────
// Copy the FIRE_SVG constant verbatim from App.tsx lines 94–95 (the const declaration + its value)
export const FIRE_SVG = `REPLACE_WITH_LINE_94_VALUE`
```

> **Important:** Replace the `FIRE_SVG` value by copying the entire SVG string from App.tsx line 94 (`const FIRE_SVG = \`...\``). Copy everything between the backticks.

- [ ] **Step 2: Create `news-app/lib/` directory first**

```bash
mkdir -p "news-app/lib"
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd news-app && npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only about missing component files (which don't exist yet) — `lib/config.ts` itself should be clean.

---

### Task 2: Create `components/MarkdownText.tsx`

**Files:**
- Create: `news-app/components/MarkdownText.tsx`

- [ ] **Step 1: Create directory and file**

```bash
mkdir -p "news-app/components"
```

```typescript
// news-app/components/MarkdownText.tsx
import { Text, View } from 'react-native'

export default function MarkdownText({ text, style }: { text: string; style?: object }) {
  const isBullet = text.trimStart().startsWith('•')
  const content = isBullet ? text.replace(/^\s*•\s*/, '') : text
  const parts = content.split(/\*\*([^*]+)\*\*/)
  const inner = (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <Text key={i} style={{ fontWeight: '700' }}>{part}</Text>
          : part
      )}
    </Text>
  )
  if (isBullet) {
    return (
      <View style={{ flexDirection: 'row', marginBottom: 6, alignItems: 'flex-start' }}>
        <Text style={[style, { marginRight: 8, color: '#9E9690', lineHeight: 22 }]}>•</Text>
        <View style={{ flex: 1 }}>{inner}</View>
      </View>
    )
  }
  return inner
}
```

---

### Task 3: Create `components/WebHTML.tsx`

**Files:**
- Create: `news-app/components/WebHTML.tsx`

- [ ] **Step 1: Create the file**

```typescript
// news-app/components/WebHTML.tsx
import { useEffect, useRef } from 'react'
import { View } from 'react-native'

export default function WebHTML({ html, style }: { html: string; style?: object }) {
  const ref = useRef<any>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const node = ref.current as unknown as HTMLElement | null
    if (node) node.innerHTML = html
  }, [html])
  return <View ref={ref} style={style} />
}
```

---

### Task 4: Create `components/FilterTag.tsx`

**Files:**
- Create: `news-app/components/FilterTag.tsx`

- [ ] **Step 1: Create the file**

```typescript
// news-app/components/FilterTag.tsx
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'

export default function FilterTag({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <View style={styles.filterTagRow}>
      <View style={styles.filterTag}>
        <Text style={styles.filterTagText}>{label}</Text>
        <TouchableOpacity onPress={onClear} style={{ opacity: 0.5 }}>
          <Text style={styles.filterTagText}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  filterTagRow: { marginBottom: 24 },
  filterTag: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    alignSelf: 'flex-start', backgroundColor: '#2d3432',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
  },
  filterTagText: {
    fontSize: 11, fontWeight: '700', color: '#f9f9f7',
    fontFamily: 'Space Grotesk, sans-serif', letterSpacing: 0.5,
  },
})
```

- [ ] **Step 2: Commit Task 1–4**

```bash
cd news-app && git add lib/config.ts components/MarkdownText.tsx components/WebHTML.tsx components/FilterTag.tsx
git commit -m "refactor: extract config, MarkdownText, WebHTML, FilterTag from App.tsx"
```

---

### Task 5: Create `components/NavBar.tsx`

**Files:**
- Create: `news-app/components/NavBar.tsx`

- [ ] **Step 1: Create the file**

The component body is App.tsx lines 97–182 verbatim. Wrap it with these imports and the StyleSheet below.

```typescript
// news-app/components/NavBar.tsx
import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Category } from '../lib/config'

export default function NavBar({
  lang,
  activeCategory,
  onLangChange,
  onCategoryChange,
}: {
  lang: 'en' | 'zh'
  activeCategory: Category
  onLangChange: (l: 'en' | 'zh') => void
  onCategoryChange: (cat: Category) => void
}) {
  // ── COPY App.tsx lines 108–182 verbatim (from `const langAnim = ...` through closing `}`) ──
}

const styles = StyleSheet.create({
  nav: {
    height: 64, flexDirection: 'row', alignItems: 'flex-end',
    paddingBottom: 14,
    borderBottomWidth: 1, borderColor: '#f4f4f5',
    backgroundColor: 'rgba(255,255,255,0.8)',
    position: 'fixed' as any, top: 0, left: 0, right: 0, zIndex: 50,
  },
  navLogoCol: { width: 256, paddingHorizontal: 20 },
  navLogoText: {
    fontSize: 20, fontWeight: '700', color: '#18181b',
    fontFamily: 'Manrope, sans-serif', letterSpacing: -0.5,
  },
  navTabsCol: {
    flex: 1, flexDirection: 'row', paddingHorizontal: 32,
    gap: 32, alignItems: 'flex-end',
  },
  navTabItem: { position: 'relative', paddingBottom: 4 },
  navTabText: {
    fontSize: 14, fontWeight: '500', color: '#71717a',
    fontFamily: 'Manrope, sans-serif',
  },
  navTabTextActive: { fontWeight: '700', color: '#18181b' },
  navTabUnderline: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 2, backgroundColor: '#18181b',
  },
  navLangCol: { paddingHorizontal: 32, alignItems: 'center', justifyContent: 'center' },
  navLangPill: {
    flexDirection: 'row', backgroundColor: 'rgba(228,228,231,0.5)',
    borderRadius: 999, padding: 4,
  },
  navLangBtn: {
    width: 40, paddingVertical: 4, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
  },
  navLangBtnActive: { backgroundColor: '#2d3432' },
  navLangText: {
    fontSize: 10, fontWeight: '700', color: '#71717a',
    fontFamily: 'Space Grotesk, sans-serif',
  },
  navLangTextActive: { color: '#f9f9f7' },
})
```

---

### Task 6: Create `components/DrumWheelSidebar.tsx`

**Files:**
- Create: `news-app/components/DrumWheelSidebar.tsx`

- [ ] **Step 1: Create the file**

The component body is App.tsx lines 185–534 verbatim. Wrap it with these imports and the StyleSheet below.

```typescript
// news-app/components/DrumWheelSidebar.tsx
import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native'

export default function DrumWheelSidebar({
  lang,
  onFilterChange,
  onMountedControls,
}: {
  lang: 'en' | 'zh'
  onFilterChange: (start: Date, end: Date, label: string, stepDays: number) => void
  onMountedControls: (controls: { resetToToday: () => void }) => void
}) {
  // ── COPY App.tsx lines 188–534 verbatim (from `const tfAnim = ...` through closing `}`) ──
}

const styles = StyleSheet.create({
  aside: {
    width: 256, position: 'fixed' as any, top: 64, bottom: 0, left: 0,
    borderRightWidth: 1, borderColor: '#f4f4f5',
    backgroundColor: '#fafafa', padding: 20,
    flexDirection: 'column', gap: 24,
  },
  tfRow: {
    flexDirection: 'row', gap: 4,
    backgroundColor: 'rgba(228,228,231,0.5)', padding: 4, borderRadius: 8,
  },
  tfBtn: {
    flex: 1, paddingVertical: 6, paddingHorizontal: 8,
    borderRadius: 6, alignItems: 'center',
  },
  tfBtnActive: {
    backgroundColor: '#ffffff', borderRadius: 6,
    shadowColor: '#000', shadowOpacity: 0.08,
    shadowRadius: 2, shadowOffset: { width: 0, height: 1 },
  },
  tfBtnText: {
    fontSize: 10, fontWeight: '700', color: '#a1a1aa',
    fontFamily: 'Space Grotesk, sans-serif', letterSpacing: 1.5,
  },
  tfBtnTextActive: { color: '#18181b' },
  wheelContainer: { flex: 1 },
})
```

- [ ] **Step 2: Commit Task 5–6**

```bash
git add news-app/components/NavBar.tsx news-app/components/DrumWheelSidebar.tsx
git commit -m "refactor: extract NavBar, DrumWheelSidebar from App.tsx"
```

---

### Task 7: Create `components/ArticleCard.tsx`

**Files:**
- Create: `news-app/components/ArticleCard.tsx`

- [ ] **Step 1: Create the file**

The component body is App.tsx lines 551–803 verbatim. Wrap it with these imports and the StyleSheet below.

```typescript
// news-app/components/ArticleCard.tsx
import { useEffect, useRef, useState } from 'react'
import {
  Linking, Pressable, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native'
import {
  Article, AnswerState, SUPABASE_URL, SUPABASE_ANON_KEY,
  FIRE_SVG, formatPublishedDate, fmtNum,
} from '../lib/config'
import MarkdownText from './MarkdownText'
import WebHTML from './WebHTML'

export default function ArticleCard({
  item, lang, sourceMap, bioMap,
}: {
  item: Article
  lang: 'en' | 'zh'
  sourceMap: Record<string, string>
  bioMap: Record<string, string>
}) {
  // ── COPY App.tsx lines 559–803 verbatim (from `const [isExpanded, ...` through closing `}`) ──
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff', marginVertical: 6, padding: 16,
    borderRadius: 12, borderWidth: 1, borderColor: '#f4f4f5',
  },
  cardExpanded: { backgroundColor: '#F0EDE8' },
  cardHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },
  cardHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 10,
  },
  cardHeaderRight: { flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginLeft: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  sourceLabel: {
    fontSize: 10, fontWeight: '700', color: '#a1a1aa',
    letterSpacing: 2, fontFamily: 'Space Grotesk, sans-serif',
    textTransform: 'uppercase', flex: 1,
  },
  publishedDate: {
    fontSize: 10, fontWeight: '700', color: '#a1a1aa',
    letterSpacing: 2, fontFamily: 'Space Grotesk, sans-serif',
    textTransform: 'uppercase', marginBottom: 10, marginTop: -2,
  },
  engagementPill: { backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  engagementPillHN: { backgroundColor: '#FFF8E1' },
  engagementText: { fontSize: 11, fontWeight: '800', color: '#D84315', fontFamily: 'Space Grotesk, sans-serif' },
  engagementTextHN: { color: '#FF6F00' },
  expandChevron: { fontSize: 12, color: '#9E9690', marginLeft: 6 },
  questionsPillRow: { flexDirection: 'row' as const, marginTop: 10 },
  questionsPill: { backgroundColor: '#1A1A1A', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  questionsPillText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  noQuestionsPill: { backgroundColor: '#1A1A1A', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  noQuestionsText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  title: {
    fontSize: 16, fontWeight: '600', color: '#18181b',
    fontFamily: 'Manrope, sans-serif', letterSpacing: -0.2,
    lineHeight: 22, marginBottom: 10,
  },
  summary: { fontSize: 14, color: '#3D3935', lineHeight: 22 },
  readMore: { fontSize: 12, color: '#6B6560', fontWeight: '500', marginTop: 10 },
  questionsSection: { marginTop: 14 },
  questionsDivider: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#E0DDD6' },
  dividerText: { fontSize: 11, color: '#9E9690', fontWeight: '600', letterSpacing: 0.5 },
  refreshIcon: { fontSize: 16, color: '#1A1A1A' },
  refreshDisabled: { fontSize: 16, color: '#C8C4BE' },
  questionRow: { paddingVertical: 8 },
  questionText: { fontSize: 14, color: '#3D3935', lineHeight: 20 },
  answerBlock: { marginBottom: 8 },
  thinkingHeader: { paddingVertical: 4 },
  thinkingHeaderText: { fontSize: 12, color: '#9E9690', fontStyle: 'italic' },
  thinkingBlock: { backgroundColor: '#F0EDE8', borderRadius: 8, padding: 10, marginTop: 4 },
  thinkingText: { fontSize: 12, color: '#9E9690', fontStyle: 'italic', lineHeight: 18 },
  contentBlock: { backgroundColor: '#F0EDE8', borderRadius: 8, padding: 12, marginTop: 6 },
  contentText: { fontSize: 14, color: '#3D3935', lineHeight: 22 },
})
```

---

### Task 8: Create `components/TrendBriefCard.tsx`

**Files:**
- Create: `news-app/components/TrendBriefCard.tsx`

- [ ] **Step 1: Create the file**

The component body is App.tsx lines 803–1016 verbatim. The type declarations on lines 804–805 (`BriefSource`, `BriefState`) are now imported from `lib/config` — do **not** re-declare them locally.

```typescript
// news-app/components/TrendBriefCard.tsx
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { BriefSource, BriefState, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/config'

export default function TrendBriefCard({
  lang,
  dateRange,
  stepDays,
  hasArticles,
}: {
  lang: 'en' | 'zh'
  dateRange: { start: Date; end: Date } | null
  stepDays: number
  hasArticles: boolean
}) {
  // ── COPY App.tsx lines 818–1016 verbatim (from `const [briefState, ...` through closing `}`) ──
  // Note: lines 804–805 (type BriefSource / type BriefState) are now imported — skip them.
}

const styles = StyleSheet.create({
  briefCard: {
    backgroundColor: '#fafafa', borderRadius: 12, borderWidth: 1, borderColor: '#e4e4e7',
    padding: 16, marginBottom: 12,
  },
  briefHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  briefHeaderText: {
    fontSize: 10, fontWeight: '700', color: '#71717a', letterSpacing: 1.5,
    textTransform: 'uppercase', fontFamily: 'Space Grotesk, sans-serif', flex: 1,
  },
  briefAge: { fontSize: 10, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif' },
  briefRefresh: { fontSize: 13, color: '#71717a', fontFamily: 'Space Grotesk, sans-serif' },
  briefSkeleton: { paddingVertical: 8 },
  briefSkeletonText: { fontSize: 13, color: '#a1a1aa', fontStyle: 'italic', fontFamily: 'Space Grotesk, sans-serif' },
  briefSynthesis: { fontSize: 13, lineHeight: 20, color: '#27272a', fontFamily: 'Space Grotesk, sans-serif' },
  briefError: { fontSize: 12, color: '#ef4444', fontFamily: 'Space Grotesk, sans-serif' },
  briefSourcesToggle: { paddingVertical: 4 },
  briefSourcesToggleText: {
    fontSize: 11, fontWeight: '700', color: '#71717a', letterSpacing: 1,
    textTransform: 'uppercase', fontFamily: 'Space Grotesk, sans-serif',
  },
  briefSourceRow: { flexDirection: 'row', gap: 6, paddingVertical: 4, borderTopWidth: 1, borderTopColor: '#f4f4f5' },
  briefSourceIndex: { fontSize: 11, fontWeight: '700', color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif', minWidth: 24 },
  briefSourceTitle: { fontSize: 12, color: '#3f3f46', fontFamily: 'Space Grotesk, sans-serif' },
  briefSourceDate: { fontSize: 10, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif', marginTop: 1 },
  briefSourceHistorical: { color: '#d4d4d8' },
  briefChevron: { fontSize: 10, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif' },
})
```

- [ ] **Step 2: Commit Task 7–8**

```bash
git add news-app/components/ArticleCard.tsx news-app/components/TrendBriefCard.tsx
git commit -m "refactor: extract ArticleCard, TrendBriefCard from App.tsx"
```

---

### Task 9: Rewrite `App.tsx` as Shell

**Files:**
- Modify: `news-app/App.tsx` (replace entire content)

- [ ] **Step 1: Replace App.tsx with the shell**

```typescript
// news-app/App.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, FlatList, SafeAreaView, StyleSheet, Text, View,
} from 'react-native'
import { supabase, FEED_PAGE_SIZE, Article, Category } from './lib/config'
import NavBar from './components/NavBar'
import DrumWheelSidebar from './components/DrumWheelSidebar'
import FilterTag from './components/FilterTag'
import ArticleCard from './components/ArticleCard'
import TrendBriefCard from './components/TrendBriefCard'

export default function App() {
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [feedOffset, setFeedOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lang, setLang] = useState<'en' | 'zh'>('en')
  const [sourceMap, setSourceMap] = useState<Record<string, string>>({})
  const [bioMap, setBioMap] = useState<Record<string, string>>({})
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const [activeCategory, setActiveCategory] = useState<Category>('all')
  const [dateRange, setDateRange] = useState<{ start: Date; end: Date } | null>(null)
  const [filterLabel, setFilterLabel] = useState('Today')
  const [stepDays, setStepDays] = useState(1)
  const wheelControlsRef = useRef<{ resetToToday: () => void } | null>(null)
  const listRef = useRef<FlatList>(null)
  const scrollOffsetRef = useRef(0)
  const contentHeightRef = useRef<{ en: number; zh: number }>({ en: 0, zh: 0 })
  const pendingPropRef = useRef<number | null>(null)
  const langRef = useRef(lang)
  const feedOffsetRef = useRef(0)
  useEffect(() => { langRef.current = lang }, [lang])
  useEffect(() => { feedOffsetRef.current = feedOffset }, [feedOffset])

  // Font injection (web-only)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@300..700&family=Inter:wght@400;500;600&display=swap'
    document.head.appendChild(link)
    const fa = document.createElement('link')
    fa.rel = 'stylesheet'
    fa.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css'
    document.head.appendChild(fa)
    const style = document.createElement('style')
    style.textContent = `
      *::-webkit-scrollbar { display: none; }
      * { scrollbar-width: none; -ms-overflow-style: none; }
      body { overflow: hidden; }
    `
    document.head.appendChild(style)
    return () => {
      if (document.head.contains(link)) document.head.removeChild(link)
      if (document.head.contains(fa)) document.head.removeChild(fa)
      if (document.head.contains(style)) document.head.removeChild(style)
    }
  }, [])

  // Load sources
  useEffect(() => {
    supabase.from('sources').select('id, name, metadata, category').then(({ data }) => {
      if (data) {
        const sMap: Record<string, string> = {}
        const bMap: Record<string, string> = {}
        const cMap: Record<string, string> = {}
        data.forEach((s: { id: string; name: string; category?: string; metadata?: { bio_map?: Record<string, string> } }) => {
          sMap[s.id] = s.name
          if (s.metadata?.bio_map) Object.assign(bMap, s.metadata.bio_map)
          if (s.category) cMap[s.id] = s.category
        })
        setSourceMap(sMap)
        setBioMap(bMap)
        setCategoryMap(cMap)
      }
    })
  }, [])

  // Fetch articles — reset on dateRange/activeCategory change
  useEffect(() => {
    setLoading(true)
    setArticles([])
    setHasMore(true)
    feedOffsetRef.current = 0

    const selectQuery = activeCategory === 'all'
      ? 'id, source_id, title, summary, title_en, summary_en, title_zh, summary_zh, url, created_at, published_at, questions, engagement'
      : 'id, source_id, title, summary, title_en, summary_en, title_zh, summary_zh, url, created_at, published_at, questions, engagement, sources!inner(category)'

    let query = supabase
      .from('daily_news')
      .select(selectQuery)
      .order('created_at', { ascending: false })

    if (activeCategory !== 'all') {
      query = query.eq('sources.category', activeCategory)
    }

    if (dateRange) {
      const s = dateRange.start.toISOString()
      const e = dateRange.end.toISOString()
      query = query.or(
        `and(published_at.gte.${s},published_at.lt.${e}),and(published_at.is.null,created_at.gte.${s},created_at.lt.${e})`
      )
    }

    query.range(0, FEED_PAGE_SIZE - 1).then(({ data, error }) => {
      if (error) console.error(error)
      else {
        setArticles(data as unknown as Article[])
        const loaded = data?.length ?? 0
        setHasMore(loaded === FEED_PAGE_SIZE)
        setFeedOffset(FEED_PAGE_SIZE)
        feedOffsetRef.current = FEED_PAGE_SIZE
      }
      setLoading(false)
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
    })
  }, [dateRange, activeCategory]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMoreArticles() {
    if (loading || loadingMore || !hasMore) return
    setLoadingMore(true)
    const offset = feedOffsetRef.current

    const selectQuery = activeCategory === 'all'
      ? 'id, source_id, title, summary, title_en, summary_en, title_zh, summary_zh, url, created_at, published_at, questions, engagement'
      : 'id, source_id, title, summary, title_en, summary_en, title_zh, summary_zh, url, created_at, published_at, questions, engagement, sources!inner(category)'

    let query = supabase
      .from('daily_news')
      .select(selectQuery)
      .order('created_at', { ascending: false })

    if (activeCategory !== 'all') {
      query = query.eq('sources.category', activeCategory)
    }

    if (dateRange) {
      const s = dateRange.start.toISOString()
      const e = dateRange.end.toISOString()
      query = query.or(
        `and(published_at.gte.${s},published_at.lt.${e}),and(published_at.is.null,created_at.gte.${s},created_at.lt.${e})`
      )
    }

    query.range(offset, offset + FEED_PAGE_SIZE - 1).then(({ data, error }) => {
      if (error) { console.error(error); setLoadingMore(false); return }
      const loaded = data?.length ?? 0
      setArticles(prev => [...prev, ...(data as unknown as Article[])])
      setHasMore(loaded === FEED_PAGE_SIZE)
      setFeedOffset(offset + FEED_PAGE_SIZE)
      feedOffsetRef.current = offset + FEED_PAGE_SIZE
      setLoadingMore(false)
    })
  }

  const handleFilterChange = useCallback((start: Date, end: Date, label: string, days: number) => {
    setDateRange({ start, end })
    setFilterLabel(label)
    setStepDays(days)
  }, [])

  function handleClearFilter() {
    wheelControlsRef.current?.resetToToday()
  }

  function handleCategoryChange(cat: Category) {
    setActiveCategory(cat)
  }

  const displayArticles = articles

  return (
    <SafeAreaView style={styles.container}>
      <NavBar
        lang={lang}
        activeCategory={activeCategory}
        onLangChange={(newLang) => {
          if (newLang === lang) return
          const h = contentHeightRef.current[lang]
          pendingPropRef.current = h > 0 ? scrollOffsetRef.current / h : 0
          setLang(newLang)
        }}
        onCategoryChange={handleCategoryChange}
      />
      <View style={styles.body}>
        <DrumWheelSidebar
          lang={lang}
          onFilterChange={handleFilterChange}
          onMountedControls={controls => { wheelControlsRef.current = controls }}
        />
        <View style={styles.mainFeed}>
          <FilterTag label={filterLabel} onClear={handleClearFilter} />
          {activeCategory === 'all' && (
            <TrendBriefCard
              lang={lang}
              dateRange={dateRange}
              stepDays={stepDays}
              hasArticles={articles.length > 0}
            />
          )}
          {loading
            ? <ActivityIndicator style={{ flex: 1 }} color="#18181b" />
            : <FlatList
              ref={listRef}
              data={displayArticles}
              showsVerticalScrollIndicator={false}
              extraData={[sourceMap, categoryMap, lang, activeCategory]}
              keyExtractor={item => item.id}
              onScroll={({ nativeEvent }) => { scrollOffsetRef.current = nativeEvent.contentOffset.y }}
              scrollEventThrottle={16}
              onContentSizeChange={(_, h) => {
                contentHeightRef.current[langRef.current] = h
                if (pendingPropRef.current !== null) {
                  const target = pendingPropRef.current * h
                  pendingPropRef.current = null
                  listRef.current?.scrollToOffset({ offset: target, animated: false })
                }
              }}
              renderItem={({ item }) => (
                <ArticleCard item={item} lang={lang} sourceMap={sourceMap} bioMap={bioMap} />
              )}
              onEndReached={loadMoreArticles}
              onEndReachedThreshold={0.2}
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Text style={styles.emptyStateText}>{lang === 'en' ? 'No articles yet.' : '暂无文章。'}</Text>
                  <Text style={styles.emptyStateSubtext}>{lang === 'en' ? 'Check back later :)' : '请稍后再来看看～'}</Text>
                </View>
              }
              ListFooterComponent={
                <View style={styles.loadMoreSentinel}>
                  {displayArticles.length === 0
                    ? <Text style={styles.loadMoreTextDone}>{lang === 'en' ? '──────── all caught up ────────' : '──────── 已经到底了 ────────'}</Text>
                    : loadingMore
                      ? <Text style={styles.loadMoreText}>{lang === 'en' ? 'loading ···' : '加载中 ···'}</Text>
                      : hasMore
                        ? <Text style={styles.loadMoreText}>{lang === 'en' ? '──────── scroll down to load more ────────' : '──────── 向下滚动加载更多 ────────'}</Text>
                        : <Text style={styles.loadMoreTextDone}>{lang === 'en' ? '──────── all caught up ────────' : '──────── 已经到底了 ────────'}</Text>
                  }
                </View>
              }
            />
          }
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9f9f7' },
  body: { flex: 1, flexDirection: 'row', marginTop: 64 },
  mainFeed: { flex: 1, marginLeft: 256, paddingHorizontal: 32, paddingTop: 20, paddingBottom: 24 },
  emptyState: { alignItems: 'center', justifyContent: 'center', padding: 48 },
  emptyStateText: { fontSize: 16, fontWeight: '600', color: '#1A1A1A', marginBottom: 6 },
  emptyStateSubtext: { fontSize: 14, color: '#9E9690', textAlign: 'center' },
  loadMoreSentinel: { paddingVertical: 16, alignItems: 'center' },
  loadMoreText: { fontSize: 10, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif', letterSpacing: 1.5 },
  loadMoreTextDone: { fontSize: 10, color: '#d4d4d8', fontFamily: 'Space Grotesk, sans-serif', letterSpacing: 1.5 },
})
```

---

### Task 10: Verify and Commit

- [ ] **Step 1: TypeScript check**

```bash
cd news-app && npx tsc --noEmit 2>&1
```

Expected: The same 2 pre-existing errors (engagement null checks around the old line 674, now in `ArticleCard.tsx`). No new errors. If new errors appear, trace them — likely a missing import or a local type that should come from `lib/config`.

- [ ] **Step 2: Manual smoke test**

```bash
cd news-app && npx expo start --web
```

Check in browser:
- App loads, articles appear
- Drum wheel fires date filter, articles reload
- Article cards expand/collapse, Q&A streams
- Trend Brief generates on "All" tab; hidden on category tabs
- Language toggle preserves scroll position
- Nav category tab switching works

- [ ] **Step 3: Commit**

```bash
git add news-app/App.tsx
git commit -m "refactor: rewrite App.tsx as shell — split complete"
```
