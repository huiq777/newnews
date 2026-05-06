// Deploy with: supabase functions deploy unsubscribe-email --no-verify-jwt
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return new Response('Missing id', { status: 400 })

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/email_subscribers?id=eq.${id}&unsubscribed_at=is.null`,
    {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ unsubscribed_at: new Date().toISOString() }),
    },
  )

  if (!res.ok) {
    console.error(`unsubscribe PATCH failed: ${res.status}`)
    return new Response('Error', { status: 500 })
  }

  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center"><h2>You've been unsubscribed</h2><p style="color:#71717a">You won't receive any more digest emails.</p></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
})
