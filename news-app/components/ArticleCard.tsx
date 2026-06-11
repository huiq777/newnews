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
import LoginRequiredInline from './LoginRequiredInline'
import { colors, typography, spacing, surfaces } from '../theme/tokens'

export default function ArticleCard({
  item, lang, sourceMap, bioMap, deepThink, onDeepThinkChange, isAuthed, onRequireAuth,
}: {
  item: Article
  lang: 'en' | 'zh'
  sourceMap: Record<string, string>
  bioMap: Record<string, string>
  deepThink: boolean
  onDeepThinkChange: (v: boolean) => void
  isAuthed: boolean
  onRequireAuth: () => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const innerPressed = useRef(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({})
  const [localQuestions, setLocalQuestions] = useState(item.questions)
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<number, boolean>>({})
  const [hoverRefreshQuestions, setHoverRefreshQuestions] = useState(false)
  const [deepAnalysisOpen, setDeepAnalysisOpen] = useState(false)
  const [hoverDeepAnalysis, setHoverDeepAnalysis] = useState(false)
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

  const displayTitle = (lang === 'en' ? item.title_en : item.title_zh) ?? ''
  const displaySummary = (lang === 'en' ? item.summary_en : item.summary_zh) ?? ''
  const sourceName = item.source_name || sourceMap[item.source_id] || 'Unknown Source'
  const isWechat = item.url?.includes('mp.weixin.qq.com')
  const isYoutube = item.url?.includes('youtube.com') || item.url?.includes('youtu.be')
  const isReddit = item.url?.includes('reddit.com') || sourceName?.toLowerCase().includes('reddit')
  const xHandle = item.url?.match(/x\.com\/([^/]+)\/status\//)?.[1]
  const xBio = xHandle ? bioMap[xHandle.toLowerCase()] : undefined
  const showName = item.engagement?.show_name?.trim()
  const aihotSource = item.source_type === 'aihot' ? (item.metadata?.source as string | undefined) : undefined
  const sourceLabel = isWechat
    ? `${lang === 'zh' ? '公众号' : 'WeChat'} - ${sourceName}`
    : xHandle
      ? `X - @${xHandle}${xBio ? ` - ${xBio}` : ''}`
      : isYoutube
        ? `YouTube - ${showName || sourceName}`
        : aihotSource || showName || sourceName
  const questions = localQuestions ? (lang === 'en' ? localQuestions.en : localQuestions.zh) : []

  useEffect(() => { setAnswers({}) }, [lang])
  useEffect(() => { setLocalQuestions(item.questions) }, [item.questions])
  useEffect(() => { if (!isExpanded) { setQuestionsOpen(false); setDeepAnalysisOpen(false) } }, [isExpanded])

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
        body: JSON.stringify({ article_id: item.id, question, lang, deep_think: deepThink, force_refresh: forceRefresh }),
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
              setAnswers(prev => ({ ...prev, [index]: { ...prev[index], qaLogId: parsed.qa_log_id, feedback: parsed.feedback } }))
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
            <View style={[styles.engagementPill, { flexDirection: 'row', alignItems: 'center', gap: spacing[1] }]}>
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
              <View style={[styles.engagementPill, { flexDirection: 'row', alignItems: 'center', gap: spacing[1] }]}>
                <WebHTML
                  html={`<div style="width:15px;height:15px;line-height:0;">${FIRE_SVG}</div>`}
                  style={{ width: 15, height: 15 }}
                />
                <Text style={styles.engagementText}>{fmtNum(item.engagement!.likes)}</Text>
              </View>
            )
          )}
          {item.engagement?.stars != null && item.engagement.stars > 0 && (
            <View style={[styles.engagementPill, { flexDirection: 'row', alignItems: 'center', gap: spacing[1] }]}>
              <WebHTML
                html={`<i class="fa-solid fa-star" style="color: rgb(255, 203, 44); font-size: 12px; transform: scale(0.916); display: inline-block;"></i>`}
                style={{ width: 12, height: 12 }}
              />
              <Text style={styles.engagementText}>{fmtNum(item.engagement.stars)}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Title + analysis/questions pills */}
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{displayTitle}</Text>
          {!!item.published_at && (
            <Text style={styles.publishedDate}>{formatPublishedDate(item.published_at, lang)}</Text>
          )}
        </View>
        {isExpanded && (
          <View style={styles.titleActions}>
            <Pressable
              onPress={() => { innerPressed.current = true; setDeepAnalysisOpen(v => !v) }}
              onHoverIn={() => setHoverDeepAnalysis(true)}
              onHoverOut={() => setHoverDeepAnalysis(false)}
              style={[
                styles.deepAnalysisTab,
                hoverDeepAnalysis && styles.deepAnalysisTabHovered,
                deepAnalysisOpen && styles.deepAnalysisTabActive
              ]}
            >
              <Text style={[styles.deepAnalysisTabText, deepAnalysisOpen && styles.deepAnalysisTabTextActive]}>
                {lang === 'en' ? 'Deep Analysis' : '深度分析'}
              </Text>
            </Pressable>
            {!isAuthed ? (
              <TouchableOpacity
                onPress={() => { innerPressed.current = true; setQuestionsOpen(v => !v) }}
                style={styles.questionsPill}
              >
                <Text style={styles.questionsPillText}>{questionsOpen ? (lang === 'en' ? '✕ Close' : '✕ 关闭') : (lang === 'en' ? '? Questions' : '? 提问')}</Text>
              </TouchableOpacity>
            ) : localQuestions ? (
              <TouchableOpacity
                onPress={() => { innerPressed.current = true; setQuestionsOpen(v => !v) }}
                style={styles.questionsPill}
              >
                <Text style={styles.questionsPillText}>{questionsOpen ? (lang === 'en' ? '✕ Close' : '✕ 关闭') : (lang === 'en' ? '? Questions' : '? 提问')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={() => { innerPressed.current = true; handleRefresh() }}
                disabled={refreshing}
                style={styles.noQuestionsPill}
              >
                <Text style={styles.noQuestionsText}>{refreshing ? '…' : '↻'}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {/* Expanded content */}
      {isExpanded && (
        <>
          {deepAnalysisOpen && (
            <>
              {isAuthed ? (
                <DeepAnalysisSection item={item} lang={lang} />
              ) : (
                <LoginRequiredInline
                  lang={lang}
                  message={lang === 'en' ? 'Please log in to view Deep Analysis and Q&A.' : '请登录后查看深度分析和问答。'}
                  onLoginPress={onRequireAuth}
                />
              )}
              <View style={styles.analysisSummaryDivider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>{lang === 'en' ? 'Summary' : '摘要'}</Text>
                <View style={styles.dividerLine} />
              </View>
            </>
          )}

          <View style={{ marginTop: 6, marginBottom: 6 }}>
            {displaySummary.split('\n').filter((l: string) => l.trim()).map((line: string, i: number) => (
              <MarkdownText key={i} text={line} style={styles.summary} />
            ))}
          </View>

          <TouchableOpacity onPress={() => { innerPressed.current = true; Linking.openURL(item.url) }}>
            <Text style={styles.readMore}>{lang === 'en' ? 'Read more →' : '阅读全文 →'}</Text>
          </TouchableOpacity>

          {questionsOpen && !isAuthed && (
            <LoginRequiredInline
              lang={lang}
              message={lang === 'en' ? 'Please log in to view Deep Analysis and Q&A.' : '请登录后查看深度分析和问答。'}
              onLoginPress={onRequireAuth}
            />
          )}

          {questionsOpen && isAuthed && localQuestions && (
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
                          <AnswerFeedback qaLogId={ans.qaLogId} initialFeedback={ans.feedback} lang={lang} onRefresh={() => { innerPressed.current = true; handleAsk(i, q, true) }} copyText={ans.content} />
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

type DeepAnalysisFeedbackValue = -1 | 1 | null

function DeepAnalysisSection({ item, lang }: { item: Article; lang: 'en' | 'zh' }) {
  const status = item.deep_analysis_status
  const block = lang === 'zh' ? item.deep_analysis?.zh : item.deep_analysis?.en

  if (status === 'ready' && block) {
    const facts = Array.isArray(block.facts) ? block.facts : []
    const limitations = Array.isArray(block.limitations_or_uncertainties)
      ? block.limitations_or_uncertainties
      : []

    return (
      <View style={styles.deepAnalysisSection}>
        <View style={styles.deepAnalysisHeaderRow}>
          <Text style={styles.deepAnalysisHeading}>{lang === 'en' ? 'Deep Analysis' : '深度分析'}</Text>
          {!!item.deep_analysis_id && (
            <DeepAnalysisFeedback
              item={item}
              lang={lang}
            />
          )}
        </View>

        <Text style={styles.deepAnalysisSubheading}>{lang === 'en' ? 'Facts' : '事实'}</Text>
        {facts.map((fact, i) => (
          <View key={`${fact.text}-${i}`} style={styles.factRow}>
            <Text style={styles.factIndex}>{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.deepAnalysisText}>{fact.text}</Text>
              {!!fact.evidence && <Text style={styles.evidenceText}>{fact.evidence}</Text>}
            </View>
          </View>
        ))}

        <Text style={styles.deepAnalysisSubheading}>{lang === 'en' ? 'Why it matters' : '为什么重要'}</Text>
        <Text style={styles.deepAnalysisText}>{block.why_it_matters}</Text>

        <Text style={styles.deepAnalysisSubheading}>{lang === 'en' ? 'Deeper interpretation' : '更深层解读'}</Text>
        <Text style={styles.deepAnalysisText}>{block.deeper_interpretation}</Text>

        <Text style={styles.deepAnalysisSubheading}>{lang === 'en' ? 'Limitations / uncertainties' : '限制与不确定性'}</Text>
        {limitations.map((limitation, i) => (
          <Text key={`${limitation}-${i}`} style={styles.limitationText}>• {limitation}</Text>
        ))}
      </View>
    )
  }

  const message = status === 'ineligible' || !status
    ? (lang === 'en' ? 'Analysis unavailable for this article.' : '这篇文章暂无深度分析。')
    : (lang === 'en' ? 'Analysis is being prepared.' : '深度分析正在准备中。')

  return (
    <View style={styles.deepAnalysisSection}>
      <Text style={styles.deepAnalysisHeading}>{lang === 'en' ? 'Deep Analysis' : '深度分析'}</Text>
      <Text style={styles.deepAnalysisMuted}>{message}</Text>
    </View>
  )
}

function DeepAnalysisFeedback({ item, lang }: { item: Article; lang: 'en' | 'zh' }) {
  const [feedback, setFeedback] = useState<DeepAnalysisFeedbackValue>(null)
  const [hoverUp, setHoverUp] = useState(false)
  const [hoverDown, setHoverDown] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!item.deep_analysis_id) return
    void (async () => {
      const { data } = await supabase
        .from('article_deep_analysis_feedback')
        .select('feedback')
        .eq('analysis_id', item.deep_analysis_id)
        .maybeSingle()
      if (data?.feedback === 1 || data?.feedback === -1) setFeedback(data.feedback)
    })()
  }, [item.deep_analysis_id])

  async function vote(next: DeepAnalysisFeedbackValue) {
    if (!item.deep_analysis_id) return
    const target: DeepAnalysisFeedbackValue = feedback === next ? null : next
    const previous = feedback
    setFeedback(target)
    setError(false)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setFeedback(previous); setError(true); return }

    if (target === null) {
      const { error: err } = await supabase
        .from('article_deep_analysis_feedback')
        .delete()
        .eq('analysis_id', item.deep_analysis_id)
      if (err) { setFeedback(previous); setError(true) }
      return
    }

    const { error: err } = await supabase
      .from('article_deep_analysis_feedback')
      .upsert(
        {
          user_id: user.id,
          analysis_id: item.deep_analysis_id,
          article_id: item.id,
          article_title: item.title,
          feedback: target,
          feedback_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,analysis_id' }
      )

    if (err) {
      setFeedback(previous)
      setError(true)
    }
  }

  const upActive = feedback === 1
  const downActive = feedback === -1

  return (
    <View style={styles.deepAnalysisFeedbackRow}>
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); void vote(1) }}
        onHoverIn={() => setHoverUp(true)}
        onHoverOut={() => setHoverUp(false)}
        accessibilityLabel={lang === 'en' ? 'Good analysis' : '分析不错'}
        style={[styles.deepAnalysisFeedbackButton, upActive ? styles.deepAnalysisFeedbackButtonActive : (hoverUp && styles.deepAnalysisFeedbackButtonHovered)]}
      >
        <Text style={styles.deepAnalysisFeedbackText}>👍</Text>
      </Pressable>
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); void vote(-1) }}
        onHoverIn={() => setHoverDown(true)}
        onHoverOut={() => setHoverDown(false)}
        accessibilityLabel={lang === 'en' ? 'Poor analysis' : '分析较差'}
        style={[styles.deepAnalysisFeedbackButton, downActive ? styles.deepAnalysisFeedbackButtonActive : (hoverDown && styles.deepAnalysisFeedbackButtonHovered)]}
      >
        <Text style={styles.deepAnalysisFeedbackText}>👎</Text>
      </Pressable>
      {error && <Text style={styles.deepAnalysisFeedbackError}>{lang === 'en' ? 'Could not save' : '保存失败'}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg.card, marginVertical: 6, padding: spacing[4],
    borderRadius: 12, borderWidth: 1, borderColor: colors.border.subtle
  },
  cardExpanded: { backgroundColor: colors.bg.hover },
  cardHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },
  cardHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 10
  },
  cardHeaderRight: { flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginLeft: spacing[2] },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start' },
  titleActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-start', gap: spacing[2], marginLeft: spacing[2], flexShrink: 0, maxWidth: 220 },
  sourceLabel: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.tertiary,
    letterSpacing: typography.tracking.wider, fontFamily: typography.family.body,
    textTransform: 'uppercase', flex: 1, transform: [{ scale: 0.833 }],
    transformOrigin: 'left' as any
  },
  publishedDate: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.tertiary,
    letterSpacing: typography.tracking.wider, fontFamily: typography.family.body,
    textTransform: 'uppercase', marginBottom: 0, marginTop: -2, transform: [{ scale: 0.833 }],
    transformOrigin: 'left' as any
  },
  engagementPill: { backgroundColor: colors.bg.card, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  engagementPillHN: { backgroundColor: '#FFF8E1' },
  engagementText: { fontSize: typography.size.base, fontWeight: typography.weight.extrabold, color: colors.brand.accent, fontFamily: typography.family.body, transform: [{ scale: 0.916 }] },
  engagementTextHN: { color: '#FF6F00' },
  expandChevron: { fontSize: typography.size.base, color: colors.text.muted, marginLeft: 6 },
  questionsPillRow: { flexDirection: 'row' as const, marginTop: 10 },
  questionsPill: { ...surfaces.pill, borderRadius: 12, paddingHorizontal: 10, paddingVertical: spacing[1] },
  questionsPillText: { fontSize: typography.size.base, color: colors.text.inverse, fontWeight: typography.weight.semibold },
  noQuestionsPill: { ...surfaces.pill, borderRadius: 12, paddingHorizontal: spacing[2], paddingVertical: spacing[1] },
  noQuestionsText: { fontSize: typography.size.md, color: colors.text.inverse, fontWeight: typography.weight.semibold },
  deepAnalysisTab: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.warm,
    backgroundColor: 'transparent',
  },
  deepAnalysisTabHovered: {
    backgroundColor: '#FAF9F7',
    borderColor: colors.border.warmHover,
  },
  deepAnalysisTabActive: {
    backgroundColor: '#1A1A1A',
    borderColor: '#1A1A1A',
  },
  deepAnalysisTabText: {
    fontSize: typography.size.base,
    color: '#6B6B6B',
    fontWeight: typography.weight.semibold,
  },
  deepAnalysisTabTextActive: {
    color: colors.text.inverse,
  },
  title: {
    fontSize: typography.size.xl, fontWeight: typography.weight.semibold, color: colors.text.primary,
    fontFamily: typography.family.heading, letterSpacing: -0.2,
    lineHeight: typography.leading.relaxed, marginBottom: 10
  },
  summary: { fontSize: typography.size.lg, color: '#3D3935', lineHeight: typography.leading.relaxed },
  deepAnalysisSection: {
    marginTop: spacing[3],
    marginBottom: spacing[2],
  },
  deepAnalysisHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing[3],
  },
  deepAnalysisHeading: {
    fontSize: typography.size.lg,
    color: colors.text.primary,
    fontWeight: typography.weight.bold,
    fontFamily: typography.family.heading,
  },
  deepAnalysisSubheading: {
    fontSize: typography.size.base,
    color: colors.text.muted,
    fontWeight: typography.weight.bold,
    fontFamily: typography.family.body,
    textTransform: 'uppercase',
    letterSpacing: typography.tracking.wide,
    marginTop: spacing[3],
    marginBottom: spacing[1],
  },
  deepAnalysisText: {
    fontSize: typography.size.lg,
    color: '#3D3935',
    lineHeight: typography.leading.relaxed,
  },
  deepAnalysisMuted: {
    fontSize: typography.size.lg,
    color: colors.text.muted,
    lineHeight: typography.leading.relaxed,
    marginTop: spacing[2],
  },
  factRow: {
    flexDirection: 'row',
    gap: spacing[2],
    paddingVertical: spacing[1],
  },
  factIndex: {
    width: 18,
    height: 18,
    borderRadius: 9,
    textAlign: 'center',
    overflow: 'hidden',
    backgroundColor: '#1A1A1A',
    color: colors.text.inverse,
    fontSize: typography.size.xs,
    lineHeight: 18,
    fontWeight: typography.weight.bold,
  },
  evidenceText: {
    color: colors.text.muted,
    fontSize: typography.size.base,
    fontFamily: typography.family.body,
    marginTop: 1,
  },
  limitationText: {
    fontSize: typography.size.lg,
    color: '#3D3935',
    lineHeight: typography.leading.relaxed,
    marginTop: 2,
  },
  analysisSummaryDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing[3],
    marginBottom: spacing[2],
    gap: spacing[2],
  },
  deepAnalysisFeedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  deepAnalysisFeedbackButton: {
    width: 30,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.warm,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deepAnalysisFeedbackButtonHovered: {
    backgroundColor: '#FAF9F7',
    borderColor: colors.border.warmHover,
  },
  deepAnalysisFeedbackButtonActive: {
    backgroundColor: '#1A1A1A',
    borderColor: '#1A1A1A',
  },
  deepAnalysisFeedbackText: {
    fontSize: typography.size.base,
  },
  deepAnalysisFeedbackError: {
    fontSize: typography.size.base,
    color: colors.status.errorBright,
  },
  readMore: { fontSize: typography.size.base, color: '#6B6560', fontWeight: typography.weight.medium, marginTop: 10 },
  questionsSection: { marginTop: 14 },
  questionsDivider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing[3], gap: spacing[2] },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border.warm },
  dividerText: { fontSize: typography.size.base, color: colors.text.muted, fontWeight: typography.weight.semibold, letterSpacing: 0.5, transform: [{ scale: 0.916 }] },
  refreshIcon: { fontSize: typography.size.xl, color: '#1A1A1A' },
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
  questionRow: { paddingVertical: spacing[2] },
  questionText: { fontSize: typography.size.lg, color: '#3D3935', lineHeight: typography.leading.normal },
  answerBlock: { marginBottom: spacing[2] },
  thinkingHeader: { paddingVertical: spacing[1] },
  thinkingHeaderText: { fontSize: typography.size.base, color: colors.text.muted, fontStyle: 'italic' },
  thinkingBlock: { backgroundColor: colors.bg.hover, borderRadius: spacing[2], padding: 10, marginTop: spacing[1] },
  thinkingText: { fontSize: typography.size.base, color: colors.text.muted, fontStyle: 'italic', lineHeight: typography.leading.tight },
  contentBlock: { backgroundColor: colors.bg.hover, borderRadius: spacing[2], padding: spacing[3], marginTop: 6 },
  contentText: { fontSize: typography.size.lg, color: '#3D3935', lineHeight: typography.leading.relaxed },
})
