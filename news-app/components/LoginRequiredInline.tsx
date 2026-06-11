import { useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { colors, typography, spacing } from '../theme/tokens'
import LoginActionButton from './LoginActionButton'

export type LoginRequiredInlineProps = {
  message?: string
  onLoginPress: () => void
}

const DEFAULT_MESSAGE = 'Please log in to view this.'

export default function LoginRequiredInline({
  message,
  onLoginPress,
}: LoginRequiredInlineProps) {
  const [hovered, setHovered] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={message ?? DEFAULT_MESSAGE}
      onPress={onLoginPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.lockedRow, hovered && styles.lockedRowHovered]}
    >
      <Text style={styles.lockedText}>{message ?? DEFAULT_MESSAGE}</Text>
      <LoginActionButton label="Login" compact onPress={onLoginPress} hoveredOverride={hovered} />
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
