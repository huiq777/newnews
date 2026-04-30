// redeem-invite — Round 1 closed-beta auth gate.
// Spec: docs/superpowers/specs/2026-04-26-beta-auth-gate-design.md §2
//
// Contract:
//   POST { code: string }   Authorization: Bearer <user JWT>
//   → 200 { ok: true,  display_name, default_lang }
//   → 200 { ok: false, error: 'invalid' | 'used' | 'expired' }
//   → 401 if the gateway rejected the JWT (verify_jwt = true is the default).
//
// Race-safety contract:
//   - Atomic claim first: a single conditional UPDATE wins exactly one caller.
//   - Idempotent recovery: if the row was already claimed by THIS caller
//     (network-partition retry), re-apply app_metadata and return ok.
//     Without this branch, a dropped response permanently locks out the user.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // `apikey` is added by supabase-js automatically alongside `Authorization` —
  // omitting it here makes the browser fail the preflight before our function runs.
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'invalid' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  let body: { code?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid' }, 400)
  }
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  if (!code) return json({ ok: false, error: 'invalid' }, 400)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader) return json({ ok: false, error: 'invalid' }, 401)

  // 1. Per-request client carrying the caller's JWT. Used only to extract
  //    the verified user — the gateway has already validated the signature.
  const sbAsUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: { user }, error: userErr } = await sbAsUser.auth.getUser()
  if (userErr || !user) return json({ ok: false, error: 'invalid' }, 401)
  const userId = user.id

  // 2. Service-role client for the privileged writes.
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const nowIso = new Date().toISOString()

  // 3. Atomic claim: lookup + mark-used in a single conditional UPDATE.
  //    PostgREST `or=` requires outer parens — the builder handles that.
  const claim = await sb
    .from('beta_invites')
    .update({ used_at: nowIso, user_id: userId })
    .eq('code', code)
    .is('used_at', null)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .select('display_name, default_lang')
    .maybeSingle()

  let display_name: string | null = null
  let default_lang: 'en' | 'zh' | null = null

  if (claim.data) {
    display_name = claim.data.display_name
    default_lang = claim.data.default_lang
  } else {
    // 4. Atomic claim found nothing — diagnose AND recover idempotently.
    const lookup = await sb
      .from('beta_invites')
      .select('used_at, expires_at, user_id, display_name, default_lang')
      .eq('code', code)
      .maybeSingle()

    if (!lookup.data) return json({ ok: false, error: 'invalid' })

    const row = lookup.data
    if (row.used_at) {
      // Network-partition retry: caller already owns this invite.
      // Re-apply metadata (cheap, no-op if already correct) and return ok.
      if (row.user_id === userId) {
        display_name = row.display_name
        default_lang = row.default_lang
      } else {
        return json({ ok: false, error: 'used' })
      }
    } else {
      // Not used, but the .or() filter rejected it → expired.
      return json({ ok: false, error: 'expired' })
    }
  }

  // 5. Set server-only metadata. Runs for both first-claim and idempotent retry.
  //    `app_metadata` is service-role write only — the client cannot tamper
  //    via supabase.auth.updateUser({ data: ... }), which targets user_metadata.
  const { error: metaErr } = await sb.auth.admin.updateUserById(userId, {
    app_metadata: {
      is_beta_user: true,
      display_name,
      default_lang,
    },
  })
  if (metaErr) {
    // The row is claimed but metadata write failed — surface so the client
    // can retry. The next attempt will hit the idempotent-recovery branch.
    console.error('updateUserById failed:', metaErr)
    return json({ ok: false, error: 'invalid' }, 500)
  }

  return json({ ok: true, display_name, default_lang })
})
