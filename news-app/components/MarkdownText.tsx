import { Text, View } from 'react-native'

export default function MarkdownText({ text, style }: { text: string; style?: object }) {
  const isBullet = text.trimStart().startsWith('•')
  const content = isBullet ? text.replace(/^\s*•\s*/, '') : text
  const parts = content.split(/\*\*([^*]+)\*\*/)
  const inner = (
    <Text style={style}>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <Text key={i} style={{ fontWeight: '700' }}>{part}</Text>
          : part
      )}
    </Text>
  )
  if (isBullet) {
    return (
      <View style={{ flexDirection: 'row', marginBottom: 6, alignItems: 'flex-start' }}>
        <Text style={[style, { marginRight: 8, color: '#9E9690', lineHeight: 22 }]}>•</Text>
        <View style={{ flex: 1 }}>{inner}</View>
      </View>
    )
  }
  return inner
}
