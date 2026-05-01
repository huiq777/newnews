import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import DOMPurify from 'dompurify'

export default function WebHTML({ html, style }: { html: string; style?: object }) {
  const ref = useRef<any>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const node = ref.current as unknown as HTMLElement | null
    if (node) node.innerHTML = DOMPurify.sanitize(html)
  }, [html])
  return <View ref={ref} style={style} />
}
