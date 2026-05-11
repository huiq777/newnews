export type Channel = 'feishu' | 'slack' | 'discord' | 'telegram' | 'wecom' | 'notion'

export interface RenderedPayload {
  bodies: unknown[]
}

const SLACK_BLOCK_MAX = 2900
const DISCORD_EMBED_DESC_MAX = 4000
const TELEGRAM_MSG_MAX = 3500
const DISCORD_EMBED_CAP = 10
// WeCom enforces ≤4096 bytes UTF-8 per message; 3500 leaves headroom for chunk
// glue (paragraph separators) and any future render decoration.
const WECOM_MSG_MAX_BYTES = 3500

function slackifyMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/gs, '*$1*')
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function tgBoldify(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
}

function chunkByParagraph(s: string, maxLen: number): string[] {
  const paragraphs = s.split(/\n\n+/)
  const chunks: string[] = []
  let cur = ''
  for (const p of paragraphs) {
    if (p.length > maxLen) {
      if (cur) { chunks.push(cur); cur = '' }
      for (let i = 0; i < p.length; i += maxLen) chunks.push(p.slice(i, i + maxLen))
      continue
    }
    const candidate = cur ? `${cur}\n\n${p}` : p
    if (candidate.length <= maxLen) { cur = candidate; continue }
    chunks.push(cur)
    cur = p
  }
  if (cur) chunks.push(cur)
  return chunks
}

// Byte-aware variant for WeCom (4096-byte UTF-8 ceiling). Chinese characters
// are 3 bytes each, so a char-counted chunker would overshoot. If a single
// paragraph exceeds maxBytes we fall back to byte-safe slicing on a code-point
// boundary by walking forward until the encoded length would exceed the cap.
function chunkByParagraphBytes(s: string, maxBytes: number): string[] {
  const enc = new TextEncoder()
  const byteLen = (str: string) => enc.encode(str).length
  const paragraphs = s.split(/\n\n+/)
  const chunks: string[] = []
  let cur = ''
  for (const p of paragraphs) {
    if (byteLen(p) > maxBytes) {
      if (cur) { chunks.push(cur); cur = '' }
      let i = 0
      while (i < p.length) {
        let j = i, b = 0
        while (j < p.length) {
          const cp = p.codePointAt(j) ?? 0
          const w = cp > 0xffff ? 2 : 1
          const nb = byteLen(p.slice(j, j + w))
          if (b + nb > maxBytes) break
          b += nb
          j += w
        }
        chunks.push(p.slice(i, j))
        i = j
      }
      continue
    }
    const candidate = cur ? `${cur}\n\n${p}` : p
    if (byteLen(candidate) <= maxBytes) { cur = candidate; continue }
    chunks.push(cur)
    cur = p
  }
  if (cur) chunks.push(cur)
  return chunks
}

export function formatDateLabel(anchorDate: string, stepDays: number): string {
  const anchor = new Date(anchorDate + 'T00:00:00Z')
  const fmt = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
  if (stepDays <= 1) return fmt(anchor)
  const start = new Date(anchor.getTime() - (stepDays - 1) * 86_400_000)
  return `${fmt(start)} - ${fmt(anchor)}`
}

export function renderBrief(channel: Channel, synthesis: string, today: string, stepDays = 1): RenderedPayload {
  const dateLabel = formatDateLabel(today, stepDays)
  switch (channel) {
    case 'feishu':
      return {
        bodies: [{
          msg_type: 'interactive',
          card: {
            header: { title: { content: stepDays <= 1 ? `每日趋势简报 — ${dateLabel}` : `趋势简报 — ${dateLabel}`, tag: 'plain_text' }, template: 'blue' },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: synthesis } },
            ],
          },
        }],
      }

    case 'slack': {
      const chunks = chunkByParagraph(slackifyMd(synthesis), SLACK_BLOCK_MAX)
      const blocks: unknown[] = [
        { type: 'header', text: { type: 'plain_text', text: stepDays >= 30 ? `Monthly Trend Brief — ${dateLabel}` : stepDays >= 7 ? `Weekly Trend Brief — ${dateLabel}` : `Daily Trend Brief — ${dateLabel}` } },
        ...chunks.map(c => ({ type: 'section', text: { type: 'mrkdwn', text: c } })),
      ]
      return { bodies: [{ blocks }] }
    }

    case 'discord': {
      const chunks = chunkByParagraph(synthesis, DISCORD_EMBED_DESC_MAX)
      const embeds = chunks.slice(0, DISCORD_EMBED_CAP).map((c, i) => {
        const embed: Record<string, unknown> = { description: c, color: 0x3B82F6 }
        if (i === 0) embed.title = stepDays >= 30 ? `Monthly Trend Brief — ${dateLabel}` : stepDays >= 7 ? `Weekly Trend Brief — ${dateLabel}` : `Trend Brief — ${dateLabel}`
        return embed
      })
      return { bodies: [{ embeds }] }
    }

    case 'telegram': {
      const prepared = tgBoldify(htmlEscape(synthesis))
      const chunks = chunkByParagraph(prepared, TELEGRAM_MSG_MAX)
      return {
        bodies: chunks.map((c, i) => ({
          text: i === 0 ? `<b>${stepDays >= 30 ? 'Monthly Trend Brief' : stepDays >= 7 ? 'Weekly Trend Brief' : 'Trend Brief'} — ${dateLabel}</b>\n\n${c}` : c,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        })),
      }
    }

    case 'wecom': {
      // WeCom incoming-webhook bot accepts plain markdown (no lark_md, no
      // tables). The brief LLM already emits a clean intersection — passthrough.
      // Header is a single paragraph so chunk packing keeps it with the first
      // body block when there's room.
      const withHeader = `**${stepDays <= 1 ? '每日趋势简报' : '趋势简报'} — ${dateLabel}**\n\n${synthesis}`
      const chunks = chunkByParagraphBytes(withHeader, WECOM_MSG_MAX_BYTES)
      return {
        bodies: chunks.map(c => ({
          msgtype: 'markdown',
          markdown: { content: c },
        })),
      }
    }

    case 'notion':
      // Notion uses a structured-block POST, not a JSON body that fits the
      // RenderedPayload shape. The send path calls markdownToBlocks() directly
      // in index.ts. renderBrief() is not the right seam for Notion.
      throw new Error('renderBrief: notion is rendered by markdownToBlocks() in index.ts, not here')
  }
}
