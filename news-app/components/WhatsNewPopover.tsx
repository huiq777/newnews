import { useEffect } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { CHANGELOG } from '../lib/changelog'
import { colors, typography, spacing, shadows } from '../theme/tokens'

export default function WhatsNewPopover({
  lang,
  onClose,
}: {
  lang: 'en' | 'zh'
  onClose: () => void
}) {
  // Escape key to close (web)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  function fmtDate(iso: string) {
    const [, mm, dd] = iso.split('-')
    return `${parseInt(mm)}/${parseInt(dd)}`
  }

  return (
    <View style={styles.popover} nativeID="whats-new-popover">
      <Text style={styles.title}>{lang === 'en' ? "What's New" : '最新动态'}</Text>
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} nativeID="whats-new-scroll">
        {CHANGELOG.map((entry, i) => (
          <View key={i} style={[styles.entry, i > 0 && styles.entryBorder]}>
            <Text style={styles.date}>{fmtDate(entry.date)}</Text>
            <Text style={styles.desc}>{lang === 'en' ? entry.en : entry.zh}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  popover: {
    position: 'absolute',
    top: 56, right: spacing[8],
    width: 280,
    maxHeight: 360,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.border.default,
    borderRadius: 10,
    overflow: 'hidden',
    zIndex: 51,
    ...shadows.modal,
  },
  title: {
    fontSize: typography.size.sm,
    fontWeight: typography.weight.bold,
    color: colors.text.secondary,
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: typography.family.body,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  scroll: {
    maxHeight: 300,
  },
  entry: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    gap: 2,
  },
  entryBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
  },
  date: {
    fontSize: typography.size.sm,
    color: colors.text.tertiary,
    fontFamily: typography.family.body,
    fontWeight: typography.weight.semibold,
  },
  desc: {
    fontSize: typography.size.md,
    color: colors.text.body,
    fontFamily: typography.family.body,
    lineHeight: typography.leading.normal,
  },
})
