import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  ActivityIndicator, AppState, FlatList, SafeAreaView, StyleSheet, Text, View,
} from 'react-native'
import { supabase, FEED_PAGE_SIZE, Article, Category } from './lib/config'
import NavBar from './components/NavBar'
import DrumWheelSidebar from './components/DrumWheelSidebar'
import FilterTag from './components/FilterTag'
import ArticleCard from './components/ArticleCard'
import TrendBriefCard from './components/TrendBriefCard'
import NewArticlesBanner from './components/NewArticlesBanner'
import XThreadCard, { XThreadGroup } from './components/XThreadCard'

export default function App() {
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [feedOffset, setFeedOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lang, setLang] = useState<'en' | 'zh'>('en')
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
  const listRef = useRef<FlatList>(null)
  const scrollOffsetRef = useRef(0)
  const contentHeightRef = useRef<{ en: number; zh: number }>({ en: 0, zh: 0 })
  const pendingPropRef = useRef<number | null>(null)
  const langRef = useRef(lang)
  const feedOffsetRef = useRef(0)
  const isInitialLoadRef = useRef(true)
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

  const activeCategoryRef = useRef(activeCategory)
  const dateRangeRef = useRef(dateRange)
  const articlesRef = useRef(articles)
  const appStateRef = useRef(AppState.currentState)

  useEffect(() => { activeCategoryRef.current = activeCategory }, [activeCategory])
  useEffect(() => { dateRangeRef.current = dateRange }, [dateRange])
  useEffect(() => { articlesRef.current = articles }, [articles])

  const checkMissedArticles = useCallback(async () => {
    let latestDate = articlesRef.current[0]?.created_at
    if (!latestDate && dateRangeRef.current) {
      latestDate = dateRangeRef.current.start.toISOString()
    }
    if (!latestDate) return

    const cat = activeCategoryRef.current
    const dr = dateRangeRef.current

    let query = supabase
      .from('daily_news')
      .select(cat === 'all' ? 'id' : 'id, sources!inner(category)', { count: 'exact', head: true })
      .gt('created_at', latestDate)

    if (cat !== 'all') {
      query = query.eq('sources.category', cat)
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
  }, [checkMissedArticles])

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
        // Auto-fallback: if Today returns nothing on INITIAL LOAD, widen to 3D
        if ((!data || data.length === 0) && stepDays === 1 && wheelControlsRef.current && isInitialLoadRef.current) {
          isInitialLoadRef.current = false
          wheelControlsRef.current.switchTo(3)
          return
        }
        isInitialLoadRef.current = false
        setArticles(data as unknown as Article[])
        const loaded = data?.length ?? 0
        setHasMore(loaded === FEED_PAGE_SIZE)
        setFeedOffset(FEED_PAGE_SIZE)
        feedOffsetRef.current = FEED_PAGE_SIZE
      }
      setLoading(false)
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
    })
  }, [dateRange, activeCategory, refreshTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleLoadNew() {
    setNewArticlesCount(0)
    setRefreshTrigger(v => v + 1)
  }

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

  const displayArticles = useMemo(() => {
    const result: (Article | XThreadGroup)[] = []
    const authorGroupMap = new Map<string, XThreadGroup>()

    for (const item of articles) {
      const match = item.url?.match(/x\.com\/([^/]+)\/status\//)
      if (match && match[1]) {
        const handle = match[1].toLowerCase()
        if (authorGroupMap.has(handle)) {
          authorGroupMap.get(handle)!.tweets.push(item)
        } else {
          const newGroup: XThreadGroup = {
            handle: match[1],
            bio: bioMap[handle],
            tweets: [item],
          }
          authorGroupMap.set(handle, newGroup)
          result.push(newGroup)
        }
      } else {
        result.push(item)
      }
    }

    // Sort tweets within groups by likes desc
    for (const group of authorGroupMap.values()) {
      group.tweets.sort((a, b) => (b.engagement?.likes ?? 0) - (a.engagement?.likes ?? 0))
    }

    return result
  }, [articles, bioMap])

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
          <NewArticlesBanner count={newArticlesCount} lang={lang} onLoad={handleLoadNew} />
          <FilterTag label={filterLabel} onClear={handleClearFilter} />
          {loading
            ? <ActivityIndicator style={{ flex: 1 }} color="#18181b" />
            : <FlatList
              ref={listRef}
              data={displayArticles}
              showsVerticalScrollIndicator={false}
              extraData={[sourceMap, categoryMap, lang, activeCategory]}
              ListHeaderComponent={
                activeCategory === 'all' ? (
                  <TrendBriefCard
                    lang={lang}
                    dateRange={dateRange}
                    stepDays={stepDays}
                    hasArticles={displayArticles.length > 0}
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
                    />
                  )
                }
                return <ArticleCard item={item as Article} lang={lang} sourceMap={sourceMap} bioMap={bioMap} />
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
