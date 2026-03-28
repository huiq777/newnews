import { useEffect, useRef, useState } from 'react'
import { FlatList, Text, StyleSheet, ActivityIndicator, SafeAreaView, TouchableOpacity, Pressable, Linking, View } from 'react-native'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
)

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
const PAGE_SIZE = 20

function MarkdownText({ text, style }: { text: string; style?: object }) {
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

type AnswerState = {
  thinking: string
  content: string
  thinkingDone: boolean
  streaming: boolean
}

type Article = {
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
  questions: { en: string[]; zh: string[] } | null
  engagement?: { likes?: number; retweets?: number; hn_score?: number; hn_comments?: number } | null
}

function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return `${n}`
}

function ArticleCard({ item, lang, sourceMap, bioMap }: { item: Article; lang: 'en' | 'zh'; sourceMap: Record<string, string>; bioMap: Record<string, string> }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({})
  const [localQuestions, setLocalQuestions] = useState(item.questions)
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<number, boolean>>({})

  const displayTitle = (lang === 'en' ? item.title_en : item.title_zh) || item.title
  const displaySummary = (lang === 'en' ? item.summary_en : item.summary_zh) || item.summary
  const sourceName = sourceMap[item.source_id]
  const isWechat = item.url?.includes('mp.weixin.qq.com')
  const xHandle = item.url?.match(/x\.com\/([^/]+)\/status\//)?.[1]
  const xBio = xHandle ? bioMap[xHandle.toLowerCase()] : undefined
  const sourceLabel = isWechat
    ? `${lang === 'zh' ? '公众号' : 'WeChat'} - ${sourceName}`
    : xHandle
    ? `X - @${xHandle}${xBio ? ` - ${xBio}` : ''}`
    : sourceName
  const questions = localQuestions ? (lang === 'en' ? localQuestions.en : localQuestions.zh) : []

  useEffect(() => {
    setAnswers({})
  }, [lang])

  useEffect(() => {
    if (!isExpanded) setQuestionsOpen(false)
  }, [isExpanded])

  async function handleAsk(index: number, question: string) {
    if (answers[index]?.content && !answers[index]?.streaming) {
      setAnswers(prev => {
        const next = { ...prev }
        delete next[index]
        return next
      })
      return
    }

    setAnswers(prev => ({
      ...prev,
      [index]: { thinking: '', content: '', thinkingDone: false, streaming: true },
    }))

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/answer-question`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ article_id: item.id, question, lang }),
      })

      if (!res.ok) {
        const err = await res.text()
        console.error('answer-question error:', err)
        setAnswers(prev => ({ ...prev, [index]: { ...prev[index], streaming: false } }))
        return
      }

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
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') {
            setAnswers(prev => ({ ...prev, [index]: { ...prev[index], streaming: false } }))
            return
          }
          try {
            const parsed = JSON.parse(payload)
            if (parsed.type === 'thinking') {
              setAnswers(prev => ({
                ...prev,
                [index]: { ...prev[index], thinking: prev[index].thinking + parsed.content },
              }))
            } else if (parsed.type === 'content') {
              setAnswers(prev => ({
                ...prev,
                [index]: { ...prev[index], content: prev[index].content + parsed.content, thinkingDone: true },
              }))
            }
          } catch {}
        }
      }
      setAnswers(prev => ({ ...prev, [index]: { ...prev[index], streaming: false } }))
    } catch (e) {
      console.error('handleAsk error:', e)
      setAnswers(prev => ({ ...prev, [index]: { ...prev[index], streaming: false } }))
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    setAnswers({})
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/refresh-questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ article_id: item.id }),
      })
      const newQuestions = await res.json()
      if (Array.isArray(newQuestions?.en) && newQuestions.en.length > 0) {
        setLocalQuestions(newQuestions)
      } else {
        console.error('refresh-questions bad response:', newQuestions)
      }
    } catch (e) {
      console.error('handleRefresh error:', e)
    }
    setRefreshing(false)
  }

  return (
    <View style={[styles.card, isExpanded && styles.cardExpanded, isHovered && styles.cardHovered]}>
      {/* Header row: source label + fire badge */}
      <View style={styles.cardHeaderRow}>
        <Text style={styles.sourceLabel} numberOfLines={2}>{sourceLabel}</Text>
        <View style={styles.cardHeaderRight}>
          {item.engagement?.likes != null && item.engagement.likes > 0 && (
            <View style={styles.engagementPill}>
              <Text style={styles.engagementText}>🔥 {fmtNum(item.engagement.likes)}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Title row: title (tap/hover) + questions pill when expanded */}
      <View style={styles.titleRow}>
        <Pressable
          onPress={() => setIsExpanded(v => !v)}
          onHoverIn={() => setIsHovered(true)}
          onHoverOut={() => setIsHovered(false)}
          style={{ flex: 1 }}
        >
          <Text style={styles.title}>{displayTitle}</Text>
        </Pressable>
        {isExpanded && (
          localQuestions ? (
            <TouchableOpacity onPress={() => setQuestionsOpen(v => !v)} style={[styles.questionsPill, { marginLeft: 8, alignSelf: 'flex-start' }]}>
              <Text style={styles.questionsPillText}>{questionsOpen ? '✕ Close' : '? Questions'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={handleRefresh} disabled={refreshing} style={[styles.noQuestionsPill, { marginLeft: 8, alignSelf: 'flex-start' }]}>
              <Text style={styles.noQuestionsText}>{refreshing ? '…' : '↻'}</Text>
            </TouchableOpacity>
          )
        )}
      </View>

      {/* Expanded content: summary + read more */}
      {isExpanded && (
        <>
          {/* Summary — tap to collapse */}
          <TouchableOpacity onPress={() => setIsExpanded(false)} activeOpacity={1}>
            <View style={{ marginTop: 6, marginBottom: 6 }}>
              {displaySummary.split('\n').filter((l: string) => l.trim()).map((line: string, i: number) => (
                <MarkdownText key={i} text={line} style={styles.summary} />
              ))}
            </View>
          </TouchableOpacity>

          {/* Read more */}
          <TouchableOpacity onPress={() => Linking.openURL(item.url)}>
            <Text style={styles.readMore}>Read more →</Text>
          </TouchableOpacity>

          {/* Questions section */}
          {questionsOpen && localQuestions && (
            <View style={styles.questionsSection}>
              <View style={styles.questionsDivider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>Questions</Text>
                <TouchableOpacity onPress={handleRefresh} disabled={refreshing}>
                  <Text style={[styles.refreshIcon, refreshing && styles.refreshDisabled]}>↻</Text>
                </TouchableOpacity>
                <View style={styles.dividerLine} />
              </View>

              {questions.map((q, i) => {
                const ans = answers[i]
                return (
                  <View key={i}>
                    <TouchableOpacity onPress={() => handleAsk(i, q)} style={styles.questionRow}>
                      <Text style={styles.questionText}>Q: {q}</Text>
                    </TouchableOpacity>

                    {ans && (
                      <View style={styles.answerBlock}>
                        {ans.streaming && !ans.content && (
                          <View style={styles.thinkingBlock}>
                            <Text style={styles.thinkingText}>
                              {ans.thinking.length > 0 ? ans.thinking : 'Thinking...'}
                            </Text>
                          </View>
                        )}

                        {ans.thinking.length > 0 && ans.thinkingDone && (
                          <TouchableOpacity
                            onPress={() => setThinkingExpanded(prev => ({ ...prev, [i]: !prev[i] }))}
                            style={styles.thinkingHeader}
                          >
                            <Text style={styles.thinkingHeaderText}>
                              {thinkingExpanded[i] ? 'Thought process ▲' : 'Thought process ▼'}
                            </Text>
                          </TouchableOpacity>
                        )}
                        {ans.thinking.length > 0 && ans.thinkingDone && thinkingExpanded[i] && (
                          <View style={styles.thinkingBlock}>
                            <Text style={styles.thinkingText}>{ans.thinking}</Text>
                          </View>
                        )}

                        {ans.content.length > 0 && (
                          <View style={styles.contentBlock}>
                            {(ans.streaming ? ans.content + ' ▌' : ans.content)
                              .split('\n')
                              .filter((l: string) => l.trim())
                              .map((line: string, j: number) => (
                                <MarkdownText key={j} text={line} style={styles.contentText} />
                              ))}
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                )
              })}
            </View>
          )}
        </>
      )}
    </View>
  )
}

export default function App() {
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [lang, setLang] = useState<'en' | 'zh'>('en')
  const [sourceMap, setSourceMap] = useState<Record<string, string>>({})
  const [bioMap, setBioMap] = useState<Record<string, string>>({})
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const [activeCategory, setActiveCategory] = useState<'all' | 'industry' | 'technical_frontier' | 'career_community'>('all')
  const listRef = useRef<FlatList>(null)
  const scrollOffsetRef = useRef(0)
  const contentHeightRef = useRef<{ en: number; zh: number }>({ en: 0, zh: 0 })
  const pendingProportionRef = useRef<number | null>(null)
  const langRef = useRef(lang)
  useEffect(() => { langRef.current = lang }, [lang])

  useEffect(() => {
    supabase
      .from('sources')
      .select('id, name, metadata, category')
      .then(({ data }) => {
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

  useEffect(() => {
    supabase
      .from('daily_news')
      .select('*', { count: 'exact', head: true })
      .then(({ count }) => {
        if (count) setTotalPages(Math.ceil(count / PAGE_SIZE))
      })
  }, [])

  useEffect(() => {
    setLoading(true)
    supabase
      .from('daily_news')
      .select('id, source_id, title, summary, title_en, summary_en, title_zh, summary_zh, url, created_at, questions, engagement')
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .then(({ data, error }) => {
        if (error) console.error(error)
        else setArticles(data as unknown as Article[])
        setLoading(false)
        listRef.current?.scrollToOffset({ offset: 0, animated: false })
      })
  }, [page])

  const goTo = (p: number) => {
    if (p < 0 || p >= totalPages) return
    setPage(p)
  }

  const handleCategoryChange = (cat: typeof activeCategory) => {
    setActiveCategory(cat)
    setPage(0)
  }

  const displayArticles = activeCategory === 'all'
    ? articles
    : articles.filter(a => categoryMap[a.source_id] === activeCategory)

  const pageNumbers = () => {
    const pages = []
    const start = Math.max(0, page - 2)
    const end = Math.min(totalPages - 1, page + 2)
    for (let i = start; i <= end; i++) pages.push(i)
    return pages
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Daily Feed</Text>
        <View style={styles.langToggle}>
          <TouchableOpacity
            onPress={() => {
              if (lang === 'en') return
              const h = contentHeightRef.current.zh
              pendingProportionRef.current = h > 0 ? scrollOffsetRef.current / h : 0
              setLang('en')
            }}
            style={[styles.langBtn, lang === 'en' && styles.langBtnActive]}
          >
            <Text style={[styles.langBtnText, lang === 'en' && styles.langBtnTextActive]}>EN</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              if (lang === 'zh') return
              const h = contentHeightRef.current.en
              pendingProportionRef.current = h > 0 ? scrollOffsetRef.current / h : 0
              setLang('zh')
            }}
            style={[styles.langBtn, lang === 'zh' && styles.langBtnActive]}
          >
            <Text style={[styles.langBtnText, lang === 'zh' && styles.langBtnTextActive]}>中</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.categoryBar}>
        {([
          ['all',                'All'],
          ['industry',           'Industry'],
          ['technical_frontier', 'Frontier'],
          ['career_community',   'Career'],
        ] as const).map(([key, label]) => (
          <TouchableOpacity
            key={key}
            onPress={() => handleCategoryChange(key)}
            style={[styles.categoryTab, activeCategory === key && styles.categoryTabActive]}
          >
            <Text style={[styles.categoryTabText, activeCategory === key && styles.categoryTabTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {loading
        ? <ActivityIndicator style={{ flex: 1 }} color="#1A1A1A" />
        : <FlatList
            ref={listRef}
            data={displayArticles}
            extraData={[sourceMap, categoryMap, lang, activeCategory]}
            keyExtractor={item => item.id}
            onScroll={({ nativeEvent }) => { scrollOffsetRef.current = nativeEvent.contentOffset.y }}
            scrollEventThrottle={16}
            onContentSizeChange={(_, h) => {
              contentHeightRef.current[langRef.current] = h
              if (pendingProportionRef.current !== null) {
                const targetOffset = pendingProportionRef.current * h
                pendingProportionRef.current = null
                listRef.current?.scrollToOffset({ offset: targetOffset, animated: false })
              }
            }}
            renderItem={({ item }) => (
              <ArticleCard item={item} lang={lang} sourceMap={sourceMap} bioMap={bioMap} />
            )}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>No articles yet.</Text>
                <Text style={styles.emptyStateSubtext}>Check back after the next ingest cycle.</Text>
              </View>
            }
            ListFooterComponent={
              <View style={styles.pagination}>
                <TouchableOpacity onPress={() => goTo(page - 1)} disabled={page === 0} style={[styles.pageBtn, page === 0 && styles.pageBtnDisabled]}>
                  <Text style={styles.pageBtnText}>‹</Text>
                </TouchableOpacity>
                {pageNumbers().map(p => (
                  <TouchableOpacity key={p} onPress={() => goTo(p)} style={[styles.pageBtn, p === page && styles.pageBtnActive]}>
                    <Text style={[styles.pageBtnText, p === page && styles.pageBtnTextActive]}>{p + 1}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={() => goTo(page + 1)} disabled={page === totalPages - 1} style={[styles.pageBtn, page === totalPages - 1 && styles.pageBtnDisabled]}>
                  <Text style={styles.pageBtnText}>›</Text>
                </TouchableOpacity>
              </View>
            }
          />
      }
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container:            { flex: 1, backgroundColor: '#F7F6F2' },
  headerRow:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  header:               { fontSize: 22, fontWeight: '800', color: '#1A1A1A', letterSpacing: -0.5 },
  langToggle:           { flexDirection: 'row', borderRadius: 8, borderWidth: 1, borderColor: '#E0DDD6', overflow: 'hidden' },
  langBtn:              { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  langBtnActive:        { backgroundColor: '#1A1A1A' },
  langBtnText:          { fontSize: 13, color: '#6B6560', fontWeight: '500' },
  langBtnTextActive:    { color: '#fff', fontWeight: '600' },
  card:                 { backgroundColor: '#fff', marginHorizontal: 12, marginVertical: 6, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: '#E0DDD6' },
  cardExpanded:         { backgroundColor: '#F0EDE8' },
  cardHovered:          { backgroundColor: '#EAE7E2' },
  cardHeaderRow:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  cardHeaderRight:      { flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginLeft: 8 },
  titleRow:             { flexDirection: 'row', alignItems: 'flex-start' },
  sourceLabel:          { fontSize: 11, color: '#9E9690', fontWeight: '500', letterSpacing: 0.3, marginTop: 2, flex: 1 },
  engagementPill:       { backgroundColor: '#FFF3E0', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  engagementPillHN:     { backgroundColor: '#FFF8E1' },
  engagementText:       { fontSize: 11, fontWeight: '600', color: '#E65100' },
  engagementTextHN:     { color: '#FF6F00' },
  expandChevron:        { fontSize: 12, color: '#9E9690', marginLeft: 6 },
  questionsPillRow:     { flexDirection: 'row' as const, marginTop: 10 },
  questionsPill:        { backgroundColor: '#1A1A1A', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  questionsPillText:    { fontSize: 12, color: '#fff', fontWeight: '600' },
  noQuestionsPill:      { borderWidth: 1, borderColor: '#E0DDD6', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  noQuestionsText:      { fontSize: 13, color: '#9E9690' },
  title:                { fontSize: 18, fontWeight: '700', color: '#1A1A1A', letterSpacing: -0.3, marginBottom: 10 },
  summary:              { fontSize: 14, color: '#3D3935', lineHeight: 22 },
  readMore:             { fontSize: 12, color: '#6B6560', fontWeight: '500', marginTop: 10 },
  questionsSection:     { marginTop: 14 },
  questionsDivider:     { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  dividerLine:          { flex: 1, height: 1, backgroundColor: '#E0DDD6' },
  dividerText:          { fontSize: 11, color: '#9E9690', fontWeight: '600', letterSpacing: 0.5 },
  refreshIcon:          { fontSize: 16, color: '#1A1A1A' },
  refreshDisabled:      { fontSize: 16, color: '#C8C4BE' },
  questionRow:          { paddingVertical: 8 },
  questionText:         { fontSize: 14, color: '#3D3935', lineHeight: 20 },
  answerBlock:          { marginBottom: 8 },
  thinkingHeader:       { paddingVertical: 4 },
  thinkingHeaderText:   { fontSize: 12, color: '#9E9690', fontStyle: 'italic' },
  thinkingBlock:        { backgroundColor: '#F0EDE8', borderRadius: 8, padding: 10, marginTop: 4 },
  thinkingText:         { fontSize: 12, color: '#9E9690', fontStyle: 'italic', lineHeight: 18 },
  contentBlock:         { backgroundColor: '#F0EDE8', borderRadius: 8, padding: 12, marginTop: 6 },
  contentText:          { fontSize: 14, color: '#3D3935', lineHeight: 22 },
  emptyState:           { alignItems: 'center', justifyContent: 'center', padding: 48 },
  emptyStateText:       { fontSize: 16, fontWeight: '600', color: '#1A1A1A', marginBottom: 6 },
  emptyStateSubtext:    { fontSize: 14, color: '#9E9690', textAlign: 'center' },
  pagination:           { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', padding: 16, gap: 8 },
  pageBtn:              { width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#E0DDD6' },
  pageBtnActive:        { backgroundColor: '#1A1A1A', borderColor: '#1A1A1A' },
  pageBtnDisabled:      { opacity: 0.3 },
  pageBtnText:          { fontSize: 16, color: '#3D3935' },
  pageBtnTextActive:    { color: '#fff', fontWeight: '600' },
  categoryBar:          { flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 10, gap: 6 },
  categoryTab:          { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 16, borderWidth: 1, borderColor: '#E0DDD6', backgroundColor: '#fff' },
  categoryTabActive:    { backgroundColor: '#1A1A1A', borderColor: '#1A1A1A' },
  categoryTabText:      { fontSize: 12, color: '#6B6560', fontWeight: '500' },
  categoryTabTextActive: { color: '#fff', fontWeight: '600' },
})
