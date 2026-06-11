import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

function isBriefRequest(text: string): boolean {
  const t = text.toLowerCase()
  return ['brief', 'trend', 'newest', '趋势', '简报', '最新', 'latest', 'today', '今天', '每日'].some(kw => t.includes(kw))
}

function isChineseText(text: string): boolean {
  return /[一-鿿]/.test(text)
}

function toTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/gs, '<b>$1</b>')
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 })

  let update: any
  try {
    const raw = await req.text()
    console.log('update:', raw)
    update = JSON.parse(raw)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const message = update?.message ?? update?.channel_post
  if (!message?.text) {
    console.log('no message.text, ignoring')
    return new Response('OK', { status: 200 })
  }

  const botUsername = Deno.env.get('TELEGRAM_BOT_USERNAME') ?? ''
  const entities: any[] = message.entities ?? []

  // Find the entity that @mentions this bot
  const botEntity = entities.find(
    (e) =>
      e.type === 'mention' &&
      message.text.slice(e.offset, e.offset + e.length).toLowerCase() ===
        `@${botUsername.toLowerCase()}`,
  )
  if (!botEntity) return new Response('OK', { status: 200 })

  // Strip the bot @mention from the text
  const stripped = (
    message.text.slice(0, botEntity.offset) +
    message.text.slice(botEntity.offset + botEntity.length)
  ).trim()

  const chatId: number = message.chat.id
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
  const adminUsername = Deno.env.get('TELEGRAM_ADMIN_USERNAME') ?? 'admin'

  const askerUsername = message.from?.username ?? message.sender_chat?.username
  const askerTag = askerUsername ? `@${askerUsername}` : 'A user'

  let text: string

  if (isBriefRequest(stripped)) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const briefRes = await fetch(
      `${supabaseUrl}/rest/v1/trend_briefs?step_days=eq.1&order=generated_at.desc&limit=1&select=synthesis_en,synthesis_zh,anchor_date`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
    )
    const briefs: { synthesis_en: string | null; synthesis_zh: string | null; anchor_date: string }[] = await briefRes.json()
    const brief = briefs[0]
    if (!brief) {
      text = isChineseText(stripped)
        ? `今日趋势简报尚未生成，请稍后再试。`
        : `No trend brief available yet. Check back after 8:30 PM.`
    } else {
      const useChinese = isChineseText(stripped)
      const rawSynthesis = useChinese
        ? (brief.synthesis_zh ?? brief.synthesis_en ?? '')
        : (brief.synthesis_en ?? brief.synthesis_zh ?? '')
      const synthesis = toTelegramHtml(rawSynthesis)
      const dateLabel = brief.anchor_date?.slice(5).replace('-', '/') ?? ''
      text = useChinese
        ? `${askerTag} 最新 AI 趋势简报（${dateLabel}）：\n\n${synthesis}`
        : `${askerTag} Here's the latest AI Trend Brief (${dateLabel}):\n\n${synthesis}`
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
  } else if (stripped.length < 10) {
    text = `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel.\nWant the latest? @mention me and say "trend brief".\nFor other questions, @mention me with your question and I'll escalate to the admin.`
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } else {
    text = `This question is beyond my current scope. Notifying @${adminUsername}.\n\n📋 ${askerTag} asked:\n"${stripped}"`
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  }

  return new Response('OK', { status: 200 })
})
