import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Category } from '../lib/config'
import { colors, typography, spacing } from '../theme/tokens'
import WhatsNewPopover from './WhatsNewPopover'

export default function NavBar({
  lang,
  activeCategory,
  onLangChange,
  onCategoryChange,
}: {
  lang: 'en' | 'zh'
  activeCategory: Category
  onLangChange: (l: 'en' | 'zh') => void
  onCategoryChange: (cat: Category) => void
}) {
  const langAnim = useRef(new Animated.Value(0)).current
  const langVisAnim = useRef(new Animated.Value(1)).current
  const langVisible = useRef(true)
  const [whatsNewOpen, setWhatsNewOpen] = useState(false)
  const [whatsNewHovered, setWhatsNewHovered] = useState(false)

  useEffect(() => {
    Animated.spring(langAnim, {
      toValue: lang === 'en' ? 0 : 40,
      useNativeDriver: true,
      tension: 300,
      friction: 30,
    }).start()
  }, [lang])

  // Close popover on outside interaction (wheel, touch, click)
  // We use capture phase so we can detect the event before it reaches React,
  // and we specifically whitelist interactions that shouldn't close the popover.
  useEffect(() => {
    if (typeof window === 'undefined' || !whatsNewOpen) return
    const onInteract = (e: Event) => {
      const target = e.target as HTMLElement
      if (!target || !target.closest) return
      
      // Ignore interactions inside the popover itself
      if (target.closest('#whats-new-popover')) return
      // Ignore interactions with the toggle button
      if (target.closest('#whats-new-btn')) return
      // Ignore interactions with the language pill
      if (target.closest('#nav-lang-pill')) return

      setWhatsNewOpen(false)
    }
    
    window.addEventListener('wheel', onInteract, { passive: true, capture: true })
    window.addEventListener('touchstart', onInteract, { passive: true, capture: true })
    window.addEventListener('mousedown', onInteract, { passive: true, capture: true })
    
    return () => {
      window.removeEventListener('wheel', onInteract, { capture: true })
      window.removeEventListener('touchstart', onInteract, { capture: true })
      window.removeEventListener('mousedown', onInteract, { capture: true })
    }
  }, [whatsNewOpen])

function onNavLayout(e: any) {
    const w = e.nativeEvent.layout.width
    const shouldShow = w >= 700
    if (shouldShow !== langVisible.current) {
      langVisible.current = shouldShow
      Animated.timing(langVisAnim, {
        toValue: shouldShow ? 1 : 0,
        duration: 180,
        useNativeDriver: true,
      }).start()
    }
  }

  return (
    <View style={styles.nav} onLayout={onNavLayout}>
      <View style={styles.navLogoCol}>
        <Text style={styles.navLogoText}>Newnews</Text>
      </View>
      <View style={styles.navTabsCol}>
        {([
          ['all', lang === 'en' ? 'All' : '全部'],
          ['industry', lang === 'en' ? 'Industry' : '行业'],
          ['technical_frontier', lang === 'en' ? 'Frontier' : '前沿'],
          ['career_community', lang === 'en' ? 'Career' : '职场'],
        ] as const).map(([key, label]) => (
          <TouchableOpacity
            key={key}
            onPress={() => onCategoryChange(key)}
            style={styles.navTabItem}
          >
            {/* bold ghost reserves width so active state never shifts layout */}
            <Text style={[styles.navTabText, styles.navTabTextActive, { opacity: 0 }]} aria-hidden>
              {label}
            </Text>
            <Text style={[styles.navTabText, activeCategory === key && styles.navTabTextActive, { position: 'absolute', top: 0, left: 0, right: 0 }]}>
              {label}
            </Text>
            {activeCategory === key && <View style={styles.navTabUnderline} />}
          </TouchableOpacity>
        ))}
      </View>
      <Animated.View style={[styles.navLangCol, { opacity: langVisAnim }]}
        pointerEvents={langVisible.current ? 'auto' : 'none'}>
        {/* What's New button — popover rendered at nav root to avoid stacking context issues */}
        <View style={styles.whatsNewWrap}>
          <Pressable
            nativeID="whats-new-btn"
            onPress={() => setWhatsNewOpen(o => !o)}
            onHoverIn={() => setWhatsNewHovered(true)}
            onHoverOut={() => setWhatsNewHovered(false)}
            style={[styles.whatsNewBtn, whatsNewHovered && styles.whatsNewBtnHovered]}
          >
            <Text style={styles.whatsNewText}>?</Text>
          </Pressable>
        </View>

        <View style={styles.navLangPill} nativeID="nav-lang-pill">
          <Animated.View style={[
            styles.navLangBtnActive,
            {
              position: 'absolute', left: 4, top: 4, bottom: 4, width: 40, borderRadius: 999,
              transform: [{ translateX: langAnim }]
            },
          ]} />
          <TouchableOpacity onPress={() => onLangChange('en')} style={styles.navLangBtn}>
            <Text style={[styles.navLangText, lang === 'en' && styles.navLangTextActive]}>EN</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onLangChange('zh')} style={styles.navLangBtn}>
            <Text style={[styles.navLangText, lang === 'zh' && styles.navLangTextActive]}>中</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* Popover rendered at nav root — avoids Animated.View stacking context */}
      {whatsNewOpen && (
        <WhatsNewPopover lang={lang} onClose={() => setWhatsNewOpen(false)} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  nav: {
    height: 64, flexDirection: 'row', alignItems: 'flex-end',
    paddingBottom: 14,
    borderBottomWidth: 1, borderColor: colors.border.subtle,
    backgroundColor: 'rgba(255,255,255,0.8)',
    position: 'fixed' as any, top: 0, left: 0, right: 0, zIndex: 50,
  },
  navLogoCol: { width: 256, paddingHorizontal: 20 },
  navLogoText: {
    fontSize: typography.size['3xl'], fontWeight: typography.weight.bold, color: colors.text.primary,
    fontFamily: typography.family.heading, letterSpacing: typography.tracking.tight,
  },
  navTabsCol: {
    flex: 1, flexDirection: 'row', paddingHorizontal: spacing[8],
    gap: spacing[8], alignItems: 'flex-end',
  },
  navTabItem: { position: 'relative', paddingBottom: 4 },
  navTabText: {
    fontSize: typography.size.lg, fontWeight: typography.weight.medium, color: colors.text.secondary,
    fontFamily: typography.family.heading,
  },
  navTabTextActive: { fontWeight: typography.weight.bold, color: colors.text.primary },
  navTabUnderline: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 2, backgroundColor: colors.text.primary,
  },
  navLangCol: { paddingHorizontal: spacing[8], flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  whatsNewWrap: { position: 'relative' },
  whatsNewBtn: {
    width: 28, height: 28, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border.default,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  whatsNewBtnHovered: {
    borderColor: colors.text.secondary,
    backgroundColor: colors.bg.hover,
  },
  whatsNewText: {
    fontSize: typography.size.sm,
    color: colors.text.secondary,
    fontFamily: typography.family.body,
    fontWeight: typography.weight.bold,
  },
  whatsNewBackdrop: {
    position: 'fixed' as any,
    top: 64, left: 0, right: 0, bottom: 0,
    zIndex: 49,
  },
  navLangPill: {
    flexDirection: 'row', backgroundColor: 'rgba(228,228,231,0.5)',
    borderRadius: 999, padding: 4,
  },
  navLangBtn: {
    width: 40, paddingVertical: 4, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
  },
  navLangBtnActive: { backgroundColor: colors.bg.pill },
  navLangText: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.text.secondary,
    fontFamily: typography.family.body,
    transform: [{ scale: 0.833 }],
  },
  navLangTextActive: { color: colors.bg.primary },
})
