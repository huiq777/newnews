import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('OK', { status: 200 })

  const body = await req.text()

  // Discord requires signature verification on every request
  const valid = await verifySignature(req, body)
  if (!valid) return new Response('Unauthorized', { status: 401 })

  let interaction: any
  try {
    interaction = JSON.parse(body)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  // Type 1 = PING (Discord endpoint verification)
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Type 2 = APPLICATION_COMMAND (slash commands)
  if (interaction.type === 2) {
    const commandName = interaction.data?.name
    const adminUserId = Deno.env.get('DISCORD_ADMIN_USER_ID') ?? ''
    const adminMention = adminUserId ? `<@${adminUserId}>` : '@admin'
    const username = interaction.member?.user?.username ?? interaction.user?.username ?? 'A user'

    let content: string

    if (commandName === 'help') {
      content = `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel @ 8:30 PM.\nFor complex questions, use \`/ask\` with your question and I'll escalate to the admin.`
    } else if (commandName === 'ask') {
      const question = interaction.data?.options?.find((o: any) => o.name === 'question')?.value ?? ''
      content = question.length < 10
        ? `👋 I'm the Newnews AI brief bot. I push daily AI trend briefs to this channel.\nFor complex questions, use \`/ask\` with your question and I'll escalate to the admin.`
        : `This question is beyond my current scope. Notifying ${adminMention}.\n\n📋 ${username} asked:\n"${question}"`
    } else {
      return new Response(JSON.stringify({ type: 1 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Type 4 = CHANNEL_MESSAGE_WITH_SOURCE
    return new Response(JSON.stringify({ type: 4, data: { content } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response('OK', { status: 200 })
})
