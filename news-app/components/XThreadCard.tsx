import { useEffect, useRef, useState } from 'react'
import {
  Linking, Pressable, StyleSheet, Text, TouchableOpacity, View, Animated, Easing
} from 'react-native'
import { Article, AnswerState, SUPABASE_URL, SUPABASE_ANON_KEY, FIRE_SVG, fmtNum, formatPublishedDate, supabase } from '../lib/config'
import AnswerFeedback from './AnswerFeedback'
import WebHTML from './WebHTML'
import MarkdownText from './MarkdownText'
import ThinkingIndicator from './ThinkingIndicator'

export interface XThreadGroup {
  handle: string
  bio?: string
  tweets: Article[]   // sorted by likes desc (most viral first)
}

// ── Individual tweet row — owns its own hover state ───────────────────────────
function TweetRow({
  tweet,
  lang,
  isTop,
  isLast,
  isCardExpanded,
  showFire,
  onToggle,
  deepThink,
  onDeepThinkChange,
}: {
  tweet: Article
  lang: 'en' | 'zh'
  isTop: boolean
  isLast: boolean
  isCardExpanded: boolean
  showFire: boolean
  onToggle: () => void
  deepThink: boolean
  onDeepThinkChange: (v: boolean) => void
}) {
  const [hovered, setHovered] = useState(false)
  const innerPressed = useRef(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({})
  const [localQuestions, setLocalQuestions] = useState(tweet.questions)
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<number, boolean>>({})
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

  const title = (lang === 'en' ? tweet.title_en : tweet.title_zh) || tweet.title || ''
  const summary = (lang === 'en' ? tweet.summary_en : tweet.summary_zh) || tweet.summary || ''
  const likes = tweet.engagement?.likes ?? 0
  const questions = localQuestions ? (lang === 'en' ? localQuestions.en : localQuestions.zh) : []

  useEffect(() => { setAnswers({}) }, [lang])
  useEffect(() => { if (!isCardExpanded) setQuestionsOpen(false) }, [isCardExpanded])

  async function handleAsk(index: number, question: string, forceRefresh = false) {
    if (!forceRefresh && answers[index]?.content && !answers[index]?.streaming) {
      setAnswers(prev => { const next = { ...prev }; delete next[index]; return next })
      return
    }
    setAnswers(prev => ({ ...prev, [index]: { thinking: '', content: '', thinkingDone: false, streaming: true, qaLogId: null } }))
    try {
      // Spec C: pass user JWT so the Edge Function can attribute the qa_log row.
      const { data: { session } } = await supabase.auth.getSession()
      const accessToken = session?.access_token ?? SUPABASE_ANON_KEY
      const res = await fetch(`${SUPABASE_URL}/functions/v1/answer-question`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ article_id: tweet.id, question, lang, deep_think: deepThink }),
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
        body: JSON.stringify({ article_id: tweet.id }),
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
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() => { if (!innerPressed.current) onToggle(); innerPressed.current = false }}
      style={[
        styles.tweetRow,
        !isTop && !isLast && styles.tweetRowBorder,
        hovered && styles.tweetRowHovered,
      ]}
    >
      {/* Title + fire/questions pill (only when showFire / expanded) */}
      <View style={styles.tweetRowHeader}>
        <Text style={styles.tweetTitle}>{title}</Text>
        {showFire && likes > 0 && (
          <View style={styles.engagementPill}>
            <WebHTML
              html={`<div style="width:15px;height:15px;line-height:0;">${FIRE_SVG}</div>`}
              style={{ width: 15, height: 15 }}
            />
            <Text style={styles.engagementText}>{fmtNum(likes)}</Text>
          </View>
        )}
        {isCardExpanded && (
          localQuestions ? (
            <TouchableOpacity onPress={() => { innerPressed.current = true; setQuestionsOpen(v => !v) }} style={styles.questionsPill}>
              <Text style={styles.questionsPillText}>{questionsOpen ? (lang === 'en' ? '✕ Close' : '✕ 关闭') : (lang === 'en' ? '? Questions' : '? 提问')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => { innerPressed.current = true; handleRefresh() }} disabled={refreshing} style={styles.noQuestionsPill}>
              <Text style={styles.noQuestionsText}>{refreshing ? '…' : '↻'}</Text>
            </TouchableOpacity>
          )
        )}
      </View>

      {/* Date */}
      {!!tweet.published_at && (
        <Text style={styles.tweetDate}>{formatPublishedDate(tweet.published_at, lang)}</Text>
      )}

      {/* Analysis — shown when card is expanded */}
      {isCardExpanded && !!summary && (
        <View style={styles.summaryBlock}>
          {summary.split('\n').filter((l: string) => l.trim()).map((line: string, i: number) => (
            <MarkdownText key={i} text={line} style={styles.summary} />
          ))}
        </View>
      )}

      {/* Link — only navigation point */}
      {isCardExpanded && (
        <TouchableOpacity
          onPress={() => { innerPressed.current = true; Linking.openURL(tweet.url) }}
          style={styles.viewLink}
        >
          <Text style={styles.viewLinkText}>
            {lang === 'en' ? 'View on X →' : '在 X 上查看 →'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Questions Section */}
      {isCardExpanded && questionsOpen && localQuestions && (
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
              onPress={() => { innerPressed.current = true; onDeepThinkChange(!deepThink) }}
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
                      <AnswerFeedback qaLogId={ans.qaLogId} lang={lang} onRefresh={() => { innerPressed.current = true; handleAsk(i, q, true) }} copyText={ans.content} />
                    )}
                  </View>
                )}
              </View>
            )
          })}
        </View>
      )}
    </Pressable>
  )
}

