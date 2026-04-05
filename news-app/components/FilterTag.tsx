import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'

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
  filterTagRow: { marginBottom: 24 },
  filterTag: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    alignSelf: 'flex-start', backgroundColor: '#2d3432',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999
  },
  filterTagText: {
    fontSize: 12, fontWeight: '700', color: '#f9f9f7',
    fontFamily: 'Space Grotesk, sans-serif', letterSpacing: 0.5,
    transform: [{ scale: 0.916 }],
  },
})
