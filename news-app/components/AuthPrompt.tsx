import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import type { OAuthProvider } from '../lib/auth'
import { colors, typography, spacing } from '../theme/tokens'

export type AuthPromptProps = {
  visible: boolean
  authError?: string | null
  onDismiss: () => void
  onSignIn: (provider: OAuthProvider) => void
}

export default function AuthPrompt({
  visible,
  authError,
  onDismiss,
  onSignIn,
}: AuthPromptProps) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss}>
        <Pressable style={styles.panel}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Sign in to continue</Text>
            <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.closeText}>x</Text>
            </Pressable>
          </View>
          <Text style={styles.body}>Daily news is public. Analysis tools require an account.</Text>
          {!!authError && <Text style={styles.errorText}>{authError}</Text>}
          <View style={styles.actions}>
            <Pressable style={styles.providerButton} onPress={() => onSignIn('github')}>
              <Text style={styles.providerText}>GitHub</Text>
            </Pressable>
            <Pressable style={styles.providerButton} onPress={() => onSignIn('google')}>
              <Text style={styles.providerText}>Google</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(26,26,26,0.26)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[4],
  },
  panel: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 8,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.border.warm,
    padding: spacing[4],
    gap: spacing[3],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: typography.size.xl,
    fontWeight: typography.weight.bold,
    color: colors.text.primary,
    fontFamily: typography.family.heading,
  },
  closeText: {
    fontSize: typography.size.lg,
    color: colors.text.muted,
    fontWeight: typography.weight.bold,
  },
  body: {
    fontSize: typography.size.base,
    color: colors.text.muted,
    lineHeight: typography.leading.normal,
  },
  errorText: {
    fontSize: typography.size.base,
    color: '#A33A2B',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  providerButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: 6,
    backgroundColor: colors.text.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerText: {
    color: colors.text.inverse,
    fontSize: typography.size.base,
    fontWeight: typography.weight.bold,
  },
})
