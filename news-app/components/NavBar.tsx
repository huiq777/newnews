import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Category } from '../lib/config'

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

  useEffect(() => {
    Animated.spring(langAnim, {
      toValue: lang === 'en' ? 0 : 40,
      useNativeDriver: true,
      tension: 300,
      friction: 30,
    }).start()
  }, [lang])

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
        <View style={styles.navLangPill}>
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
    </View>
  )
}

const styles = StyleSheet.create({
  nav: {
    height: 64, flexDirection: 'row', alignItems: 'flex-end',
    paddingBottom: 14,
    borderBottomWidth: 1, borderColor: '#f4f4f5',
    backgroundColor: 'rgba(255,255,255,0.8)',
    position: 'fixed' as any, top: 0, left: 0, right: 0, zIndex: 50,
  },
  navLogoCol: { width: 256, paddingHorizontal: 20 },
  navLogoText: {
    fontSize: 20, fontWeight: '700', color: '#18181b',
    fontFamily: 'Manrope, sans-serif', letterSpacing: -0.5,
  },
  navTabsCol: {
    flex: 1, flexDirection: 'row', paddingHorizontal: 32,
    gap: 32, alignItems: 'flex-end',
  },
  navTabItem: { position: 'relative', paddingBottom: 4 },
  navTabText: {
    fontSize: 14, fontWeight: '500', color: '#71717a',
    fontFamily: 'Manrope, sans-serif',
  },
  navTabTextActive: { fontWeight: '700', color: '#18181b' },
  navTabUnderline: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 2, backgroundColor: '#18181b',
  },
  navLangCol: { paddingHorizontal: 32, alignItems: 'center', justifyContent: 'center' },
  navLangPill: {
    flexDirection: 'row', backgroundColor: 'rgba(228,228,231,0.5)',
    borderRadius: 999, padding: 4,
  },
  navLangBtn: {
    width: 40, paddingVertical: 4, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
  },
  navLangBtnActive: { backgroundColor: '#2d3432' },
  navLangText: {
    fontSize: 12, fontWeight: '700', color: '#71717a',
    fontFamily: 'Space Grotesk, sans-serif',
    transform: [{ scale: 0.833 }],
  },
  navLangTextActive: { color: '#f9f9f7' },
})
