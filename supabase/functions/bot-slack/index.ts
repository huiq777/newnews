import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

function isBriefRequest(text: string): boolean {
  const t = text.toLowerCase()
  return ['brief', 'trend', 'newest', '趋势', '简报', '最新', 'latest', 'today', '今天', '每日'].some(kw => t.includes(kw))
}

function toSlackBold(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/gs, '*$1*')
}

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
      text = `${askerTag} No trend brief available yet. Check back after 8:30 PM.`
    } else {
      const synthesis = toSlackBold(brief.synthesis_en ?? brief.synthesis_zh ?? '')
      const dateLabel = brief.anchor_date?.slice(5).replace('-', '/') ?? ''
      text = `${askerTag} Here's the latest AI Trend Brief (${dateLabel}):\n\n${synthesis}`
    }
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: event.channel, text }),
    })
  } else if (stripped.length < 10) {
    text = `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel.\nWant the latest? Just @mention me and say "trend brief".\nFor other questions, @mention me with your question and I'll escalate to the admin.`
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: event.channel, text }),
    })
  } else {
    text = `This question is beyond my current scope. Notifying ${adminMention}.\n\n📋 ${askerTag} asked:\n"${stripped}"`
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: event.channel, text }),
    })
  }

  return new Response('OK', { status: 200 })
})
