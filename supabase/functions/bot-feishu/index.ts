import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

function isBriefRequest(text: string): boolean {
  const t = text.toLowerCase()
  return ['brief', 'trend', 'newest', '趋势', '简报', '最新', 'latest', 'today', '今天', '每日'].some(kw => t.includes(kw))
}

function isChineseText(text: string): boolean {
  return /[一-鿿]/.test(text)
}

function synthesisToFeishuLines(synthesis: string): any[][] {
  return synthesis.split('\n').map(line => {
    if (!line.trim()) return [{ tag: 'text', text: '' }]
    const segments = line.split(/(\*\*[^*]+\*\*)/g)
    return segments.filter(s => s).map(seg => {
      if (seg.startsWith('**') && seg.endsWith('**')) {
        return { tag: 'text', text: seg.slice(2, -2), style: ['bold'] }
      }
      return { tag: 'text', text: seg }
    })
  })
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 })

  let body: any
  try {
    body = JSON.parse(await req.text())
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Feishu URL verification challenge
  if (body.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Only handle im.message.receive_v1 events
  if (body.header?.event_type !== 'im.message.receive_v1') {
    return new Response('OK', { status: 200 })
  }

  const event = body.event
  if (event?.message?.message_type !== 'text') return new Response('OK', { status: 200 })

  // Extract text content
  let rawText = ''
  try {
    rawText = JSON.parse(event.message.content)?.text ?? ''
  } catch {
    return new Response('OK', { status: 200 })
  }

  // Only respond if bot is @mentioned
  if (!rawText.includes('@_user_1') && !rawText.includes('@')) {
    return new Response('OK', { status: 200 })
  }

  // Strip @mentions from text
  const stripped = rawText.replace(/@\S+/g, '').trim()

  const appId = Deno.env.get('FEISHU_APP_ID') ?? ''
  const appSecret = Deno.env.get('FEISHU_APP_SECRET') ?? ''
  const adminOpenId = Deno.env.get('FEISHU_ADMIN_OPEN_ID') ?? ''
  const adminDisplayName = Deno.env.get('FEISHU_ADMIN_NAME') ?? 'admin'
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const senderOpenId = event.sender?.sender_id?.open_id ?? ''
  const chatId = event.message.chat_id

  let msgType: string
  let content: string

  if (isBriefRequest(stripped)) {
    // Fetch token + brief in parallel to stay under Feishu's 3s retry threshold
    const [tokenData, briefs] = await Promise.all([
      fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      }).then(r => r.json()),
      fetch(
        `${supabaseUrl}/rest/v1/trend_briefs?step_days=eq.1&order=generated_at.desc&limit=1&select=synthesis_zh,synthesis_en,anchor_date`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
      ).then(r => r.json()),
    ])
    const token = (tokenData as any).tenant_access_token
    const brief = (briefs as any[])[0]

    if (!brief) {
      msgType = 'text'
      content = JSON.stringify({ text: '今日趋势简报尚未生成，请稍后再试。' })
    } else {
      const useChinese = isChineseText(stripped)
      const synthesis = useChinese
        ? (brief.synthesis_zh ?? brief.synthesis_en ?? '')
        : (brief.synthesis_en ?? brief.synthesis_zh ?? '')
      const dateLabel = brief.anchor_date?.slice(5).replace('-', '/') ?? ''
      const titleText = useChinese ? `📊 AI 趋势简报 ${dateLabel}` : `📊 AI Trend Brief ${dateLabel}`

      msgType = 'post'
      content = JSON.stringify({
        zh_cn: {
          title: titleText,
          content: [
            [
              { tag: 'at', user_id: senderOpenId },
              { tag: 'text', text: useChinese ? ' 最新趋势简报如下：' : ' here is the latest trend brief:' },
            ],
            ...synthesisToFeishuLines(synthesis),
          ],
        },
      })
    }

    const payload = { receive_id: chatId, msg_type: msgType, content }
    console.log('sending brief:', JSON.stringify(payload).slice(0, 200))
    const sendRes = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const sendJson = await sendRes.json()
    console.log('send response:', JSON.stringify(sendJson).slice(0, 300))
    return new Response('OK', { status: 200 })
  }

  // Non-brief path: get token sequentially (simpler, less critical latency)
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const { tenant_access_token: token } = await tokenRes.json()

  if (stripped.length < 10) {
    msgType = 'text'
    content = JSON.stringify({
      text: '👋 我是 Newnews AI 新闻助手！我每日早上 8:30 为本频道推送精选 AI 趋势简报。\n想看最新趋势简报？直接 @我 并说"趋势简报"即可。\n如有其他问题，请 @我 并附上问题，我会转发给管理员。',
    })
  } else {
    // Use post (rich text) for @mention support
    msgType = 'post'
    const contentBlocks: any[] = [
      [{ tag: 'text', text: '这个问题超出了我目前的能力范围。已通知 ' }],
    ]
    if (adminOpenId) {
      contentBlocks[0].push({ tag: 'at', user_id: adminOpenId, user_name: adminDisplayName })
    } else {
      contentBlocks[0].push({ tag: 'text', text: adminDisplayName })
    }
    contentBlocks[0].push({ tag: 'text', text: '。' })

    const line2: any[] = [{ tag: 'text', text: '📋 ' }]
    if (senderOpenId) {
      line2.push({ tag: 'at', user_id: senderOpenId, user_name: '用户' })
    } else {
      line2.push({ tag: 'text', text: '用户' })
    }
    line2.push({ tag: 'text', text: ` 提问：\n"${stripped}"` })
    contentBlocks.push(line2)

    content = JSON.stringify({ zh_cn: { title: '', content: contentBlocks } })
  }

  const payload = { receive_id: chatId, msg_type: msgType, content }
  console.log('sending:', JSON.stringify(payload).slice(0, 500))
  const sendRes = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  })
  const sendJson = await sendRes.json()
  console.log('send response:', JSON.stringify(sendJson).slice(0, 300))

  return new Response('OK', { status: 200 })
})
