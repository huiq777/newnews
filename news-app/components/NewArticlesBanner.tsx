import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, Text } from 'react-native'

export default function NewArticlesBanner({
  count,
  lang,
  onLoad,
}: {
  count: number
  lang: 'en' | 'zh'
  onLoad: () => void
}) {
  const opacity = useRef(new Animated.Value(0)).current
  const translateY = useRef(new Animated.Value(-8)).current

  useEffect(() => {
    if (count > 0) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, tension: 80, friction: 12, useNativeDriver: true }),
      ]).start()
    } else {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: -8, duration: 150, useNativeDriver: true }),
      ]).start()
    }
  }, [count > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  if (count === 0) return null

  const label = lang === 'en'
    ? `↑  ${count} new article${count === 1 ? '' : 's'}`
    : `↑  ${count} 篇新文章`

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      <Pressable
        onPress={onLoad}
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      >
        <Text style={styles.label}>{label}</Text>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    top: 18,           // centred in the 64px navbar
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 200,
    pointerEvents: 'box-none' as any,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2d3432',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillPressed: {
    backgroundColor: '#3f3f46',
  },
  label: {
    color: '#f9f9f7',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Space Grotesk, sans-serif',
    letterSpacing: 0.5,
    transform: [{ scale: 0.916 }],
  },
})
