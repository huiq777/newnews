import { Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/tokens'

export default function MarkdownText({ text, style }: { text: string; style?: object }) {
  const isBullet = text.trimStart().startsWith('•')
  const content = isBullet ? text.replace(/^\s*•\s*/, '') : text
  const parts = content.split(/\*\*([^*]+)\*\*/)
  const inner = (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <Text key={i} style={{ fontWeight: typography.weight.bold }}>{part}</Text>
          : part
      )}
    </Text>
  )
  if (isBullet) {
    return (
      <View style={{ flexDirection: 'row', marginBottom: 6, alignItems: 'flex-start' }}>
        <Text style={[style, { marginRight: spacing[2], color: colors.text.muted, lineHeight: typography.leading.relaxed }]}>•</Text>
        <View style={{ flex: 1 }}>{inner}</View>
      </View>
    )
  }
  return inner
}
