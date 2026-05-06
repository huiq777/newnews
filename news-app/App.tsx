import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  ActivityIndicator, AppState, FlatList, Platform, SafeAreaView, StyleSheet, Text, View,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase, FEED_PAGE_SIZE, Article, Category, getInitialLang, setSavedLang } from './lib/config'
import { useAuthGate } from './lib/auth'
import BetaGateScreen from './components/BetaGateScreen'
import NavBar from './components/NavBar'
import DrumWheelSidebar from './components/DrumWheelSidebar'
import FilterTag from './components/FilterTag'
import ArticleCard from './components/ArticleCard'
import TrendBriefCard from './components/TrendBriefCard'
import SubscriptionManualModal from './components/SubscriptionManualModal'
import NewArticlesBanner from './components/NewArticlesBanner'
import XThreadCard, { XThreadGroup } from './components/XThreadCard'

type FeedRow = {
  id: string
  title_en: string | null
  title_zh: string | null
  summary_en: string | null
  summary_zh: string | null
  source_type: string
  source_id: string
  thread_group: string | null
  url: string | null
  published_at: string | null
  created_at: string
  questions: { en: string[]; zh: string[] } | null
  engagement: Record<string, number> | null
  next_cursor: string | null
}

export default function App() {
  const { status: authStatus, defaultLang: authDefaultLang, redeemError, retry } = useAuthGate()
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lang, setLang] = useState<'en' | 'zh'>(getInitialLang)
  const [showManual, setShowManual] = useState(false)
  const [sourceMap, setSourceMap] = useState<Record<string, string>>({})
  const [bioMap, setBioMap] = useState<Record<string, string>>({})
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const [activeCategory, setActiveCategory] = useState<Category>('all')
  const [dateRange, setDateRange] = useState<{ start: Date; end: Date } | null>(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const end = new Date(start); end.setDate(end.getDate() + 1)
    return { start, end }
  })
  const [filterLabel, setFilterLabel] = useState('Today')
  const [stepDays, setStepDays] = useState(1)
  const [newArticlesCount, setNewArticlesCount] = useState(0)
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({})
  const wheelControlsRef = useRef<{ resetToToday: () => void; switchTo: (days: 1 | 3 | 7 | 30) => void } | null>(null)
  const [deepThink, setDeepThink] = useState(false)
  const listRef = useRef<FlatList>(null)
  const scrollOffsetRef = useRef(0)
  const contentHeightRef = useRef<{ en: number; zh: number }>({ en: 0, zh: 0 })
  const pendingPropRef = useRef<number | null>(null)
  const langRef = useRef(lang)
  const isInitialLoadRef = useRef(true)
  useEffect(() => {
    langRef.current = lang
  }, [lang])

  // Native async-storage fallback for initial language
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) {
      AsyncStorage.getItem('news_app_lang').then(saved => {
        if (saved === 'en' || saved === 'zh') setLang(saved)
      })
    }
  }, [])

  // Auto set screen size to 90% on web when first loading
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.style.setProperty('zoom', '0.9')
    }
  }, [])

  // Default-language carry-over from invite metadata.
  useEffect(() => {
    if (authDefaultLang && authStatus === 'authed') {
      const hasExplicitLang = typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('news_app_lang')
      if (!hasExplicitLang) setLang(authDefaultLang)
    }
  }, [authDefaultLang, authStatus])

  // Font injection (web-only)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.type = 'image/png'
    favicon.href = '/favicon.ico'
    document.head.appendChild(favicon)
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
      * { scrollbar-width: none; -ms-overflow-style: none; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
      body { overflow: hidden; zoom: 0.9; -webkit-text-size-adjust: none; text-size-adjust: none; }
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
    if (authStatus !== 'authed') return
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
  }, [authStatus])

  const activeCategoryRef = useRef(activeCategory)
  const dateRangeRef = useRef(dateRange)
  const articlesRef = useRef(articles)
  const appStateRef = useRef(AppState.currentState)
  const authStatusRef = useRef(authStatus)

  useEffect(() => { activeCategoryRef.current = activeCategory }, [activeCategory])
  useEffect(() => { dateRangeRef.current = dateRange }, [dateRange])
  useEffect(() => { articlesRef.current = articles }, [articles])
  useEffect(() => { authStatusRef.current = authStatus }, [authStatus])

  const checkMissedArticles = useCallback(async () => {
    if (authStatusRef.current !== 'authed') return
    let latestDate = articlesRef.current.reduce<string | undefined>(
      (max, a) => (a.created_at && (!max || a.created_at > max) ? a.created_at : max),
      undefined
    )
    if (!latestDate && dateRangeRef.current) {
      latestDate = dateRangeRef.current.start.toISOString()
    }
    if (!latestDate) return

    const cat = activeCategoryRef.current
    const dr = dateRangeRef.current

    let query = supabase
      .from('daily_news')
      .select('id', { count: 'exact', head: true })
      .gt('created_at', latestDate)

    if (cat !== 'all') {
      query = query.eq('category', cat)
    }

    if (dr) {
      const s = dr.start.toISOString()
      const e = dr.end.toISOString()
      query = query.or(
        `and(published_at.gte.${s},published_at.lt.${e}),and(published_at.is.null,created_at.gte.${s},created_at.lt.${e})`
      )
    }

    const { count, error } = await query
    if (error) {
      console.error('Error checking missed articles:', error)
      return
    }

    if (count != null && count > 0) {
      setNewArticlesCount(count)
    }
  }, [])

  // Realtime subscription and AppState watcher for background catch-up
  useEffect(() => {
    if (authStatus !== 'authed') return
    const channel = supabase
      .channel('public:daily_news')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'daily_news' }, () => {
        checkMissedArticles()
      })
      .subscribe()

    const appStateSubscription = AppState.addEventListener('change', nextAppState => {
      if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
        checkMissedArticles()
      }
      appStateRef.current = nextAppState
    })

    return () => {
      supabase.removeChannel(channel)
      appStateSubscription.remove()
    }
  }, [checkMissedArticles, authStatus])

  // Fetch articles — reset on dateRange/activeCategory change
  useEffect(() => {
    if (authStatus !== 'authed') return
    setLoading(true)
    setArticles([])
    setHasMore(true)
    setNextCursor(null)

    if (!dateRange) { setLoading(false); return }

    const startDate = dateRange.start.toISOString().slice(0, 10)
    const endDate = dateRange.end.toISOString().slice(0, 10)

    supabase
      .rpc('fetch_grouped_feed', {
        p_date_start: startDate,
        p_date_end: endDate,
        p_category: activeCategory === 'all' ? null : activeCategory,
        p_limit: FEED_PAGE_SIZE,
        p_cursor: null,
      })
      .then(({ data, error }) => {
        if (error) {
          console.error('fetch_grouped_feed error:', error.message)
          setLoading(false)
          return
        }
        const rows = (data ?? []) as FeedRow[]
        // Auto-fallback: if Today returns nothing on INITIAL LOAD, widen to 3D
        if (rows.length === 0 && stepDays === 1 && wheelControlsRef.current && isInitialLoadRef.current) {
          isInitialLoadRef.current = false
          setLoading(false)
          wheelControlsRef.current.switchTo(3)
          return
        }
        isInitialLoadRef.current = false
        setArticles(rows as unknown as Article[])
        setHasMore(rows.length === FEED_PAGE_SIZE)
        setNextCursor(rows.length > 0 ? rows[rows.length - 1].next_cursor : null)
        setLoading(false)
        listRef.current?.scrollToOffset({ offset: 0, animated: false })
      })
  }, [dateRange, activeCategory, refreshTrigger, authStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleLoadNew() {
    setNewArticlesCount(0)
    setRefreshTrigger(v => v + 1)
  }

  async function loadMoreArticles() {
    if (loading || loadingMore || !hasMore || !nextCursor || !dateRange) return
    setLoadingMore(true)

    const startDate = dateRange.start.toISOString().slice(0, 10)
    const endDate = dateRange.end.toISOString().slice(0, 10)

    const { data, error } = await supabase.rpc('fetch_grouped_feed', {
      p_date_start: startDate,
      p_date_end: endDate,
      p_category: activeCategory === 'all' ? null : activeCategory,
      p_limit: FEED_PAGE_SIZE,
      p_cursor: nextCursor,
    })
    setLoadingMore(false)
    if (error) { console.error('loadMoreArticles error:', error.message); return }
    const rows = (data ?? []) as FeedRow[]
    setArticles(prev => [...prev, ...(rows as unknown as Article[])])
    setHasMore(rows.length === FEED_PAGE_SIZE)
    setNextCursor(rows.length > 0 ? rows[rows.length - 1].next_cursor : null)
  }

  const handleFilterChange = useCallback((start: Date, end: Date, label: string, days: number) => {
    setDateRange(prev => {
      if (prev && prev.start.getTime() === start.getTime() && prev.end.getTime() === end.getTime()) {
        return prev
      }
      return { start, end }
    })
    setFilterLabel(label)
    setStepDays(days)
  }, [])

  function handleClearFilter() {
    wheelControlsRef.current?.resetToToday()
  }

  function handleCategoryChange(cat: Category) {
    setActiveCategory(cat)
  }

  const grouped = useMemo(() => {
    const result: (Article | XThreadGroup)[] = []
    const threadMap = new Map<string, XThreadGroup>()

    for (const item of articles) {
      const row = item as unknown as FeedRow
      // Use server-provided thread_group; fall back to URL extraction if null
      const handle = row.thread_group
        ?? row.url?.match(/x\.com\/([^/]+)\/status\//)?.[1]?.toLowerCase()
        ?? null
      if (handle) {
        if (threadMap.has(handle)) {
          threadMap.get(handle)!.tweets.push(item)
        } else {
          const group: XThreadGroup = {
            handle,
            bio: bioMap[handle.toLowerCase()],
            tweets: [item],
          }
          threadMap.set(handle, group)
          result.push(group)
        }
      } else {
        result.push(item)
      }
    }

    // Sort within each group by likes desc
    for (const group of threadMap.values()) {
      group.tweets.sort((a, b) => {
        const aRow = a as unknown as FeedRow
        const bRow = b as unknown as FeedRow
        return (bRow.engagement?.likes ?? 0) - (aRow.engagement?.likes ?? 0)
      })
    }

    return result
  }, [articles, bioMap])

  if (authStatus !== 'authed') {
    return <BetaGateScreen status={authStatus} redeemError={redeemError} onRetry={retry} />
  }

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
          setSavedLang(newLang)
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
          <NewArticlesBanner count={newArticlesCount} lang={lang} onLoad={handleLoadNew} />
          <FilterTag label={filterLabel} onClear={handleClearFilter} />
          {loading
            ? <LoadingIndicator lang={lang} />
            : <FlatList
              ref={listRef}
              data={grouped}
              showsVerticalScrollIndicator={false}
              extraData={[sourceMap, categoryMap, lang, activeCategory]}
              ListHeaderComponent={
                activeCategory === 'all' ? (
                  <TrendBriefCard
                    lang={lang}
                    dateRange={dateRange}
                    stepDays={stepDays}
                    hasArticles={grouped.length > 0}
                    onOpenManual={() => setShowManual(true)}
                  />
                ) : null
              }
              keyExtractor={item => 'tweets' in item ? `thread-${item.handle}` : item.id}
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
              renderItem={({ item }) => {
                if ('tweets' in item) {
                  const handleLower = item.handle.toLowerCase()
                  const isExpanded = !!expandedThreads[handleLower]
                  return (
                    <XThreadCard
                      group={item}
                      lang={lang}
                      isExpanded={isExpanded}
                      onExpandedChange={(v) => setExpandedThreads(prev => ({ ...prev, [handleLower]: v }))}
                      deepThink={deepThink}
                      onDeepThinkChange={setDeepThink}
                    />
                  )
                }
                return <ArticleCard item={item as Article} lang={lang} sourceMap={sourceMap} bioMap={bioMap} deepThink={deepThink} onDeepThinkChange={setDeepThink} />
              }}
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
                  {grouped.length === 0
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
      <SubscriptionManualModal
        visible={showManual}
        lang={lang}
        onClose={() => setShowManual(false)}
      />
    </SafeAreaView>
  )
}

function LoadingIndicator({ lang }: { lang: 'en' | 'zh' }) {
  const [dots, setDots] = useState('.')
  
  useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '.' : d + '.')
    }, 400)
    return () => clearInterval(interval)
  }, [])
  
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator color="#18181b" />
      <Text style={styles.loadingText}>
        {lang === 'en' ? 'loading ' : '加载中 '}{dots}
      </Text>
    </View>
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
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 13, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif', fontVariant: ['tabular-nums'], minWidth: 80, textAlign: 'center' },
})
