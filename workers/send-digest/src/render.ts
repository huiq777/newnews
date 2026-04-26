export type Channel = 'feishu' | 'slack' | 'discord' | 'telegram'

export interface RenderedPayload {
  bodies: unknown[]
}

const SLACK_BLOCK_MAX = 2900
const DISCORD_EMBED_DESC_MAX = 4000
const TELEGRAM_MSG_MAX = 3500
const DISCORD_EMBED_CAP = 10

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

export function renderBrief(channel: Channel, synthesis: string, today: string): RenderedPayload {
  switch (channel) {
    case 'feishu':
      return {
        bodies: [{
          msg_type: 'interactive',
          card: {
            header: { title: { content: `每日趋势简报 — ${today}`, tag: 'plain_text' }, template: 'blue' },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: synthesis } },
            ],
          },
        }],
      }

    case 'slack': {
      const chunks = chunkByParagraph(slackifyMd(synthesis), SLACK_BLOCK_MAX)
      const blocks: unknown[] = [
        { type: 'header', text: { type: 'plain_text', text: `Daily Trend Brief — ${today}` } },
        ...chunks.map(c => ({ type: 'section', text: { type: 'mrkdwn', text: c } })),
      ]
      return { bodies: [{ blocks }] }
    }

    case 'discord': {
      const chunks = chunkByParagraph(synthesis, DISCORD_EMBED_DESC_MAX)
      const embeds = chunks.slice(0, DISCORD_EMBED_CAP).map((c, i) => {
        const embed: Record<string, unknown> = { description: c, color: 0x3B82F6 }
        if (i === 0) embed.title = `Trend Brief — ${today}`
        return embed
      })
      return { bodies: [{ embeds }] }
    }

    case 'telegram': {
      const prepared = tgBoldify(htmlEscape(synthesis))
      const chunks = chunkByParagraph(prepared, TELEGRAM_MSG_MAX)
      return {
        bodies: chunks.map((c, i) => ({
          text: i === 0 ? `<b>Trend Brief — ${today}</b>\n\n${c}` : c,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        })),
      }
    }
  }
}