// ── Thread card shell ─────────────────────────────────────────────────────────
export default function XThreadCard({
  group,
  lang,
  isExpanded,
  onExpandedChange,
  deepThink,
  onDeepThinkChange,
}: {
  group: XThreadGroup
  lang: 'en' | 'zh'
  isExpanded: boolean
  onExpandedChange: (v: boolean) => void
  deepThink: boolean
  onDeepThinkChange: (v: boolean) => void
}) {
  const top = group.tweets[0]
  const rest = group.tweets.slice(1)
  const isMultiple = group.tweets.length > 1
  const totalLikes = group.tweets.reduce((sum, t) => sum + (t.engagement?.likes ?? 0), 0)
  const sourceLabel = `X - @${group.handle}${group.bio ? ` - ${group.bio}` : ''}`

  return (
    <View style={[styles.card, isExpanded && styles.cardExpanded]}>

      {/* Header — click to expand/collapse */}
      <Pressable onPress={() => onExpandedChange(!isExpanded)} style={styles.headerRow}>
        <Text style={styles.sourceLabel} numberOfLines={2}>{sourceLabel}</Text>
        <View style={styles.headerRight}>
          {totalLikes > 0 && (
            <View style={styles.engagementPill}>
              <WebHTML
                html={`<div style="width:15px;height:15px;line-height:0;">${FIRE_SVG}</div>`}
                style={{ width: 15, height: 15 }}
              />
              <Text style={styles.engagementText}>{fmtNum(totalLikes)}</Text>
            </View>
          )}
          <View style={styles.countPill}>
            <Text style={styles.countText}>
              {group.tweets.length} {lang === 'en' ? 'tweets' : '条'}
            </Text>
          </View>
        </View>
      </Pressable>

      {/* Top tweet — always visible */}
      <TweetRow
        tweet={top}
        lang={lang}
        isTop={true}
        isLast={rest.length === 0}
        isCardExpanded={isExpanded}
        showFire={isMultiple}
        onToggle={() => onExpandedChange(!isExpanded)}
        deepThink={deepThink}
        onDeepThinkChange={onDeepThinkChange}
      />

      {/* Collapsed hint */}
      {!isExpanded && rest.length > 0 && (
        <Pressable onPress={() => onExpandedChange(true)}>
          <Text style={styles.collapsedHint}>
            {lang === 'en' ? `+${rest.length} more tweets ▾` : `+${rest.length} 条推文 ▾`}
          </Text>
        </Pressable>
      )}

      {/* Rest of tweets — only when expanded */}
      {isExpanded && rest.length > 0 && (
        <View style={styles.threadList}>
          <View style={styles.divider} />
          {rest.map((tweet, i) => (
            <TweetRow
              key={tweet.id}
              tweet={tweet}
              lang={lang}
              isTop={false}
              isLast={i === rest.length - 1}
              isCardExpanded={isExpanded}
              showFire={isMultiple}
              onToggle={() => onExpandedChange(!isExpanded)}
              deepThink={deepThink}
              onDeepThinkChange={onDeepThinkChange}
            />
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff', marginVertical: 6, padding: 16,
    borderRadius: 12, borderWidth: 1, borderColor: '#f4f4f5',
  },
  cardExpanded: { backgroundColor: '#F0EDE8' },

  headerRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 10,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 8 },
  sourceLabel: {
    fontSize: 12, fontWeight: '700', color: '#a1a1aa',
    letterSpacing: 2, fontFamily: 'Space Grotesk, sans-serif',
    textTransform: 'uppercase', flex: 1,
    transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },

  engagementPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3,
  },
  engagementText: {
    fontSize: 12, fontWeight: '800', color: '#D84315',
    fontFamily: 'Space Grotesk, sans-serif', transform: [{ scale: 0.916 }],
  },
  countPill: {
    backgroundColor: '#1A1A1A', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3,
  },
  countText: {
    fontSize: 11, fontWeight: '700', color: '#fff',
    fontFamily: 'Space Grotesk, sans-serif',
  },

  // Individual tweet row
  tweetRow: {
    borderRadius: 8, padding: 8, marginHorizontal: -8,
  },
  tweetRowBorder: {
    borderBottomWidth: 1, borderBottomColor: '#E0DDD6',
    paddingBottom: 12, marginBottom: 4,
  },
  tweetRowHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },

  tweetRowHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 4,
  },
  tweetTitle: {
    flex: 1, fontSize: 16, fontWeight: '600', color: '#18181b',
    fontFamily: 'Manrope, sans-serif', letterSpacing: -0.2, lineHeight: 22,
  },
  tweetDate: {
    fontSize: 12, fontWeight: '700', color: '#a1a1aa',
    letterSpacing: 2, fontFamily: 'Space Grotesk, sans-serif',
    textTransform: 'uppercase', marginBottom: 6,
    transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },
  summaryBlock: { marginTop: 4, marginBottom: 6 },
  summary: { fontSize: 14, color: '#3D3935', lineHeight: 22 },
  viewLink: { marginTop: 4 },
  viewLinkText: { fontSize: 12, color: '#6B6560', fontWeight: '500' },

  collapsedHint: {
    fontSize: 12, color: '#9E9690', marginTop: 6,
    fontFamily: 'Space Grotesk, sans-serif',
  },

  divider: { height: 1, backgroundColor: '#E0DDD6', marginVertical: 10 },
  threadList: {},

  questionsPill: { backgroundColor: '#1A1A1A', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, marginLeft: 8 },
  questionsPillText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  noQuestionsPill: { backgroundColor: '#1A1A1A', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, marginLeft: 8 },
  noQuestionsText: { fontSize: 13, color: '#fff', fontWeight: '600' },
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
