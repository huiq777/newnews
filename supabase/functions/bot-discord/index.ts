const DISCORD_API = 'https://discord.com/api/v10'

async function verifySignature(req: Request, body: string): Promise<boolean> {
  const publicKey = Deno.env.get('DISCORD_PUBLIC_KEY') ?? ''
  const signature = req.headers.get('x-signature-ed25519') ?? ''
  const timestamp = req.headers.get('x-signature-timestamp') ?? ''
  console.log('verify: pubkey len', publicKey.length, 'sig len', signature.length, 'ts', timestamp)
  if (!signature || !timestamp || !publicKey) return false

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKey),
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify'],
    )
    const result = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    )
    console.log('verify result:', result)
    return result
  } catch (e) {
    console.log('verify error:', e)
    return false
  }
}

function splitChunks(text: string, max: number): string[] {
  const chunks: string[] = []
  const lines = text.split('\n')
  let current = ''
  for (const line of lines) {
    const next = current ? current + '\n' + line : line
    if (next.length > max) {
      if (current) chunks.push(current)
      current = line.length > max ? line.slice(0, max) : line
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 })

  const body = await req.text()

  const valid = await verifySignature(req, body)
  if (!valid) return new Response('Unauthorized', { status: 401 })

  let interaction: any
  try {
    interaction = JSON.parse(body)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Type 1 = PING
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Type 2 = APPLICATION_COMMAND
  if (interaction.type === 2) {
    const commandName = interaction.data?.name
    const adminUserId = Deno.env.get('DISCORD_ADMIN_USER_ID') ?? ''
    const adminMention = adminUserId ? `<@${adminUserId}>` : '@admin'
    const username = interaction.member?.user?.username ?? interaction.user?.username ?? 'A user'
    const userId = interaction.member?.user?.id ?? interaction.user?.id ?? ''
    const askerMention = userId ? `<@${userId}>` : ''

    if (commandName === 'help') {
      const content = `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel.\nCommands:\n• \`/brief\` — get the latest trend brief\n• \`/ask [question]\` — escalate a question to the admin`
      return new Response(JSON.stringify({ type: 4, data: { content } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (commandName === 'brief') {
      const interactionToken = interaction.token
      const applicationId = interaction.application_id
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

      const fetchAndReply = async () => {
        try {
          const briefs: { synthesis_en: string | null; synthesis_zh: string | null; anchor_date: string }[] =
            await fetch(
              `${supabaseUrl}/rest/v1/trend_briefs?step_days=eq.1&order=generated_at.desc&limit=1&select=synthesis_en,synthesis_zh,anchor_date`,
              { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
            ).then(r => r.json())
          const brief = briefs[0]

          let chunks: string[]
          if (!brief) {
            chunks = [`${askerMention} No trend brief available yet. Check back after 8:30 PM.`.trim()]
          } else {
            const synthesis = brief.synthesis_en ?? brief.synthesis_zh ?? ''
            const dateLabel = brief.anchor_date?.slice(5).replace('-', '/') ?? ''
            const full = `${askerMention} Here's the latest AI Trend Brief (${dateLabel}):\n\n${synthesis}`.trim()
            chunks = splitChunks(full, 1900)
          }

          // Edit the deferred "thinking" message with first chunk
          const patchRes = await fetch(
            `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: chunks[0] }),
            },
          )
          console.log('discord patch status:', patchRes.status)

          // Send remaining chunks as follow-up messages
          for (let i = 1; i < chunks.length; i++) {
            await fetch(
              `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: chunks[i] }),
              },
            )
          }
        } catch (e) {
          console.log('fetchAndReply error:', e)
        }
      }

      // @ts-ignore EdgeRuntime is available in Supabase's Deno runtime
      EdgeRuntime.waitUntil(fetchAndReply())

      return new Response(JSON.stringify({ type: 5 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (commandName === 'ask') {
      const question = interaction.data?.options?.find((o: any) => o.name === 'question')?.value ?? ''
      const content = question.length < 10
        ? `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel.\nFor complex questions, use \`/ask\` with your question and I'll escalate to the admin.`
        : `This question is beyond my current scope. Notifying ${adminMention}.\n\n📋 ${username} asked:\n"${question}"`
      return new Response(JSON.stringify({ type: 4, data: { content } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response('OK', { status: 200 })
})
