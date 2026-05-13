import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

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

  const text =
    stripped.length < 10
      ? `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel @ 8:30 PM.\nFor complex questions, @mention me with your question and I'll escalate to the admin.`
      : `This question is beyond my current scope. Notifying @${adminUsername}.\n\n📋 ${askerTag} asked:\n"${stripped}"`

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })

  return new Response('OK', { status: 200 })
})
