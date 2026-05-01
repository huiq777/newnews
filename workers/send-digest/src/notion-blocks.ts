// Markdown → Notion block converter for send-digest.
// Spec: docs/superpowers/specs/2026-04-29-delivery-channels-wecom-notion-design.md §2
//
// The trend brief LLM emits a small markdown subset: paragraphs, occasional
// `**bold**`, occasional `- ` bullets, occasional `## ` subheads. A 60-line
// inline parser is sufficient — no library dependency.
//
// Notion's POST /v1/pages accepts up to 100 children per call. A typical
// brief is 5–20 blocks; the cap is unreachable in practice. If a future
// brief crosses the limit, the caller must switch to a two-step pattern
// (POST /pages with first 100 + PATCH /blocks/{id}/children for the rest).

export type RichText = {
  type: 'text'
  text: { content: string }
  annotations?: { bold?: boolean }
}

export type Block =
  | { type: 'paragraph'; paragraph: { rich_text: RichText[] } }
  | { type: 'heading_2'; heading_2: { rich_text: RichText[] } }
  | { type: 'bulleted_list_item'; bulleted_list_item: { rich_text: RichText[] } }

function chunkText(text: string, maxLen: number = 2000): string[] {
  if (!text) return []
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen))
  }
  return chunks
}

function parseInline(text: string): RichText[] {
  const out: RichText[] = []
  // Split on **bold** segments; preserve order. Non-greedy match, no nested.
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**')) {
      const content = part.slice(2, -2)
      for (const chunk of chunkText(content)) {
        out.push({
          type: 'text',
          text: { content: chunk },
          annotations: { bold: true },
        })
      }
    } else {
      for (const chunk of chunkText(part)) {
        out.push({ type: 'text', text: { content: chunk } })
      }
    }
  }
  return out
}

export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = []
  const paragraphs = md.split(/\n\s*\n/)
  for (const p of paragraphs) {
    const trimmed = p.trim()
    if (!trimmed) continue

    // Heading (# / ## / ### all collapse to heading_2 — Notion only has h1/h2/h3
    // and the brief structure rarely warrants distinguishing them visually).
    if (/^#{1,3}\s/.test(trimmed)) {
      blocks.push({
        type: 'heading_2',
        heading_2: { rich_text: parseInline(trimmed.replace(/^#{1,3}\s/, '')) },
      })
      continue
    }

    // Bulleted list — every line in the paragraph block must be a bullet.
    const lines = trimmed.split('\n')
    if (lines.every(l => /^\s*[-•]\s/.test(l))) {
      for (const line of lines) {
        blocks.push({
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: parseInline(line.replace(/^\s*[-•]\s/, '')),
          },
        })
      }
      continue
    }

    blocks.push({ type: 'paragraph', paragraph: { rich_text: parseInline(trimmed) } })
  }
  return blocks
}
