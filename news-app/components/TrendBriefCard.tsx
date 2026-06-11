import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TouchableOpacity, View, Platform } from 'react-native'
import { colors, typography, spacing } from '../theme/tokens'
import { BriefSource, BriefState, SUPABASE_URL, supabase } from '../lib/config'
import WebHTML from './WebHTML'
import TrendBriefFeedback from './TrendBriefFeedback'
import LoginRequiredInline from './LoginRequiredInline'

const isWeb = Platform.OS === 'web'
const userAgent = isWeb ? navigator.userAgent : ''
const isSafari = isWeb && /^((?!chrome|android).)*safari/i.test(userAgent)
const isChrome = isWeb && /chrome|chromium|crios/i.test(userAgent)

function getCronLabelStyle(lang: 'en' | 'zh') {
  if (!isWeb) return {}
  if (lang === 'en') {
    if (isChrome) return { fontSize: 11, letterSpacing: 1 }
    if (isSafari) return { fontSize: 10.5, letterSpacing: 0 }
    return { fontSize: 11, letterSpacing: 0.5 }
  } else {
    if (isChrome) return { letterSpacing: 1.2 }
    if (isSafari) return {}
    return {}
  }
}

const BRIEF_ICON_COLOR = colors.brand.brief
const BRIEF_ICON_SVG = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="15" height="15" style="display:inline-block;vertical-align:middle;flex-shrink:0"><path d="M510.073377 407.480715c-31.066792 0-60.688617-9.873942-85.253057-28.417686-10.596425-7.947319-12.763876-23.119473-4.816557-33.715898 7.947319-10.596425 23.119473-12.763876 33.715898-4.816557a93.778363 93.778363 0 0 0 150.035748-74.89746 93.92286 93.92286 0 0 0-93.682032-93.682032c-13.245532 0-24.082785-10.837253-24.082784-24.082785s10.837253-24.082785 24.082784-24.082784c78.26905 0 141.847601 63.578551 141.847601 141.847601s-63.819379 141.847601-141.847601 141.847601z" fill="$6e77e3"/><path d="M509.110066 903.345249c-177.008467 0-328.248354-124.507996-367.503293-302.720602a23.986453 23.986453 0 0 1 18.302917-28.658513 23.986453 23.986453 0 0 1 28.658513 18.302916c34.438382 156.056444 166.171214 264.91063 320.541863 264.91063 152.925682 0 284.658514-107.890875 319.819379-262.261524 2.889934-13.004704 15.894638-21.19285 28.899341-18.062088 13.004704 2.889934 21.19285 15.894638 18.062089 28.899341-40.459078 176.285983-191.21731 299.58984-366.780809 299.58984zM852.771402 446.01317c-10.355597 0-19.988711-6.74318-23.119473-17.098777-23.841957-79.954845-80.918156-161.113829-142.088429-202.054562a24.058702 24.058702 0 0 1-6.502352-33.475071c7.465663-11.078081 22.39699-13.968015 33.47507-6.502352 70.562559 47.443086 133.900282 137.031044 161.113829 228.304798 3.853246 12.763876-3.37159 26.250235-16.135466 30.103481-2.167451 0.240828-4.575729 0.722484-6.743179 0.722483zM164.967074 449.143932c-2.408278 0-4.575729-0.240828-6.984007-0.963311-12.763876-3.853246-19.988711-17.339605-16.135466-30.103481 50.33302-167.857008 208.075259-294.291627 367.021637-294.291627 13.245532 0 24.082785 10.837253 24.082785 24.082784s-10.837253 24.082785-24.082785 24.082785c-138.476011 0-276.470367 111.74412-321.023518 260.094073-2.889934 10.355597-12.523048 17.098777-22.878646 17.098777z" fill="${BRIEF_ICON_COLOR}"/><path d="M158.946378 619.650047c-62.61524 0-113.670743-49.128881-113.670743-109.335842S96.331138 400.978363 158.946378 400.978363c13.245532 0 24.082785 10.837253 24.082785 24.082785s-10.837253 24.082785-24.082785 24.082784c-36.124177 0-65.505174 27.454374-65.505174 61.170273 0 35.160865 32.993415 63.337723 70.080903 60.929445a23.986453 23.986453 0 0 1 25.527752 22.39699 23.841957 23.841957 0 0 1-22.39699 25.527751c-2.649106 0.240828-5.298213 0.481656-7.706491 0.481656zM861.682032 619.650047c-2.649106 0-5.057385 0-7.706491-0.240828a23.986453 23.986453 0 1 1 3.130762-47.924741c1.444967 0 3.130762 0.240828 4.575729 0.240828 36.124177 0 65.505174-27.454374 65.505174-61.170273 0-32.511759-36.84666-64.301035-74.415804-64.301035-13.245532 0-24.082785-10.837253-24.082785-24.082784s10.837253-24.082785 24.082785-24.082785c64.060207 0 122.581373 53.70461 122.581373 112.466604 0 59.966134-51.055503 109.095014-113.670743 109.095014zM385.083725 550.773283c-25.768579 0-46.720602-20.952023-46.720602-46.720602S359.315146 457.572907 385.083725 457.572907s46.720602 20.952023 46.720602 46.720602-21.19285 46.479774-46.720602 46.479774z m0-48.165569l-1.444967 1.444967c0 0.722484 0.722484 1.444967 1.444967 1.444967v-2.889934zM653.365945 550.773283c-25.768579 0-46.720602-20.952023-46.720602-46.720602S627.597366 457.572907 653.365945 457.572907s46.720602 20.952023 46.720603 46.720602-20.952023 46.479774-46.720603 46.479774z m0-48.165569l-1.444967 1.444967c0 0.722484 0.722484 1.444967 1.444967 1.444967v-2.889934zM505.497648 718.630292c-52.982126 0-94.886171-27.93603-115.838194-51.537159a23.817874 23.817874 0 0 1 2.167451-33.956727 24.034619 24.034619 0 0 1 33.956726 1.926623c7.465663 8.188147 74.415804 76.824083 169.783631-2.408278a24.082785 24.082785 0 1 1 30.825965 37.087488c-43.58984 35.883349-84.771402 48.888053-120.895579 48.888053z" fill="${BRIEF_ICON_COLOR}"/></svg>`

function markdownToHtml(text: string): string {
  const safeText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const paragraphs = safeText.split(/\n\n+/)
  return paragraphs.map(p => {
    const inner = p
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')
    return `<p style="margin:0 0 10px 0;font-size:${typography.size.md}px;line-height:${typography.leading.normal}px;color:${colors.text.body};font-family:'${typography.family.body}',sans-serif">${inner}</p>`
  }).join('')
}

type CachedBriefRow = {
  id: string
  synthesis_en: string | null
  synthesis_zh: string | null
  sources_json: BriefSource[]
  generated_at: string
}

export default function TrendBriefCard({
  lang,
  dateRange,
  stepDays,
  hasArticles,
  onOpenManual,
  isAuthed,
  onLoginPress,
}: {
  lang: 'en' | 'zh'
  dateRange: { start: Date; end: Date } | null
  stepDays: number
  hasArticles: boolean
  onOpenManual: () => void
  isAuthed: boolean
  onLoginPress: () => void
}) {
  const [briefState, setBriefState] = useState<BriefState>('idle')
  const [generateHovered, setGenerateHovered] = useState(false)
  const [helpHovered, setHelpHovered] = useState(false)
  const [synthesis, setSynthesis] = useState('')
  const [sourcesJson, setSourcesJson] = useState<BriefSource[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [cardExpanded, setCardExpanded] = useState(true)
  const [cachedRow, setCachedRow] = useState<CachedBriefRow | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const startTimeRef = useRef<number>(0)

  async function getAccessToken(): Promise<string | null> {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtAge(iso: string): string {
    const diff = Math.max(0, Date.now() - new Date(iso).getTime())
    const mins = Math.floor(diff / 60000)
    
    if (mins < 60) {
      return lang === 'en' ? `${mins}m ago` : `${mins}分钟前`
    }
    
    const totalHours = Math.floor(mins / 60)
    if (totalHours < 24) {
      return lang === 'en' ? `${totalHours}h ago` : `${totalHours}小时前`
    }
    
    const totalDays = Math.floor(totalHours / 24)
    const h = totalHours % 24
    
    if (totalDays < 30) {
      return lang === 'en' ? `${totalDays}d ${h}h ago` : `${totalDays}天 ${h}小时前`
    }
    
    const mo = Math.floor(totalDays / 30)
    const d = totalDays % 30
    return lang === 'en' ? `${mo}mo ${d}d ${h}h ago` : `${mo}个月 ${d}天 ${h}小时前`
  }

  function fmtDateShort(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return lang === 'en'
      ? `${mo[d.getMonth()]} ${d.getDate()}`
      : `${d.getMonth() + 1}月${d.getDate()}日`
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function cronTimeLabel(l: 'en' | 'zh'): string {
    const d = new Date()
    d.setUTCHours(0, 30, 0, 0)
    const localTimeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    return l === 'en'
      ? `auto generate daily ${localTimeStr} @ your timezone`
      : `每日自动生成 ${localTimeStr} @ 您的时区`
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  async function generate(forceRefresh = false) {
    if (!isAuthed) return
    if (!dateRange) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setBriefState('loading')
    setSynthesis('')
    setSourcesJson([])
    setGeneratedAt(null)

    const anchor = new Date(dateRange.end)
    anchor.setDate(anchor.getDate() - 1)
    const anchorDate = anchor.toISOString().slice(0, 10)

    try {
      const accessToken = await getAccessToken()
      if (!accessToken) {
        onLoginPress()
        setBriefState('idle_ready')
        return
      }
      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/generate-trend-brief`,
        {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            category: 'all',
            anchor_date: anchorDate,
            step_days: stepDays,
            date_start: dateRange.start.toISOString(),
            date_end: dateRange.end.toISOString(),
            lang,
            force_refresh: forceRefresh,
          }),
        }
      )

      if (res.status === 204) { setBriefState('idle_ready'); return }
      if (res.status === 429) { setBriefState('rate_limited'); return }
      if (!res.ok) { setBriefState('error'); return }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let synthesisAccum = ''

      setBriefState('streaming')

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
            const now = new Date().toISOString()
            setGeneratedAt(prev => prev ?? now)
            setBriefState('loaded')
            break
          }
          try {
            const msg = JSON.parse(payload)
            if (msg.type === 'cached') {
              setSynthesis(msg.synthesis)
              setSourcesJson(msg.sources_json)
              setGeneratedAt(msg.generated_at)
              setCachedRow({
                id: msg.id ?? `${anchorDate}-${stepDays}`,
                synthesis_en: msg.synthesis_en ?? (lang === 'en' ? msg.synthesis : null),
                synthesis_zh: msg.synthesis_zh ?? (lang === 'zh' ? msg.synthesis : null),
                sources_json: msg.sources_json,
                generated_at: msg.generated_at,
              })
              setBriefState('loaded')
            } else if (msg.type === 'sources') {
              setSourcesJson(msg.sources_json)
            } else if (msg.type === 'content') {
              synthesisAccum += msg.content
              setSynthesis(prev => prev + msg.content)
            }
          } catch { /* skip */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      setBriefState('error')
    }
  }

  // ── Show Cached ────────────────────────────────────────────────────────────
  async function showCached() {
    if (!isAuthed) return
    if (!dateRange) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setBriefState('loading')
    setSynthesis('')
    setSourcesJson([])
    setGeneratedAt(null)

    const anchor = new Date(dateRange.end)
    anchor.setDate(anchor.getDate() - 1)
    const anchorDate = anchor.toISOString().slice(0, 10)

    await generate(false)
  }

  // ── Effect A: window/articles change → lightweight existence check ─────────
  useEffect(() => {
    abortRef.current?.abort()
    if (!isAuthed) return
    if (!hasArticles || !dateRange) {
      setBriefState('idle')
      return
    }
    setSynthesis('')
    setSourcesJson([])
    setGeneratedAt(null)
    setSourcesExpanded(false)
    setCachedRow(null)

    setBriefState('idle_ready')
  }, [dateRange, stepDays, hasArticles, isAuthed]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect B: lang toggle → memory-first, DB fallback ─────────────────────
  useEffect(() => {
    if (
      briefState === 'idle' || briefState === 'idle_ready' || briefState === 'idle_cached' ||
      !dateRange || !hasArticles
    ) return

    // Fast path: serve from in-memory cache — zero network I/O
    if (cachedRow) {
      const text = cachedRow[lang === 'en' ? 'synthesis_en' : 'synthesis_zh'] ?? null
      if (text) {
        setSynthesis(text)
        setSourcesJson(cachedRow.sources_json ?? [])
        setGeneratedAt(cachedRow.generated_at)
        setBriefState('loaded')
        return
      }
      setBriefState('idle_ready')
      return
    }
  }, [lang]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Timer: monotonic clock across loading→streaming transition ────────────
  useEffect(() => {
    if (briefState === 'loading') {
      startTimeRef.current = Date.now()
      setElapsedSeconds(0)
    }
    if (briefState !== 'loading' && briefState !== 'streaming') return
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [briefState])

  // ── Don't render if no articles or initial idle ────────────────────────────
  if (!hasArticles) return null

  // ── Window label ───────────────────────────────────────────────────────────
  const windowLabel = (() => {
    if (!dateRange) return ''
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const s = dateRange.start
    const e = new Date(dateRange.end); e.setDate(e.getDate() - 1)
    if (stepDays === 1) return lang === 'en' ? `${mo[s.getMonth()]} ${s.getDate()}` : `${s.getMonth() + 1}月${s.getDate()}日`
    return lang === 'en'
      ? `${mo[s.getMonth()]} ${s.getDate()} – ${mo[e.getMonth()]} ${e.getDate()}`
      : `${s.getMonth() + 1}月${s.getDate()}日 – ${e.getMonth() + 1}月${e.getDate()}日`
  })()

  const briefTitle = lang === 'en' ? 'TREND BRIEF' : '趋势简报'
  const headerLabel = `${briefTitle} · ${windowLabel}`
  const isActive = briefState === 'loading' || briefState === 'streaming' || briefState === 'loaded'

  // Help button — appears in every render branch so the "How to Subscribe?"
  // affordance is always discoverable in the same place. In the active branch
  // the parent TouchableOpacity toggles cardExpanded, so press events must
  // stopPropagation (web only — RN native has no bubble).
  //
  // `origin` controls transformOrigin for the 0.833 scale: 'left' puts the
  // visible button flush to its layout left edge (used in the active branch
  // where it sits right of the title text), 'right' puts the visible button
  // flush to its layout right edge (used in idle branches where the button is
  // anchored to the cron label's right edge — without right-origin, the
  // unscaled layout width would push the visible button slightly inward).
  const renderHelpButton = (origin: 'left' | 'right' = 'left') => (
    <Pressable
      onPress={(e) => { (e as any).stopPropagation?.(); onOpenManual() }}
      onHoverIn={() => setHelpHovered(true)}
      onHoverOut={() => setHelpHovered(false)}
      style={[
        styles.helpBtn,
        { transformOrigin: origin } as any,
        helpHovered && styles.helpBtnHovered,
      ]}
    >
      <Text style={styles.helpBtnText}>
        {lang === 'en' ? 'How to Subscribe?' : '如何订阅?'}
      </Text>
    </Pressable>
  )

  if (!isAuthed) {
    return (
      <View style={styles.briefCard}>
        <View style={styles.titleCronCol}>
          <View style={styles.titleRow}>
            <Text style={[styles.briefHeaderText, styles.briefHeaderTextInline]}>{headerLabel}</Text>
            {renderHelpButton('left')}
          </View>
          <Text style={[styles.briefCronLabel, getCronLabelStyle(lang)]}>{cronTimeLabel(lang)}</Text>
        </View>
        <LoginRequiredInline
          lang={lang}
          message={lang === 'en' ? 'Please log in to view Trend Brief.' : '请登录查看趋势简报。'}
          onLoginPress={onLoginPress}
        />
      </View>
    )
  }
  if (briefState === 'idle') return null

  // ── idle_cached — cached brief exists, not yet revealed ───────────────────
  // Layout: a content-sized column wraps the title + cron label; the column's
  // width = its widest non-absolute child = cron label width (longer than the
  // title). The help button is absolutely positioned at the column's right
  // edge (right: 0), so its right edge aligns exactly with the cron label's
  // right edge. The Show/Generate button is a sibling of the column, with its
  // own alignSelf: flex-start sizing.
  if (briefState === 'idle_cached') {
    return (
      <View style={styles.briefCard}>
        <View style={styles.titleCronCol}>
          <View style={styles.titleRow}>
            <Text style={[styles.briefHeaderText, styles.briefHeaderTextInline]}>{headerLabel}</Text>
            {renderHelpButton('left')}
          </View>
          <Text style={[styles.briefCronLabel, getCronLabelStyle(lang)]}>{cronTimeLabel(lang)}</Text>
        </View>
        <Pressable
          style={[styles.generateBtn, generateHovered && styles.generateBtnHovered, styles.idleGenerateBtnSpacing]}
          onPress={() => showCached()}
          onHoverIn={() => setGenerateHovered(true)}
          onHoverOut={() => setGenerateHovered(false)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <WebHTML html={BRIEF_ICON_SVG} />
            <Text style={styles.generateBtnText}>
              {lang === 'en' ? 'Show Trend Brief' : '查看趋势简报'}
            </Text>
          </View>
        </Pressable>
      </View>
    )
  }

  // ── idle_ready — prompt card ───────────────────────────────────────────────
  // Same layout as idle_cached — see comment there.
  if (briefState === 'idle_ready') {
    return (
      <View style={styles.briefCard}>
        <View style={styles.titleCronCol}>
          <View style={styles.titleRow}>
            <Text style={[styles.briefHeaderText, styles.briefHeaderTextInline]}>{headerLabel}</Text>
            {renderHelpButton('left')}
          </View>
          <Text style={[styles.briefCronLabel, getCronLabelStyle(lang)]}>{cronTimeLabel(lang)}</Text>
        </View>
        <Pressable
          style={[styles.generateBtn, generateHovered && styles.generateBtnHovered, styles.idleGenerateBtnSpacing]}
          onPress={() => generate(false)}
          onHoverIn={() => setGenerateHovered(true)}
          onHoverOut={() => setGenerateHovered(false)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <WebHTML html={BRIEF_ICON_SVG} />
            <Text style={styles.generateBtnText}>
              {lang === 'en' ? 'Generate Trend Brief' : '生成趋势简报'}
            </Text>
          </View>
        </Pressable>
      </View>
    )
  }

  // ── Active / loaded / error states ────────────────────────────────────────
  return (
    <View style={styles.briefCard}>
      {/* Header row */}
      <TouchableOpacity
        onPress={() => setCardExpanded(p => !p)}
        style={styles.briefHeader}
        activeOpacity={0.7}
      >
        <View style={styles.titleRow}>
          <Text style={[styles.briefHeaderText, styles.briefHeaderTextInline]}>{headerLabel}</Text>
          {renderHelpButton('left')}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {generatedAt && isActive && (
            <Text style={styles.briefAge}>{fmtAge(generatedAt)}</Text>
          )}
          {(briefState === 'loaded' || briefState === 'streaming') && (
            <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); generate(true) }}>
              <Text style={styles.briefRefresh}>↻</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.briefChevron}>{cardExpanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {/* Body */}
      {cardExpanded && (
        <View style={{ paddingRight: 4 }}>
          {/* Loading skeleton */}
          {briefState === 'loading' && synthesis.length === 0 && (
            <View style={styles.briefSkeleton}>
              <Text style={styles.briefSkeletonText}>
                {lang === 'en' ? `Synthesizing ${windowLabel}… (${elapsedSeconds}s)` : `正在分析 ${windowLabel}… (${elapsedSeconds}s)`}
              </Text>
            </View>
          )}

          {/* Synthesis text */}
          {synthesis.length > 0 && (
            <WebHTML html={markdownToHtml(synthesis)} />
          )}

          {/* Rate limited */}
          {briefState === 'rate_limited' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={styles.briefError}>
                {lang === 'en' ? 'Rate limited — try again in a moment' : '请求过频，请稍后再试'}
              </Text>
              <TouchableOpacity onPress={() => generate(false)}>
                <Text style={styles.briefRefresh}>{lang === 'en' ? 'Retry' : '重试'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Error */}
          {briefState === 'error' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={styles.briefError}>
                {lang === 'en' ? 'Unable to generate brief' : '生成失败'}
              </Text>
              <TouchableOpacity onPress={() => generate(false)}>
                <Text style={styles.briefRefresh}>{lang === 'en' ? 'Retry' : '重试'}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Feedback row */}
          {synthesis.length > 0 && briefState === 'loaded' && dateRange && (
            <TrendBriefFeedback
              anchorDate={(() => {
                const d = new Date(dateRange.end)
                d.setDate(d.getDate() - 1)
                return d.toISOString().slice(0, 10)
              })()}
              stepDays={stepDays}
              synthesis={synthesis}
              lang={lang}
            />
          )}

          {/* Sources */}
          {sourcesJson.length > 0 && (briefState === 'loaded' || briefState === 'streaming') && (
            <View style={{ marginTop: 12 }}>
              <TouchableOpacity onPress={() => setSourcesExpanded(p => !p)} style={styles.briefSourcesToggle}>
                <Text style={styles.briefSourcesToggleText}>
                  {sourcesExpanded ? '▲' : '▼'} {lang === 'en' ? `Sources (${sourcesJson.length})` : `来源 (${sourcesJson.length})`}
                </Text>
              </TouchableOpacity>
              {sourcesExpanded && sourcesJson.map(src => (
                <View key={src.index} style={styles.briefSourceRow}>
                  <Text style={[styles.briefSourceIndex, src.is_historical && styles.briefSourceHistorical]}>
                    [{src.index}]
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.briefSourceTitle} numberOfLines={1}>{src.title}</Text>
                    <Text style={[styles.briefSourceDate, src.is_historical && styles.briefSourceHistorical]}>
                      {fmtDateShort(src.published_at)}{src.is_historical ? (lang === 'en' ? ' · historical' : ' · 历史') : ''}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  briefCard: {
    backgroundColor: colors.bg.subtle, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default,
    padding: spacing[4], marginBottom: spacing[3],
  },
  briefHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10,
  },
  briefHeaderText: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.secondary, letterSpacing: 1.5,
    textTransform: 'uppercase', fontFamily: typography.family.body,
    flex: 1, transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },
  generateBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1, borderColor: colors.border.medium, borderRadius: 8,
    paddingVertical: 7, paddingHorizontal: 14,
    backgroundColor: colors.bg.card,
  },
  generateBtnHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },
  generateBtnText: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.dim, letterSpacing: 0.5,
    fontFamily: typography.family.body,
  },
  briefAge: {
    fontSize: typography.size.base, color: colors.text.tertiary, fontFamily: typography.family.body,
    transform: [{ scale: 0.833 }], transformOrigin: 'right' as any,
  },
  briefRefresh: {
    fontSize: typography.size.md, color: colors.text.secondary, fontFamily: typography.family.body,
  },
  briefChevron: {
    fontSize: typography.size.base, color: colors.text.tertiary, fontFamily: typography.family.body,
    transform: [{ scale: 0.833 }], transformOrigin: 'right' as any,
  },
  briefSkeleton: { paddingVertical: spacing[2] },
  briefSkeletonText: {
    fontSize: typography.size.md, color: colors.text.tertiary, fontStyle: 'italic', fontFamily: typography.family.body,
  },
  briefSynthesis: {
    fontSize: typography.size.md, lineHeight: typography.leading.normal, color: colors.text.body, fontFamily: typography.family.body,
  },
  briefError: { fontSize: typography.size.base, color: colors.status.errorBright, fontFamily: typography.family.body },
  briefSourcesToggle: { paddingVertical: 4 },
  briefSourcesToggleText: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.secondary, letterSpacing: 1,
    textTransform: 'uppercase', fontFamily: typography.family.body,
    transform: [{ scale: 0.916 }], transformOrigin: 'left' as any,
  },
  briefSourceRow: {
    flexDirection: 'row', gap: 6, paddingVertical: 4,
    borderTopWidth: 1, borderTopColor: colors.border.subtle,
  },
  briefSourceIndex: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.tertiary,
    fontFamily: typography.family.body, minWidth: 24,
    transform: [{ scale: 0.916 }], transformOrigin: 'left' as any,
  },
  briefSourceTitle: { fontSize: typography.size.base, color: colors.text.dim, fontFamily: typography.family.body },
  briefSourceDate: {
    fontSize: typography.size.base, color: colors.text.tertiary, fontFamily: typography.family.body,
    marginTop: 1, transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },
  briefSourceHistorical: { color: colors.border.medium },
  briefCronLabel: {
    fontSize: typography.size.sm, color: colors.text.tertiary, fontFamily: typography.family.body,
    letterSpacing: 0.5, marginTop: 2,
  },
  helpBtn: {
    borderWidth: 1, borderColor: colors.border.medium, borderRadius: 6,
    paddingVertical: 2, paddingHorizontal: spacing[2],
    backgroundColor: colors.bg.card,
    // Scale the whole button (border + padding + text together) so the visual
    // matches `briefHeaderText` (which uses the same 0.833 trick) exactly.
    // Scaling only the text would leave dead space inside the border because
    // the Text's layout box reserves its unscaled width.
    transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },
  helpBtnHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },
  helpBtnText: {
    // Same metrics as `briefHeaderText` — the parent button supplies the
    // 0.833 scale, so the text inherits the same visual rendering as the title.
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.secondary, letterSpacing: 1.5,
    textTransform: 'uppercase',
    fontFamily: typography.family.body,
  },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: spacing[2],
  },
  titleCronCol: {
    // Idle branches: a content-sized column wrapping title row + cron label.
    alignSelf: 'flex-start',
  },
  helpAnchor: {
    // Deprecated
  },
  idleGenerateBtnSpacing: {
    // Replaces the spacing previously provided by `briefHeader.marginBottom`
    // (the idle branches don't wrap the title in `briefHeader`).
    marginTop: 10,
  },
  briefHeaderTextInline: {
    // Override `briefHeaderText`'s `flex: 1` so the title sizes to its content
    // and the help button sits immediately to its right. RN's `flex: 0` is
    // shorthand for basis: 0 (which collapses the text to zero width and wraps
    // word-by-word) — use longhand to keep basis: auto.
    flexGrow: 0, flexShrink: 0, flexBasis: 'auto',
  },
})
