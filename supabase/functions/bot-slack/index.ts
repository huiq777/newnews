import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 })

  let body: any
  try {
    body = JSON.parse(await req.text())
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Slack URL verification challenge
  if (body.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Only handle app_mention events
  if (body.type !== 'event_callback' || body.event?.type !== 'app_mention') {
    return new Response('OK', { status: 200 })
  }

  const event = body.event
  const botUserId: string = body.authorizations?.[0]?.user_id ?? ''

  // Strip the bot mention from the text
  const stripped = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim()

  const token = Deno.env.get('SLACK_BOT_TOKEN') ?? ''
  const adminUserId = Deno.env.get('SLACK_ADMIN_USER_ID') ?? ''
  const adminMention = adminUserId ? `<@${adminUserId}>` : '@admin'
  const askerTag = event.user ? `<@${event.user}>` : 'A user'

  const text =
    stripped.length < 10
      ? `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel @ 8:30 PM.\nFor complex questions, @mention me with your question and I'll escalate to the admin.`
      : `This question is beyond my current scope. Notifying ${adminMention}.\n\n📋 ${askerTag} asked:\n"${stripped}"`

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: event.channel, text }),
  })

  return new Response('OK', { status: 200 })
})
