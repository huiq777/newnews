import { useEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { colors, typography, spacing } from '../theme/tokens'

export default function DrumWheelSidebar({
  lang,
  onFilterChange,
  onMountedControls,
}: {
  lang: 'en' | 'zh'
  onFilterChange: (start: Date, end: Date, label: string, stepDays: number) => void
  onMountedControls: (controls: { resetToToday: () => void; switchTo: (days: 1 | 3 | 7 | 30) => void }) => void
}) {
  const stateRef = useRef({ activeIdx: 0, stepDays: 1 })
  const wrapRef = useRef<View>(null)
  const [activeTf, setActiveTf] = useState<1 | 3 | 7 | 30>(1)
  const handleTfRef = useRef<(days: number) => void>(() => { })
  const onFilterRef = useRef(onFilterChange)
  const setActiveTfStable = useRef(setActiveTf)
  const tfAnim = useRef(new Animated.Value(0)).current
  useEffect(() => { onFilterRef.current = onFilterChange }, [onFilterChange])

  function pressTf(days: 1 | 3 | 7 | 30) {
    const idx = [1, 3, 7, 30].indexOf(days)
    setActiveTf(days)
    Animated.spring(tfAnim, {
      toValue: idx * 53,
      useNativeDriver: true,
      tension: 300,
      friction: 30,
    }).start()
    handleTfRef.current(days)
  }

  useEffect(() => {
    if (typeof document === 'undefined') return

    // ── Inject CSS ────────────────────────────────────────────────────────
    const style = document.createElement('style')
    style.textContent = `
      .wheel-track {
        scroll-snap-type: y mandatory;
        overflow-y: scroll;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .wheel-track::-webkit-scrollbar { display: none; width: 0; height: 0; }
      .wheel-item { height: 52px; scroll-snap-align: center; }
      .wheel-wrap { perspective: 220px; perspective-origin: center center; overflow: hidden; }
      .wheel-item-inner {
        transition: opacity 0.2s ease-in-out, background-color 0.2s ease-in-out,
                    transform 0.2s ease-in-out;
        will-change: transform, opacity;
      }
      .is-scrolling .wheel-item-inner { transition: none !important; }
    `
    document.head.appendChild(style)

    // ── DOM node (react-native-web renders View as div) ───────────────────
    const wrapDom = wrapRef.current as unknown as HTMLElement
    wrapDom.className = 'wheel-wrap'
    wrapDom.style.position = 'relative'
    wrapDom.style.overflow = 'hidden'

    // ── Constants ─────────────────────────────────────────────────────────
    const TODAY = new Date()
    TODAY.setHours(0, 0, 0, 0)
    const ITEM_H = 52
    const DEGREES_PER_ITEM = 22
    const OPACITY_PER_ITEM = 0.38

    let stepDays = stateRef.current.stepDays
    let activeIdx = stateRef.current.activeIdx
    let anchors: Date[] = []
    let rafId: number | null = null
    let scrollTimer: ReturnType<typeof setTimeout>
    let scrollAnimId: number | null = null
    let track: HTMLElement | undefined

    // ── Helpers ───────────────────────────────────────────────────────────
    function buildAnchors() {
      anchors = []
      const limitDate = new Date(2026, 2, 20) // March 20, 2026
      for (let i = 0; i <= 300; i++) {
        const d = new Date(TODAY)
        d.setDate(d.getDate() - i * stepDays)
        anchors.push(d)
        if (d <= limitDate) break
      }
    }

    function fmtDateLong(d: Date): string {
      return `${d.getFullYear()} ${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')}`
    }

    function isToday(d: Date): boolean {
      return d.getFullYear() === TODAY.getFullYear()
        && d.getMonth() === TODAY.getMonth()
        && d.getDate() === TODAY.getDate()
    }

    function diffLabel(d: Date): string {
      const msPerDay = 86400000
      const diff = Math.round((TODAY.getTime() - d.getTime()) / msPerDay)
      if (diff === 0) return 'today'
      const sign = diff > 0 ? '-' : '+'
      const absDiff = Math.abs(diff)
      if (absDiff < 90) return `${sign}${absDiff}d`
      const a = diff > 0 ? d : TODAY
      const b = diff > 0 ? TODAY : d
      let totalMonths = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
      const dayRef = new Date(a.getFullYear(), a.getMonth() + totalMonths, a.getDate())
      let days = Math.round((b.getTime() - dayRef.getTime()) / msPerDay)
      if (days < 0) { totalMonths--; days += 30 }
      const years = Math.floor(totalMonths / 12)
      const months = totalMonths % 12
      const parts: string[] = []
      if (lang === 'en') {
        if (years > 0) parts.push(`${years}yr`)
        if (months > 0) parts.push(`${months}mo`)
        if (days > 0) parts.push(`${days}d`)
        return `${sign}~${parts.join(' ')}`
      } else {
        if (years > 0) parts.push(`${years}年`)
        if (months > 0) parts.push(`${months}月`)
        if (days > 0) parts.push(`${days}天`)
        return `${sign}~${parts.join('')}`
      }
    }

    function itemStyle(offset: number) {
      const rot = offset * DEGREES_PER_ITEM
      const opacity = Math.max(0.08, 1 - Math.abs(offset) * OPACITY_PER_ITEM)
      const isCenter = Math.abs(offset) < 0.4
      return {
        transform: `rotateX(${rot}deg)`,
        opacity,
        backgroundColor: isCenter ? 'rgba(228,228,231,0.5)' : 'transparent',
        borderRadius: isCenter ? '0.5rem' : '0',
      }
    }

    function applyStyle(inner: HTMLElement, offset: number) {
      const s = itemStyle(offset)
      inner.style.transform = s.transform
      inner.style.opacity = String(s.opacity)
      inner.style.filter = ''
      inner.style.backgroundColor = s.backgroundColor
      inner.style.borderRadius = s.borderRadius

      const active = Math.abs(offset) < 0.5
      const mainLabel = inner.querySelector('.wheel-mainlabel') as HTMLElement | null
      if (mainLabel) {
        mainLabel.style.fontWeight = active ? '800' : '700'
      }
      inner.style.fontSize = active ? '16px' : '14px'

      const sub = inner.querySelector('.wheel-sublabel') as HTMLElement | null
      if (sub) sub.style.color = Math.abs(offset) < 0.4 ? '#52525b' : ''
    }

    function itemInnerHTML(i: number): string {
      const d = anchors[i]
      const dateStr = isToday(d) ? (lang === 'en' ? 'Today' : '今天') : fmtDateLong(d)
      const sub = isToday(d) ? '' : diffLabel(d)
      const s = itemStyle(i - activeIdx)
      const active = Math.abs(i - activeIdx) < 0.5
      return `
        <div class="wheel-item-inner"
             style="margin:0 4px;height:100%;padding:0 12px;
                    display:flex;flex-direction:row;align-items:center;justify-content:center;gap:8px;
                    cursor:pointer;user-select:none;font-size:${active ? '16px' : '14px'};
                    transform:${s.transform};opacity:${s.opacity};
                    background-color:${s.backgroundColor};border-radius:${s.borderRadius};">
          <span class="wheel-mainlabel" style="font-family:'Space Grotesk',sans-serif;
                       font-weight:${active ? '800' : '700'};
                       font-size:1em;
                       letter-spacing:-0.5px;color:#2d3432;line-height:1;">${dateStr}</span>
          ${sub ? `<span class="wheel-sublabel" style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:0.6em;color:#a1a1aa;letter-spacing:1.5px;text-transform:uppercase;">${sub}</span>` : ''}
        </div>`
    }

    // ── DOM wheel build ───────────────────────────────────────────────────
    function renderWheel() {
      if (scrollAnimId) { cancelAnimationFrame(scrollAnimId); scrollAnimId = null }
      const old = wrapDom.querySelector('.wheel-track')
      if (old) wrapDom.removeChild(old)

      const PAD_H = ITEM_H * 2
      track = document.createElement('div')
      track.className = 'wheel-track'
      track.style.cssText = 'position:absolute;top:0;right:0;bottom:0;left:0;scrollbar-width:none;-ms-overflow-style:none;overflow-y:scroll;'
      const currentTrack = track
      wrapDom.appendChild(currentTrack)

      const padTop = document.createElement('div')
      padTop.style.height = PAD_H + 'px'
      currentTrack.appendChild(padTop)

      anchors.forEach((_, i) => {
        const el = document.createElement('div')
        el.className = 'wheel-item'
        el.dataset.idx = String(i)
        el.innerHTML = itemInnerHTML(i)
        el.addEventListener('click', () => snapToIdx(i))
        currentTrack.appendChild(el)
      })

      const padBot = document.createElement('div')
      padBot.style.height = PAD_H + 'px'
      currentTrack.appendChild(padBot)

      wrapDom.style.height = (ITEM_H * 5) + 'px'
      currentTrack.scrollTop = activeIdx * ITEM_H
      currentTrack.addEventListener('scroll', onWheelScroll)
      updateFilterTag()
    }

    function updateContinuous() {
      rafId = null
      if (!track) return
      const frac = track.scrollTop / ITEM_H
      track.querySelectorAll('.wheel-item').forEach(el => {
        const h = el as HTMLElement
        const i = parseInt(h.dataset.idx || '0')
        if (Math.abs(i - frac) > 3) return
        const inner = h.querySelector('.wheel-item-inner') as HTMLElement | null
        if (inner) applyStyle(inner, i - frac)
      })
    }

    function updateWheelStyles() {
      track?.querySelectorAll('.wheel-item').forEach(el => {
        const h = el as HTMLElement
        const inner = h.querySelector('.wheel-item-inner') as HTMLElement | null
        if (inner) applyStyle(inner, parseInt(h.dataset.idx || '0') - activeIdx)
      })
    }

    function updateFilterTag() {
      if (!anchors.length) return
      const endDate = anchors[activeIdx]
      let start: Date, end: Date, label: string

      if (stepDays === 1) {
        start = new Date(endDate); start.setHours(0, 0, 0, 0)
        end = new Date(start); end.setDate(end.getDate() + 1)
        label = isToday(endDate) ? (lang === 'en' ? 'Today' : '今天') : fmtDateLong(endDate)
      } else {
        start = new Date(endDate)
        start.setDate(start.getDate() - (stepDays - 1))
        start.setHours(0, 0, 0, 0)
        end = new Date(endDate); end.setDate(end.getDate() + 1); end.setHours(0, 0, 0, 0)
        const moEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        const moZh = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
        const mo = lang === 'en' ? moEn : moZh
        const s = `${mo[start.getMonth()]} ${start.getDate()}`
        const e = isToday(endDate) ? (lang === 'en' ? 'Today' : '今天') : `${mo[endDate.getMonth()]} ${endDate.getDate()}`
        label = `${e}  ↓  ${s}`
      }

      onFilterRef.current(start, end, label, stepDays)
    }

    function snapToIdx(idx: number) {
      activeIdx = Math.max(0, Math.min(idx, anchors.length - 1))
      stateRef.current.activeIdx = activeIdx
      updateFilterTag()
      scrollToAnimated(activeIdx * ITEM_H)
    }

    function scrollToAnimated(targetTop: number) {
      if (!track || Math.abs(track.scrollTop - targetTop) < 1) return
      if (scrollAnimId) cancelAnimationFrame(scrollAnimId)
      const currentTrack = track

      const startT = performance.now()
      const startY = currentTrack.scrollTop
      const dist = targetTop - startY

      // Distance-based duration mimicking native physics (min 400ms, max 800ms)
      const duration = Math.max(400, Math.min(800, Math.abs(dist) * 0.8))
      currentTrack.style.scrollSnapType = 'none'

      function step(now: number) {
        const elapsed = Math.max(0, now - startT)
        const progress = Math.min(elapsed / duration, 1)

        // easeInOutCubic for perfect momentum
        const ease = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2

        currentTrack.scrollTop = startY + dist * ease

        if (progress < 1) {
          scrollAnimId = requestAnimationFrame(step)
        } else {
          currentTrack.style.scrollSnapType = 'y mandatory'
          scrollAnimId = null
          currentTrack.scrollTop = targetTop
        }
      }

      requestAnimationFrame(() => {
        scrollAnimId = requestAnimationFrame(step)
      })
    }

    function onWheelScroll() {
      wrapDom.classList.add('is-scrolling')
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updateContinuous)
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null }
        wrapDom.classList.remove('is-scrolling')
        if (!track) return
        const idx = Math.round(track.scrollTop / ITEM_H)
        activeIdx = Math.max(0, Math.min(idx, anchors.length - 1))
        stateRef.current.activeIdx = activeIdx
        updateWheelStyles()
        updateFilterTag()
      }, 80)
    }

    function handleTf(days: number) {
      if (days === 1) {
        if (stepDays === 1 && activeIdx === 0) return
        if (stepDays !== 1) {
          const cur = anchors[activeIdx]
          stepDays = 1; stateRef.current.stepDays = 1
          buildAnchors()
          const daysBack = Math.round((TODAY.getTime() - cur.getTime()) / 86400000)
          activeIdx = Math.max(0, Math.min(daysBack, anchors.length - 1))
          stateRef.current.activeIdx = activeIdx
          renderWheel()
          scrollToAnimated(0)
        } else {
          activeIdx = 0; stateRef.current.activeIdx = 0
          scrollToAnimated(0)
        }
        return
      }
      if (stepDays === days) return
      const cur = anchors[activeIdx]
      stepDays = days; stateRef.current.stepDays = days
      buildAnchors()
      const daysBack = Math.round((TODAY.getTime() - cur.getTime()) / 86400000)
      activeIdx = Math.max(0, Math.min(Math.round(daysBack / days), anchors.length - 1))
      stateRef.current.activeIdx = activeIdx
      renderWheel()
      if (track) track.scrollTop = activeIdx * ITEM_H
      updateWheelStyles()
      updateFilterTag()
    }

    // Init
    buildAnchors()
    renderWheel()
    if (track) track.scrollTop = activeIdx * ITEM_H
    updateWheelStyles()

    handleTfRef.current = handleTf
    onMountedControls({
      resetToToday: () => {
        handleTf(1)
        setActiveTfStable.current(1)
        Animated.spring(tfAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 300,
          friction: 30,
        }).start()
      },
      switchTo: (days: 1 | 3 | 7 | 30) => {
        const idx = [1, 3, 7, 30].indexOf(days)
        handleTf(days)
        setActiveTfStable.current(days)
        Animated.spring(tfAnim, {
          toValue: idx * 53,
          useNativeDriver: true,
          tension: 300,
          friction: 30,
        }).start()
      },
    })

    return () => {
      style.remove()
      clearTimeout(scrollTimer)
      if (rafId) cancelAnimationFrame(rafId)
      if (scrollAnimId) cancelAnimationFrame(scrollAnimId)
    }
  }, [lang]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.aside}>
      <View style={styles.tfRow}>
        <Animated.View style={[
          styles.tfBtnActive,
          {
            position: 'absolute', left: spacing[1], top: spacing[1], bottom: spacing[1], width: 49,
            transform: [{ translateX: tfAnim }]
          },
        ]} />
        {([1, 3, 7, 30] as const).map(d => (
          <TouchableOpacity
            key={d}
            onPress={() => pressTf(d)}
            style={styles.tfBtn}
          >
            <Text style={[styles.tfBtnText, activeTf === d && styles.tfBtnTextActive]}>
              {d === 1 ? (lang === 'en' ? 'TODAY' : '今天') : `${d}${lang === 'en' ? 'D' : '天'}`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View ref={wrapRef} style={styles.wheelContainer} />
    </View>
  )
}

const styles = StyleSheet.create({
  aside: {
    width: 256, position: 'fixed' as any, top: 64, bottom: 0, left: 0,
    borderRightWidth: 1, borderColor: colors.border.subtle,
    backgroundColor: colors.bg.subtle, padding: 20,
    flexDirection: 'column', gap: spacing[6],
  },
  tfRow: {
    flexDirection: 'row', gap: spacing[1],
    backgroundColor: 'rgba(228,228,231,0.5)', padding: spacing[1], borderRadius: spacing[2],
  },
  tfBtn: {
    flex: 1, paddingVertical: 6, paddingHorizontal: spacing[2],
    borderRadius: 6, alignItems: 'center',
  },
  tfBtnActive: {
    backgroundColor: colors.bg.card, borderRadius: 6,
    shadowColor: '#000', shadowOpacity: 0.08,
    shadowRadius: 2, shadowOffset: { width: 0, height: 1 },
  },
  tfBtnText: {
    fontSize: typography.size.base, fontWeight: typography.weight.semibold, color: colors.text.tertiary,
    fontFamily: typography.family.body, letterSpacing: typography.tracking.wide,
    transform: [{ scale: 0.833 }],
  },
  tfBtnTextActive: { color: colors.text.primary, fontWeight: typography.weight.bold },
  wheelContainer: { flex: 1 },
})
