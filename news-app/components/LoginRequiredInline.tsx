import { useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { colors, typography, spacing } from '../theme/tokens'
import LoginActionButton from './LoginActionButton'

export type LoginRequiredInlineProps = {
  lang?: 'en' | 'zh'
  message?: string
  onLoginPress: () => void
}

const defaultMessage = (lang: 'en' | 'zh') =>
  lang === 'en' ? 'Please log in to view this.' : '请登录后查看。'

export default function LoginRequiredInline({
  lang = 'en',
  message,
  onLoginPress,
}: LoginRequiredInlineProps) {
  const [hovered, setHovered] = useState(false)
  const resolvedMessage = message ?? defaultMessage(lang)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={resolvedMessage}
      onPress={onLoginPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.lockedRow, hovered && styles.lockedRowHovered]}
    >
      <Text style={styles.lockedText}>{resolvedMessage}</Text>
      <LoginActionButton label={lang === 'en' ? 'Login' : '登录'} compact onPress={onLoginPress} hoveredOverride={hovered} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  lockedRow: {
    marginTop: spacing[3],
    marginBottom: spacing[2],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border.warm,
    backgroundColor: '#FAF9F7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  lockedRowHovered: {
    borderColor: colors.text.secondary,
    backgroundColor: colors.bg.hover,
  },
  lockedText: {
    flex: 1,
    fontSize: typography.size.base,
    color: colors.text.muted,
    fontFamily: typography.family.body,
  },
})
