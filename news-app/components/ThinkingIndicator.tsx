import { useEffect, useState } from 'react'
import { StyleSheet, Text, View, Pressable } from 'react-native'
import { colors, typography } from '../theme/tokens'

export default function ThinkingIndicator({
  lang,
  thinkingContent,
}: {
  lang: 'en' | 'zh'
  thinkingContent: string
}) {
  const [dots, setDots] = useState('.')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    const startMs = Date.now()
    let tick = 0
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startMs)
      tick++
      if (tick % 2 === 0) {
        setDots(d => d === '...' ? '.' : d === '.' ? '..' : '...')
      }
    }, 100)
    return () => clearInterval(timer)
  }, [])

  const sec = (elapsedMs / 1000).toFixed(1)
  const showText = lang === 'en' ? 'Show thinking' : '显示思考过程'
  const hideText = lang === 'en' ? 'Hide thinking' : '隐藏思考过程'

  const color = hovered ? colors.text.primary : colors.text.muted

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => setExpanded(e => !e)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={styles.headerRow}
      >
        <Text style={[styles.headerText, { color }]}>
          {expanded ? hideText : showText}
        </Text>
        <Text style={[styles.headerText, { color, width: 18 }]}> {dots}</Text>
        <Text style={[styles.headerText, { color }]}> ({sec}s) {expanded ? '▲' : '▼'}</Text>
      </Pressable>

      {expanded && thinkingContent.length > 0 && (
        <View style={styles.thinkingBlock}>
          <Text style={styles.thinkingText}>{thinkingContent}</Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { marginTop: 4 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  headerText: {
    fontSize: typography.size.base,
    fontStyle: 'italic',
    lineHeight: typography.leading.tight,
    transition: 'color 0.2s ease',
  },
  thinkingBlock: {
    backgroundColor: colors.bg.hover,
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
  },
  thinkingText: {
    fontSize: typography.size.base,
    color: colors.text.muted,
    lineHeight: typography.leading.tight,
  },
})
