import { useEffect, useRef, useState } from 'react'
import { FlatList, Text, StyleSheet, ActivityIndicator, SafeAreaView, TouchableOpacity, Linking, View } from 'react-native'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
)

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
const PAGE_SIZE = 20

function BoldText({ text, style }: { text: string; style?: object }) {
  const parts = text.split(/\*\*([^*]+)\*\*/)
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <Text key={i} style={{ fontWeight: 'bold' }}>{part}</Text>
          : part
      )}
    </Text>
  )
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

  async function handleAsk(index: number, question: string) {
    // Toggle off if already answered and not streaming
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
      // Stream ended without [DONE] — mark as done
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
    <View style={styles.card}>
      {/* Header row: source label + engagement badge + questions pill */}
      <View style={styles.cardHeaderRow}>
        <Text style={styles.sourceLabel} numberOfLines={2}>{sourceLabel}</Text>
        <View style={styles.cardHeaderRight}>
          {item.engagement?.likes != null && item.engagement.likes > 0 && (
            <View style={styles.engagementPill}>
              <Text style={styles.engagementText}>🔥 {fmtNum(item.engagement.likes)}</Text>
            </View>
          )}
          {item.engagement?.hn_score != null && item.engagement.hn_score > 0 && (
            <View style={[styles.engagementPill, styles.engagementPillHN]}>
              <Text style={[styles.engagementText, styles.engagementTextHN]}>▲ {fmtNum(item.engagement.hn_score)}</Text>
            </View>
          )}
          {localQuestions && (
            <TouchableOpacity onPress={() => setQuestionsOpen(v => !v)} style={styles.questionsPill}>
              <Text style={styles.questionsPillText}>{questionsOpen ? '✕ Close' : '? 3 Questions'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Title */}
      <Text style={styles.title}>{displayTitle}</Text>

      {/* Summary */}
      <View style={{ marginBottom: 4 }}>
        {displaySummary.split('\n').filter((l: string) => l.trim()).map((line: string, i: number) => (
          <BoldText key={i} text={line} style={styles.summary} />
        ))}
      </View>

      {/* Read more — only this opens the URL */}
      <TouchableOpacity onPress={() => Linking.openURL(item.url)}>
        <Text style={styles.readMore}>Read more →</Text>
      </TouchableOpacity>

      {/* Questions section */}
      {questionsOpen && localQuestions && (
        <View style={styles.questionsSection}>
          {/* Divider + refresh */}
          <View style={styles.questionsDivider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>Questions</Text>
            <TouchableOpacity onPress={handleRefresh} disabled={refreshing}>
              <Text style={[styles.refreshIcon, refreshing && styles.refreshDisabled]}>↻</Text>
            </TouchableOpacity>
            <View style={styles.dividerLine} />
          </View>

          {/* Question rows */}
          {questions.map((q, i) => {
            const ans = answers[i]
            return (
              <View key={i}>
                <TouchableOpacity onPress={() => handleAsk(i, q)} style={styles.questionRow}>
                  <Text style={styles.questionText}>Q: {q}</Text>
                </TouchableOpacity>

                {ans && (
                  <View style={styles.answerBlock}>
                    {/* Thinking block — show while streaming and no content yet */}
                    {ans.streaming && !ans.content && (
                      <View style={styles.thinkingBlock}>
                        <Text style={styles.thinkingText}>
                          {ans.thinking.length > 0 ? ans.thinking : 'Thinking...'}
                        </Text>
                      </View>
                    )}

                    {/* Thought process accordion — show after content arrives if there was thinking */}
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

                    {/* Answer content */}
                    {ans.content.length > 0 && (
                      <View style={styles.contentBlock}>
                        <Text style={styles.contentText}>
                          {ans.content}{ans.streaming ? ' ▌' : ''}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            )
          })}
        </View>
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
  const listRef = useRef<FlatList>(null)

  useEffect(() => {
    supabase
      .from('sources')
      .select('id, name, metadata')
      .then(({ data }) => {
        if (data) {
          const sMap: Record<string, string> = {}
          const bMap: Record<string, string> = {}
          data.forEach((s: { id: string; name: string; metadata?: { bio_map?: Record<string, string> } }) => {
            sMap[s.id] = s.name
            if (s.metadata?.bio_map) Object.assign(bMap, s.metadata.bio_map)
          })
          setSourceMap(sMap)
          setBioMap(bMap)
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
        <Text style={styles.header}>News Feed</Text>
        <View style={styles.langToggle}>
          <TouchableOpacity
            onPress={() => setLang('en')}
            style={[styles.langBtn, lang === 'en' && styles.langBtnActive]}
          >
            <Text style={[styles.langBtnText, lang === 'en' && styles.langBtnTextActive]}>EN</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setLang('zh')}
            style={[styles.langBtn, lang === 'zh' && styles.langBtnActive]}
          >
            <Text style={[styles.langBtnText, lang === 'zh' && styles.langBtnTextActive]}>中</Text>
          </TouchableOpacity>
        </View>
      </View>
      {loading
        ? <ActivityIndicator style={{ flex: 1 }} />
        : <FlatList
            ref={listRef}
            data={articles}
            extraData={[sourceMap, lang]}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <ArticleCard item={item} lang={lang} sourceMap={sourceMap} bioMap={bioMap} />
            )}
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
  container:            { flex: 1, backgroundColor: '#f5f5f5' },
  headerRow:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  header:               { fontSize: 24, fontWeight: 'bold' },
  langToggle:           { flexDirection: 'row', borderRadius: 8, borderWidth: 1, borderColor: '#ddd', overflow: 'hidden' },
  langBtn:              { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  langBtnActive:        { backgroundColor: '#007AFF' },
  langBtnText:          { fontSize: 14, color: '#333', fontWeight: '500' },
  langBtnTextActive:    { color: '#fff', fontWeight: '600' },
  card:                 { backgroundColor: '#fff', margin: 8, padding: 16, borderRadius: 8 },
  cardHeaderRow:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  cardHeaderRight:      { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 8 },
  sourceLabel:          { fontSize: 12, color: '#aaa', marginTop: 2, flex: 1 },
  engagementPill:       { backgroundColor: '#FFF3E0', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  engagementPillHN:     { backgroundColor: '#FFF8E1' },
  engagementText:       { fontSize: 11, fontWeight: '600', color: '#E65100' },
  engagementTextHN:     { color: '#FF6F00' },
  questionsPill:        { backgroundColor: '#f0f0f0', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  questionsPillText:    { fontSize: 12, color: '#555', fontWeight: '500' },
  source:               { fontSize: 12, color: '#888', marginBottom: 4 },
  title:                { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  summary:              { fontSize: 14, color: '#333', lineHeight: 20 },
  readMore:             { fontSize: 12, color: '#007AFF', marginTop: 8 },
  questionsSection:     { marginTop: 12 },
  questionsDivider:     { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  dividerLine:          { flex: 1, height: 1, backgroundColor: '#eee' },
  dividerText:          { fontSize: 12, color: '#999', fontWeight: '500' },
  refreshIcon:          { fontSize: 16, color: '#007AFF' },
  refreshDisabled:      { fontSize: 16, color: '#ccc' },
  questionRow:          { paddingVertical: 8 },
  questionText:         { fontSize: 14, color: '#333', lineHeight: 20 },
  answerBlock:          { marginBottom: 8 },
  thinkingHeader:       { paddingVertical: 4 },
  thinkingHeaderText:   { fontSize: 12, color: '#999', fontStyle: 'italic' },
  thinkingBlock:        { backgroundColor: '#f8f8f8', borderRadius: 6, padding: 10, marginTop: 4 },
  thinkingText:         { fontSize: 12, color: '#999', fontStyle: 'italic', lineHeight: 18 },
  contentBlock:         { backgroundColor: '#f0f4ff', borderRadius: 6, padding: 10, marginTop: 6 },
  contentText:          { fontSize: 14, color: '#1a1a2e', lineHeight: 22 },
  pagination:           { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', padding: 16, gap: 8 },
  pageBtn:              { width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#ddd' },
  pageBtnActive:        { backgroundColor: '#007AFF', borderColor: '#007AFF' },
  pageBtnDisabled:      { opacity: 0.3 },
  pageBtnText:          { fontSize: 16, color: '#333' },
  pageBtnTextActive:    { color: '#fff', fontWeight: '600' },
})
