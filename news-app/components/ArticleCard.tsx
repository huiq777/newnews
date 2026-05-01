import { useEffect, useRef, useState } from 'react'
import {
  Linking, Pressable, StyleSheet, Text, TouchableOpacity, View, Animated, Easing
} from 'react-native'
import {
  Article, AnswerState, SUPABASE_URL, SUPABASE_ANON_KEY,
  FIRE_SVG, formatPublishedDate, fmtNum, supabase,
} from '../lib/config'
import MarkdownText from './MarkdownText'
import WebHTML from './WebHTML'
import AnswerFeedback from './AnswerFeedback'
import ThinkingIndicator from './ThinkingIndicator'

export default function ArticleCard({
  item, lang, sourceMap, bioMap,
}: {
  item: Article
  lang: 'en' | 'zh'
  sourceMap: Record<string, string>
  bioMap: Record<string, string>
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const innerPressed = useRef(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({})
  const [localQuestions, setLocalQuestions] = useState(item.questions)
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<number, boolean>>({})
  const [deepThink, setDeepThink] = useState(false)
  const [hoverRefreshQuestions, setHoverRefreshQuestions] = useState(false)
  const spinAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (refreshing) {
      spinAnim.setValue(0)
      Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 500,
          easing: Easing.linear,
          useNativeDriver: false,
        })
      ).start()
    } else {
      spinAnim.stopAnimation()
      spinAnim.setValue(0)
    }
  }, [refreshing, spinAnim])

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg']
  })
  const [hoverDeepThink, setHoverDeepThink] = useState(false)

  const displayTitle = (lang === 'en' ? item.title_en : item.title_zh) || item.title
  const displaySummary = (lang === 'en' ? item.summary_en : item.summary_zh) || item.summary
  const sourceName = sourceMap[item.source_id] || 'Unknown Source'
  const isWechat = item.url?.includes('mp.weixin.qq.com')
  const isReddit = item.url?.includes('reddit.com') || sourceName?.toLowerCase().includes('reddit')
  const xHandle = item.url?.match(/x\.com\/([^/]+)\/status\//)?.[1]
  const xBio = xHandle ? bioMap[xHandle.toLowerCase()] : undefined
  const showName = item.engagement?.show_name?.trim()
  const sourceLabel = isWechat
    ? `${lang === 'zh' ? '公众号' : 'WeChat'} - ${sourceName}`
    : xHandle
      ? `X - @${xHandle}${xBio ? ` - ${xBio}` : ''}`
      : showName || sourceName
  const questions = localQuestions ? (lang === 'en' ? localQuestions.en : localQuestions.zh) : []

  useEffect(() => { setAnswers({}) }, [lang])
  useEffect(() => { if (!isExpanded) setQuestionsOpen(false) }, [isExpanded])

  async function handleAsk(index: number, question: string, forceRefresh = false) {
    if (!forceRefresh && answers[index]?.content && !answers[index]?.streaming) {
      setAnswers(prev => { const next = { ...prev }; delete next[index]; return next })
      return
    }
    setAnswers(prev => ({ ...prev, [index]: { thinking: '', content: '', thinkingDone: false, streaming: true, qaLogId: null } }))
    try {
      // Spec C: pass the user's session JWT (not the anon key) so the
      // Edge Function's auth.getUser() resolves to a real user and can
      // attribute the qa_log row. Falls back to anon key for the dev path
      // where no session exists (qa_log insert is skipped server-side).
      const { data: { session } } = await supabase.auth.getSession()
      const accessToken = session?.access_token ?? SUPABASE_ANON_KEY
      const res = await fetch(`${SUPABASE_URL}/functions/v1/answer-question`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ article_id: item.id, question, lang, deep_think: deepThink }),
      })
      if (!res.ok) {
        console.error('answer-question error:', await res.text())
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
              setAnswers(prev => ({ ...prev, [index]: { ...prev[index], thinking: prev[index].thinking + parsed.content } }))
            } else if (parsed.type === 'content') {
              setAnswers(prev => ({ ...prev, [index]: { ...prev[index], content: prev[index].content + parsed.content, thinkingDone: true } }))
            } else if (parsed.type === 'meta' && parsed.qa_log_id) {
              setAnswers(prev => ({ ...prev, [index]: { ...prev[index], qaLogId: parsed.qa_log_id } }))
            }
          } catch { }
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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ article_id: item.id }),
      })
      const newQuestions = await res.json()
      if (Array.isArray(newQuestions?.en) && newQuestions.en.length > 0) {
        setLocalQuestions(newQuestions)
      } else {
        console.error('refresh-questions bad response:', newQuestions)
      }
    } catch (e) { console.error('handleRefresh error:', e) }
    setRefreshing(false)
  }

  return (
    <Pressable
      onPress={() => { if (!innerPressed.current) setIsExpanded(v => !v); innerPressed.current = false }}
      onHoverIn={() => setIsHovered(true)}
      onHoverOut={() => setIsHovered(false)}
      style={[styles.card, isExpanded && styles.cardExpanded, isHovered && styles.cardHovered]}
    >
      {/* Source + engagement badge */}
      <View style={styles.cardHeaderRow}>
        <Text style={styles.sourceLabel} numberOfLines={2}>{sourceLabel}</Text>
        <View style={styles.cardHeaderRight}>
          {isReddit && ((item.engagement?.hn_score || 0) > 0 || (item.engagement?.likes || 0) > 0) ? (
            <View style={[styles.engagementPill, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
              <WebHTML
                html={`<i class="fa-brands fa-reddit" style="color: rgb(255, 203, 44); font-size: 12px; transform: scale(0.916); display: inline-block;"></i>`}
                style={{ width: 12, height: 12 }}
              />
              <Text style={styles.engagementText}>
                {fmtNum(item.engagement?.hn_score || item.engagement?.likes || 0)}
              </Text>
            </View>
          ) : (
            item.engagement?.likes != null && item.engagement!.likes > 0 && (
              <View style={[styles.engagementPill, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
                <WebHTML
                  html={`<div style="width:15px;height:15px;line-height:0;">${FIRE_SVG}</div>`}
                  style={{ width: 15, height: 15 }}
                />
                <Text style={styles.engagementText}>{fmtNum(item.engagement!.likes)}</Text>
              </View>
            )
          )}
          {item.engagement?.stars != null && item.engagement.stars > 0 && (
            <View style={[styles.engagementPill, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
              <WebHTML
                html={`<i class="fa-solid fa-star" style="color: rgb(255, 203, 44); font-size: 12px; transform: scale(0.916); display: inline-block;"></i>`}
                style={{ width: 12, height: 12 }}
              />
              <Text style={styles.engagementText}>{fmtNum(item.engagement.stars)}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Title + questions pill */}
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{displayTitle}</Text>
          {!!item.published_at && (
            <Text style={styles.publishedDate}>{formatPublishedDate(item.published_at, lang)}</Text>
          )}
        </View>
        {isExpanded && (
          localQuestions ? (
            <TouchableOpacity
              onPress={() => { innerPressed.current = true; setQuestionsOpen(v => !v) }}
              style={[styles.questionsPill, { marginLeft: 8, alignSelf: 'flex-start' }]}
            >
              <Text style={styles.questionsPillText}>{questionsOpen ? (lang === 'en' ? '✕ Close' : '✕ 关闭') : (lang === 'en' ? '? Questions' : '? 提问')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => { innerPressed.current = true; handleRefresh() }}
              disabled={refreshing}
              style={[styles.noQuestionsPill, { marginLeft: 8, alignSelf: 'flex-start' }]}
            >
              <Text style={styles.noQuestionsText}>{refreshing ? '…' : '↻'}</Text>
            </TouchableOpacity>
          )
        )}
      </View>

      {/* Expanded content */}
      {isExpanded && (
        <>
          <View style={{ marginTop: 6, marginBottom: 6 }}>
            {displaySummary.split('\n').filter((l: string) => l.trim()).map((line: string, i: number) => (
              <MarkdownText key={i} text={line} style={styles.summary} />
            ))}
          </View>

          <TouchableOpacity onPress={() => { innerPressed.current = true; Linking.openURL(item.url) }}>
            <Text style={styles.readMore}>{lang === 'en' ? 'Read more →' : '阅读全文 →'}</Text>
          </TouchableOpacity>

          {questionsOpen && localQuestions && (
            <View style={styles.questionsSection}>
              <View style={styles.questionsDivider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>{lang === 'en' ? 'Questions' : '问题'}</Text>
                <Pressable 
                  onPress={() => { innerPressed.current = true; handleRefresh() }} 
                  disabled={refreshing}
                  onHoverIn={() => setHoverRefreshQuestions(true)}
                  onHoverOut={() => setHoverRefreshQuestions(false)}
                >
                  <Animated.Text style={[
                    styles.refreshIcon, 
                    hoverRefreshQuestions && styles.refreshIconHovered,
                    refreshing && styles.refreshDisabled,
                    { transform: [{ rotate: spin }] }
                  ]}>↻</Animated.Text>
                </Pressable>
                <Pressable
                  onPress={() => { innerPressed.current = true; setDeepThink(prev => !prev) }}
                  onHoverIn={() => setHoverDeepThink(true)}
                  onHoverOut={() => setHoverDeepThink(false)}
                  style={[
                    styles.deepThinkToggle, 
                    hoverDeepThink && styles.deepThinkToggleHovered,
                    deepThink && styles.deepThinkToggleActive
                  ]}
                >
                  <Text style={[styles.deepThinkText, deepThink && styles.deepThinkTextActive]}>
                    {lang === 'en' ? 'Deep Think' : '深度思考'}
                  </Text>
                </Pressable>
                <View style={styles.dividerLine} />
              </View>

              {questions.map((q, i) => {
                const ans = answers[i]
                return (
                  <View key={i}>
                    <TouchableOpacity onPress={() => { innerPressed.current = true; handleAsk(i, q) }} style={styles.questionRow}>
                      <Text style={styles.questionText}>Q: {q}</Text>
                    </TouchableOpacity>
                    {ans && (
                      <View style={styles.answerBlock}>
                        {ans.streaming && !ans.content && (
                          <ThinkingIndicator lang={lang} thinkingContent={ans.thinking} />
                        )}
                        {ans.thinking.length > 0 && ans.thinkingDone && (
                          <TouchableOpacity
                            onPress={() => { innerPressed.current = true; setThinkingExpanded(prev => ({ ...prev, [i]: !prev[i] })) }}
                            style={styles.thinkingHeader}
                          >
                            <Text style={styles.thinkingHeaderText}>
                              {thinkingExpanded[i] ? (lang === 'en' ? 'Thought process ▲' : '思考过程 ▲') : (lang === 'en' ? 'Thought process ▼' : '思考过程 ▼')}
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
                              .split('\n').filter((l: string) => l.trim())
                              .map((line: string, j: number) => (
                                <MarkdownText key={j} text={line} style={styles.contentText} />
                              ))}
                          </View>
                        )}
                        {!ans.streaming && ans.qaLogId && (
                          <AnswerFeedback qaLogId={ans.qaLogId} lang={lang} onRefresh={() => { innerPressed.current = true; handleAsk(i, q, true) }} />
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
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff', marginVertical: 6, padding: 16,
    borderRadius: 12, borderWidth: 1, borderColor: '#f4f4f5'
  },
  cardExpanded: { backgroundColor: '#F0EDE8' },
  cardHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },
  cardHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 10
  },
  cardHeaderRight: { flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginLeft: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  sourceLabel: {
    fontSize: 12, fontWeight: '700', color: '#a1a1aa',
    letterSpacing: 2, fontFamily: 'Space Grotesk, sans-serif',
    textTransform: 'uppercase', flex: 1, transform: [{ scale: 0.833 }],
    transformOrigin: 'left' as any
  },
  publishedDate: {
    fontSize: 12, fontWeight: '700', color: '#a1a1aa',
    letterSpacing: 2, fontFamily: 'Space Grotesk, sans-serif',
    textTransform: 'uppercase', marginBottom: 0, marginTop: -2, transform: [{ scale: 0.833 }],
    transformOrigin: 'left' as any
  },
  engagementPill: { backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  engagementPillHN: { backgroundColor: '#FFF8E1' },
  engagementText: { fontSize: 12, fontWeight: '800', color: '#D84315', fontFamily: 'Space Grotesk, sans-serif', transform: [{ scale: 0.916 }] },
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
    lineHeight: 22, marginBottom: 10
  },
  summary: { fontSize: 14, color: '#3D3935', lineHeight: 22 },
  readMore: { fontSize: 12, color: '#6B6560', fontWeight: '500', marginTop: 10 },
  questionsSection: { marginTop: 14 },
  questionsDivider: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#E0DDD6' },
  dividerText: { fontSize: 12, color: '#9E9690', fontWeight: '600', letterSpacing: 0.5, transform: [{ scale: 0.916 }] },
  refreshIcon: { fontSize: 16, color: '#1A1A1A', transition: 'color 0.2s ease' },
  refreshIconHovered: { color: '#6B6B6B' },
  refreshDisabled: {
    opacity: 0.3,
  },
  deepThinkToggle: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#E0DDD6',
    marginLeft: 8,
    backgroundColor: 'transparent',
  },
  deepThinkToggleHovered: {
    backgroundColor: '#FAF9F7',
    borderColor: '#C8C4BE',
  },
  deepThinkToggleActive: {
    backgroundColor: '#1A1A1A',
    borderColor: '#1A1A1A',
  },
  deepThinkText: {
    fontSize: 11,
    color: '#6B6B6B',
    fontFamily: 'Manrope, sans-serif',
  },
  deepThinkTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
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
