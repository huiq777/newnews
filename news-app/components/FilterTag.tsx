import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { colors, typography, spacing } from '../theme/tokens'

export default function FilterTag({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <View style={styles.filterTagRow}>
      <View style={styles.filterTag}>
        <Text style={styles.filterTagText}>{label}</Text>
        <TouchableOpacity onPress={onClear} style={{ opacity: 0.5 }}>
          <Text style={styles.filterTagText}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  filterTagRow: { marginBottom: spacing[6] },
  filterTag: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[2],
    alignSelf: 'flex-start', backgroundColor: colors.bg.pill,
    paddingHorizontal: spacing[3], paddingVertical: 6, borderRadius: 999
  },
  filterTagText: {
    fontSize: typography.size.base, fontWeight: typography.weight.bold, color: colors.bg.primary,
    fontFamily: typography.family.body, letterSpacing: 0.5,
    transform: [{ scale: 0.916 }],
  },
})
