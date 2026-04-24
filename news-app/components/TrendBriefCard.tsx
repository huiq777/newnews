import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { BriefSource, BriefState, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/config'
import WebHTML from './WebHTML'

const BRIEF_ICON_COLOR = '#6e77e3'
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
    return `<p style="margin:0 0 10px 0;font-size:13px;line-height:20px;color:#27272a;font-family:'Space Grotesk',sans-serif">${inner}</p>`
  }).join('')
}

type CachedBriefRow = {
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
}: {
  lang: 'en' | 'zh'
  dateRange: { start: Date; end: Date } | null
  stepDays: number
  hasArticles: boolean
}) {
  const [briefState, setBriefState] = useState<BriefState>('idle')
  const [generateHovered, setGenerateHovered] = useState(false)
  const [synthesis, setSynthesis] = useState('')
  const [sourcesJson, setSourcesJson] = useState<BriefSource[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [cardExpanded, setCardExpanded] = useState(true)
  const [cachedRow, setCachedRow] = useState<CachedBriefRow | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const startTimeRef = useRef<number>(0)

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtAge(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    return `${Math.floor(mins / 60)}h ago`
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
    d.setUTCHours(0, 0, 0, 0)
    const localTimeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    return l === 'en'
      ? `auto generate daily ${localTimeStr} @ your timezone`
      : `每日自动生成 ${localTimeStr} @ 您的时区`
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  async function generate(forceRefresh = false) {
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
      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/generate-trend-brief`,
        {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
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
            void fetchFullBriefRow(anchorDate, ctrl.signal).then(row => { if (row) setCachedRow(row) })
            break
          }
          try {
            const msg = JSON.parse(payload)
            if (msg.type === 'cached') {
              setSynthesis(msg.synthesis)
              setSourcesJson(msg.sources_json)
              setGeneratedAt(msg.generated_at)
              setBriefState('loaded')
              void fetchFullBriefRow(anchorDate, ctrl.signal).then(row => { if (row) setCachedRow(row) })
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

    const row = await fetchFullBriefRow(anchorDate, ctrl.signal)
    if (ctrl.signal.aborted) return
    if (!row) { setBriefState('idle_ready'); return }

    const text = row[lang === 'en' ? 'synthesis_en' : 'synthesis_zh'] ?? null
    if (text) {
      setCachedRow(row)
      setSynthesis(text)
      setSourcesJson(row.sources_json ?? [])
      setGeneratedAt(row.generated_at)
      setBriefState('loaded')
    } else {
      setBriefState('idle_ready')
    }
  }

  // ── Fetch Full Brief Row (shared by showCached + generate hydration) ────────
  async function fetchFullBriefRow(anchorDate: string, signal: AbortSignal): Promise<CachedBriefRow | null> {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/trend_briefs` +
        `?anchor_date=eq.${anchorDate}` +
        `&step_days=eq.${stepDays}` +
        `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
        `&select=synthesis_en,synthesis_zh,sources_json,generated_at` +
        `&order=generated_at.desc&limit=1`,
        { signal, headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      )
      if (!res.ok) return null
      const rows: CachedBriefRow[] = await res.json()
      return rows[0] ?? null
    } catch {
      return null
    }
  }

  // ── Effect A: window/articles change → lightweight existence check ─────────
  useEffect(() => {
    abortRef.current?.abort()
    if (!hasArticles || !dateRange) {
      setBriefState('idle')
      return
    }
    setSynthesis('')
    setSourcesJson([])
    setGeneratedAt(null)
    setSourcesExpanded(false)
    setCachedRow(null)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const anchor = new Date(dateRange.end)
    anchor.setDate(anchor.getDate() - 1)
    const anchorDate = anchor.toISOString().slice(0, 10)

    ;(async () => {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/trend_briefs` +
          `?anchor_date=eq.${anchorDate}` +
          `&step_days=eq.${stepDays}` +
          `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
          `&select=id&limit=1`,
          { signal: ctrl.signal, headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
        )
        if (ctrl.signal.aborted) return
        if (res.ok) {
          const rows = await res.json()
          setBriefState(rows.length > 0 ? 'idle_cached' : 'idle_ready')
        } else {
          setBriefState('idle_ready')
        }
      } catch {
        if (!ctrl.signal.aborted) setBriefState('idle_ready')
      }
    })()

    return () => { ctrl.abort() }
  }, [dateRange, stepDays, hasArticles]) // eslint-disable-line react-hooks/exhaustive-deps

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
      // Target lang missing in cache — fall through to DB (it may have it now)
    }

    // Slow path: DB query
    const anchor = new Date(dateRange.end)
    anchor.setDate(anchor.getDate() - 1)
    const anchorDate = anchor.toISOString().slice(0, 10)
    const ctrl = new AbortController()

    ;(async () => {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/trend_briefs` +
          `?anchor_date=eq.${anchorDate}` +
          `&step_days=eq.${stepDays}` +
          `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
          `&select=synthesis_en,synthesis_zh,sources_json,generated_at` +
          `&order=generated_at.desc&limit=1`,
          {
            signal: ctrl.signal,
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
          }
        )
        if (!res.ok) { setBriefState('idle_ready'); return }

        const rows: CachedBriefRow[] = await res.json()
        const row = rows[0]
        const text = row?.[lang === 'en' ? 'synthesis_en' : 'synthesis_zh'] ?? null

        if (text) {
          setSynthesis(text)
          setSourcesJson(row.sources_json ?? [])
          setGeneratedAt(row.generated_at)
          setBriefState('loaded')
        } else {
          setSynthesis('')
          setSourcesJson([])
          setGeneratedAt(null)
          setBriefState('idle_ready')
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        setBriefState('idle_ready')
      }
    })()

    return () => ctrl.abort()
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
  if (!hasArticles || briefState === 'idle') return null

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

  // ── idle_cached — cached brief exists, not yet revealed ───────────────────
  if (briefState === 'idle_cached') {
    return (
      <View style={styles.briefCard}>
        <View style={styles.briefHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.briefHeaderText}>{headerLabel}</Text>
            <Text style={styles.briefCronLabel}>{cronTimeLabel(lang)}</Text>
          </View>
        </View>
        <Pressable
          style={[styles.generateBtn, generateHovered && styles.generateBtnHovered]}
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
  if (briefState === 'idle_ready') {
    return (
      <View style={styles.briefCard}>
        <View style={styles.briefHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.briefHeaderText}>{headerLabel}</Text>
            <Text style={styles.briefCronLabel}>{cronTimeLabel(lang)}</Text>
          </View>
        </View>
        <Pressable
          style={[styles.generateBtn, generateHovered && styles.generateBtnHovered]}
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
        <Text style={styles.briefHeaderText}>{headerLabel}</Text>
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
    backgroundColor: '#fafafa', borderRadius: 12, borderWidth: 1, borderColor: '#e4e4e7',
    padding: 16, marginBottom: 12,
  },
  briefHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10,
  },
  briefHeaderText: {
    fontSize: 12, fontWeight: '700', color: '#71717a', letterSpacing: 1.5,
    textTransform: 'uppercase', fontFamily: 'Space Grotesk, sans-serif',
    flex: 1, transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },
  generateBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1, borderColor: '#d4d4d8', borderRadius: 8,
    paddingVertical: 7, paddingHorizontal: 14,
    backgroundColor: '#ffffff',
  },
  generateBtnHovered: { backgroundColor: 'rgba(228,228,231,0.5)' },
  generateBtnText: {
    fontSize: 12, fontWeight: '700', color: '#3f3f46', letterSpacing: 0.5,
    fontFamily: 'Space Grotesk, sans-serif',
  },
  briefAge: {
    fontSize: 12, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif',
    transform: [{ scale: 0.833 }], transformOrigin: 'right' as any,
  },
  briefRefresh: {
    fontSize: 13, color: '#71717a', fontFamily: 'Space Grotesk, sans-serif',
  },
  briefChevron: {
    fontSize: 12, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif',
    transform: [{ scale: 0.833 }], transformOrigin: 'right' as any,
  },
  briefSkeleton: { paddingVertical: 8 },
  briefSkeletonText: {
    fontSize: 13, color: '#a1a1aa', fontStyle: 'italic', fontFamily: 'Space Grotesk, sans-serif',
  },
  briefSynthesis: {
    fontSize: 13, lineHeight: 20, color: '#27272a', fontFamily: 'Space Grotesk, sans-serif',
  },
  briefError: { fontSize: 12, color: '#ef4444', fontFamily: 'Space Grotesk, sans-serif' },
  briefSourcesToggle: { paddingVertical: 4 },
  briefSourcesToggleText: {
    fontSize: 12, fontWeight: '700', color: '#71717a', letterSpacing: 1,
    textTransform: 'uppercase', fontFamily: 'Space Grotesk, sans-serif',
    transform: [{ scale: 0.916 }], transformOrigin: 'left' as any,
  },
  briefSourceRow: {
    flexDirection: 'row', gap: 6, paddingVertical: 4,
    borderTopWidth: 1, borderTopColor: '#f4f4f5',
  },
  briefSourceIndex: {
    fontSize: 12, fontWeight: '700', color: '#a1a1aa',
    fontFamily: 'Space Grotesk, sans-serif', minWidth: 24,
    transform: [{ scale: 0.916 }], transformOrigin: 'left' as any,
  },
  briefSourceTitle: { fontSize: 12, color: '#3f3f46', fontFamily: 'Space Grotesk, sans-serif' },
  briefSourceDate: {
    fontSize: 12, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif',
    marginTop: 1, transform: [{ scale: 0.833 }], transformOrigin: 'left' as any,
  },
  briefSourceHistorical: { color: '#d4d4d8' },
  briefCronLabel: {
    fontSize: 10, color: '#a1a1aa', fontFamily: 'Space Grotesk, sans-serif',
    letterSpacing: 0.5, marginTop: 2,
  },
})
