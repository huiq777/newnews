import { useEffect, useRef, useState } from 'react'
import {
  Linking, Pressable, StyleSheet, Text, TouchableOpacity, View, Animated, Easing
} from 'react-native'
import { Article, AnswerState, SUPABASE_URL, SUPABASE_ANON_KEY, FIRE_SVG, fmtNum, formatPublishedDate, supabase } from '../lib/config'
import AnswerFeedback from './AnswerFeedback'
import WebHTML from './WebHTML'
import MarkdownText from './MarkdownText'
import ThinkingIndicator from './ThinkingIndicator'
import LoginRequiredInline from './LoginRequiredInline'
import { colors, typography, spacing, surfaces } from '../theme/tokens'

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
  isAuthed,
  onRequireAuth,
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
  isAuthed: boolean
  onRequireAuth: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const innerPressed = useRef(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({})
  const [localQuestions, setLocalQuestions] = useState(tweet.questions)
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<number, boolean>>({})
  const [hoverQuestionRows, setHoverQuestionRows] = useState<Record<number, boolean>>({})
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
  useEffect(() => { setLocalQuestions(tweet.questions) }, [tweet.questions])
  useEffect(() => { if (!isCardExpanded) setQuestionsOpen(false) }, [isCardExpanded])

  async function handleAsk(index: number, question: string, forceRefresh = false) {
    if (!isAuthed) {
      onRequireAuth()
      return
    }
    if (!forceRefresh && answers[index]?.content && !answers[index]?.streaming) {
      setAnswers(prev => { const next = { ...prev }; delete next[index]; return next })
      return
    }
    setAnswers(prev => ({ ...prev, [index]: { thinking: '', content: '', thinkingDone: false, streaming: true, qaLogId: null } }))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const accessToken = session?.access_token
      if (!accessToken) {
        onRequireAuth()
        setAnswers(prev => ({ ...prev, [index]: { ...prev[index], streaming: false } }))
        return
      }
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
    if (!isAuthed) {
      onRequireAuth()
      return
    }
    setRefreshing(true)
    setAnswers({})
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const accessToken = session?.access_token
      if (!accessToken) {
        onRequireAuth()
        setRefreshing(false)
        return
      }
      const res = await fetch(`${SUPABASE_URL}/functions/v1/refresh-questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'apikey': SUPABASE_ANON_KEY },
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
          !isAuthed ? (
            <TouchableOpacity onPress={() => { innerPressed.current = true; setQuestionsOpen(v => !v) }} style={styles.questionsPill}>
              <Text style={styles.questionsPillText}>{questionsOpen ? (lang === 'en' ? '✕ Close' : '✕ 关闭') : (lang === 'en' ? '? Questions' : '? 提问')}</Text>
            </TouchableOpacity>
          ) : localQuestions ? (
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
      {isCardExpanded && questionsOpen && !isAuthed && (
        <LoginRequiredInline
          lang={lang}
          message={lang === 'en' ? 'Please log in to ask questions about this thread.' : '请登录后提问这条动态串。'}
          onLoginPress={onRequireAuth}
        />
      )}

      {isCardExpanded && questionsOpen && isAuthed && localQuestions && (
        <View style={styles.questionsSection}>
          <View style={styles.questionsDivider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{lang === 'en' ? 'Questions' : '问题'}</Text>
            <Text style={styles.questionsHint}>
              {lang === 'en' ? 'Click a question to generate an answer' : '点击问题即可生成回答'}
            </Text>
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
                <Pressable
                  onPress={() => { innerPressed.current = true; handleAsk(i, q) }}
                  onHoverIn={() => setHoverQuestionRows(prev => ({ ...prev, [i]: true }))}
                  onHoverOut={() => setHoverQuestionRows(prev => ({ ...prev, [i]: false }))}
                  accessibilityRole="button"
                  style={[styles.questionRow, hoverQuestionRows[i] && styles.questionRowHovered]}
                >
                  <Text style={styles.questionText}>Q: {q}</Text>
                </Pressable>
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
  isAuthed,
  onRequireAuth,
}: {
  group: XThreadGroup
  lang: 'en' | 'zh'
  isExpanded: boolean
  onExpandedChange: (v: boolean) => void
  deepThink: boolean
  onDeepThinkChange: (v: boolean) => void
  isAuthed: boolean
  onRequireAuth: () => void
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
        isAuthed={isAuthed}
        onRequireAuth={onRequireAuth}
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
              isAuthed={isAuthed}
              onRequireAuth={onRequireAuth}
            />
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg.card, marginVertical: 6, padding: spacing[4],
    borderRadius: 12, borderWidth: 1, borderColor: colors.border.subtle,
  },
  cardExpanded: { backgroundColor: colors.bg.hover },

  headerRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 10,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: spacing[2] },
  sourceLabel: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.tertiary,
    letterSpacing: typography.tracking.wider, fontFamily: typography.family.body,
    textTransform: 'uppercase', flex: 1,
    transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },

  engagementPill: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[1],
    backgroundColor: colors.bg.card, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3,
  },
  engagementText: {
    fontSize: typography.size.base, fontWeight: typography.weight.extrabold, color: colors.brand.accent,
    fontFamily: typography.family.body, transform: [{ scale: 0.916 }],
  },
  countPill: {
    ...surfaces.pill, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3,
  },
  countText: {
    fontSize: 11, fontWeight: typography.weight.bold, color: colors.text.inverse,
    fontFamily: typography.family.body,
  },

  // Individual tweet row
  tweetRow: {
    borderRadius: spacing[2], padding: spacing[2], marginHorizontal: -8,
  },
  tweetRowBorder: {
    borderBottomWidth: 1, borderBottomColor: colors.border.warm,
    paddingBottom: spacing[3], marginBottom: spacing[1],
  },
  tweetRowHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },

  tweetRowHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2], marginBottom: spacing[1],
  },
  tweetTitle: {
    flex: 1, fontSize: typography.size.xl, fontWeight: typography.weight.semibold, color: colors.text.primary,
    fontFamily: typography.family.heading, letterSpacing: -0.2, lineHeight: typography.leading.relaxed,
  },
  tweetDate: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.tertiary,
    letterSpacing: typography.tracking.wider, fontFamily: typography.family.body,
    textTransform: 'uppercase', marginBottom: 6,
    transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },
  summaryBlock: { marginTop: spacing[1], marginBottom: 6 },
  summary: { fontSize: typography.size.lg, color: '#3D3935', lineHeight: typography.leading.relaxed },
  viewLink: { marginTop: spacing[1] },
  viewLinkText: { fontSize: typography.size.base, color: '#6B6560', fontWeight: typography.weight.medium },

  collapsedHint: {
    fontSize: typography.size.base, color: colors.text.muted, marginTop: 6,
    fontFamily: typography.family.body,
  },

  divider: { height: 1, backgroundColor: colors.border.warm, marginVertical: 10 },
  threadList: {},

  questionsPill: { ...surfaces.pill, borderRadius: 12, paddingHorizontal: 10, paddingVertical: spacing[1], marginLeft: spacing[2] },
  questionsPillText: { fontSize: typography.size.base, color: colors.text.inverse, fontWeight: typography.weight.semibold },
  noQuestionsPill: { ...surfaces.pill, borderRadius: 12, paddingHorizontal: spacing[2], paddingVertical: spacing[1], marginLeft: spacing[2] },
  noQuestionsText: { fontSize: typography.size.md, color: colors.text.inverse, fontWeight: typography.weight.semibold },
  questionsSection: { marginTop: 14 },
  questionsDivider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing[3], gap: spacing[2] },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border.warm },
  dividerText: { fontSize: typography.size.base, color: colors.text.muted, fontWeight: typography.weight.semibold, letterSpacing: 0.5, transform: [{ scale: 0.916 }] },
  refreshIcon: { fontSize: typography.size.xl, color: '#1A1A1A', transition: 'color 0.2s ease' } as any,
  refreshIconHovered: { color: '#6B6B6B' },
  refreshDisabled: {
    opacity: 0.3,
  },
  deepThinkToggle: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border.warm,
    marginLeft: spacing[2],
    backgroundColor: 'transparent',
  },
  deepThinkToggleHovered: {
    backgroundColor: '#FAF9F7',
    borderColor: colors.border.warmHover,
  },
  deepThinkToggleActive: {
    backgroundColor: '#1A1A1A',
    borderColor: '#1A1A1A',
  },
  deepThinkText: {
    fontSize: 11,
    color: '#6B6B6B',
    fontFamily: typography.family.heading,
  },
  deepThinkTextActive: {
    color: colors.text.inverse,
    fontWeight: typography.weight.semibold,
  },
  questionsHint: {
    fontSize: typography.size.base,
    color: colors.text.muted,
    lineHeight: typography.leading.normal,
    flexShrink: 1,
    maxWidth: 240,
  },
  questionRow: {
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[2],
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  questionRowHovered: {
    backgroundColor: '#FAF9F7',
    borderColor: colors.border.warm,
    transform: [{ translateX: 2 }],
  },
  questionText: { fontSize: typography.size.lg, color: '#3D3935', lineHeight: typography.leading.normal },
  answerBlock: { marginBottom: spacing[2] },
  thinkingHeader: { paddingVertical: spacing[1] },
  thinkingHeaderText: { fontSize: typography.size.base, color: colors.text.muted, fontStyle: 'italic' },
  thinkingBlock: { backgroundColor: colors.bg.hover, borderRadius: spacing[2], padding: 10, marginTop: spacing[1] },
  thinkingText: { fontSize: typography.size.base, color: colors.text.muted, fontStyle: 'italic', lineHeight: typography.leading.tight },
  contentBlock: { backgroundColor: colors.bg.hover, borderRadius: spacing[2], padding: spacing[3], marginTop: 6 },
  contentText: { fontSize: typography.size.lg, color: '#3D3935', lineHeight: typography.leading.relaxed },
})
