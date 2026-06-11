import { useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { colors, typography, spacing } from '../theme/tokens'

export type LoginActionButtonProps = {
  label?: string
  onPress: () => void
  compact?: boolean
  hoveredOverride?: boolean
}

export default function LoginActionButton({
  label = 'Login',
  onPress,
  compact = false,
  hoveredOverride = false,
}: LoginActionButtonProps) {
  const [hovered, setHovered] = useState(false)
  const effectiveHovered = hovered || hoveredOverride
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.button,
        compact && styles.buttonCompact,
        effectiveHovered && styles.buttonHovered,
      ]}
    >
      <Text style={[styles.text, compact && styles.textCompact]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border.default,
    backgroundColor: 'transparent',
    paddingHorizontal: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: {
    minHeight: 28,
    paddingHorizontal: spacing[2],
  },
  buttonHovered: {
    borderColor: colors.text.secondary,
    backgroundColor: colors.bg.hover,
  },
  text: {
    fontSize: typography.size.base,
    color: colors.text.secondary,
    fontFamily: typography.family.body,
    fontWeight: typography.weight.bold,
  },
  textCompact: {
    fontSize: typography.size.sm,
  },
})
