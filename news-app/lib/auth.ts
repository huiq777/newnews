// useAuthGate — Round 1 closed-beta auth gate.
// Spec: docs/superpowers/specs/2026-04-26-beta-auth-gate-design.md §4a
//
// State machine:
//   'checking'      → on mount, before any decisions
//   'gated'         → no session, no invite code
//   'redeeming'     → invite present, calling redeem-invite
//   'authed'        → session has app_metadata.is_beta_user === true
//   'redeem_failed' → with reason: 'invalid' | 'used' | 'expired' | 'network'
//
// Critical invariants (from spec §4a — these prevent locking beta users out):
//   - Reuse-before-create: if a leftover anonymous session exists when a
//     ?invite= is present, REUSE it. Calling signInAnonymously() a second
//     time mints a fresh UUID and breaks the Edge Function's idempotent
//     recovery path.
//   - Network errors keep the session alive. Retrying with the same auth.uid()
//     triggers the Edge Function's idempotent-recovery branch.
//   - Hard errors (invalid/used/expired) sign the anonymous user out.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Platform } from 'react-native'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './config'

export type GateStatus = 'checking' | 'gated' | 'authed' | 'redeeming' | 'redeem_failed'
export type RedeemError = 'invalid' | 'used' | 'expired' | 'network' | null

export type AuthGate = {
  status: GateStatus
  displayName: string | null
  defaultLang: 'en' | 'zh' | null
  redeemError: RedeemError
  retry: () => void
}

const isWeb = Platform.OS === 'web'

function readInviteFromQuery(query: string): string | null {
  try {
    return new URLSearchParams(query).get('invite')
  } catch {
    return null
  }
}

async function readInviteFromAnyUrl(): Promise<string | null> {
  if (isWeb && typeof window !== 'undefined') {
    return readInviteFromQuery(window.location.search)
  }
  try {
    const url = await Linking.getInitialURL()
    if (!url) return null
    const q = url.indexOf('?')
    return q >= 0 ? readInviteFromQuery(url.slice(q + 1)) : null
  } catch {
    return null
  }
}

function stripInviteFromWebUrl() {
  if (!isWeb || typeof window === 'undefined') return
  try {
    const u = new URL(window.location.href)
    u.searchParams.delete('invite')
    window.history.replaceState({}, '', u.toString())
  } catch {
    // ignore — non-fatal cosmetic
  }
}

function isBetaAuthed(session: Session | null): boolean {
  return !!session?.user?.app_metadata?.is_beta_user
}

function readMeta(user: User | null): { displayName: string | null; defaultLang: 'en' | 'zh' | null } {
  const meta = user?.app_metadata as { display_name?: string; default_lang?: string } | undefined
  const displayName = meta?.display_name ?? null
  const defaultLang =
    meta?.default_lang === 'en' || meta?.default_lang === 'zh' ? meta.default_lang : null
  return { displayName, defaultLang }
}

export function useAuthGate(): AuthGate {
  const [status, setStatus] = useState<GateStatus>('checking')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [defaultLang, setDefaultLang] = useState<'en' | 'zh' | null>(null)
  const [redeemError, setRedeemError] = useState<RedeemError>(null)
  const tickRef = useRef(0)

  const bootstrap = useCallback(async () => {
    const myTick = ++tickRef.current
    setStatus('checking')
    setRedeemError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (myTick !== tickRef.current) return

    // Already redeemed in a prior session.
    if (isBetaAuthed(session)) {
      const meta = readMeta(session!.user)
      setDisplayName(meta.displayName)
      setDefaultLang(meta.defaultLang)
      setStatus('authed')
      return
    }

    // Stale-JWT recovery: a session exists but its JWT predates the
    // app_metadata write. Probe the live user — if redemption already
    // happened server-side, refresh the session to update the persisted JWT
    // and skip the gate.
    if (session) {
      const { data: { user: liveUser } } = await supabase.auth.getUser()
      if (myTick !== tickRef.current) return
      if (liveUser?.app_metadata?.is_beta_user) {
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
        if (myTick !== tickRef.current) return
        if (!refreshErr && refreshed.session) {
          const meta = readMeta(refreshed.user)
          setDisplayName(meta.displayName)
          setDefaultLang(meta.defaultLang)
          setStatus('authed')
          return
        }
      }
    }

    const code = await readInviteFromAnyUrl()
    if (myTick !== tickRef.current) return

    if (!code) {
      setStatus('gated')
      return
    }

    setStatus('redeeming')

    // Reuse-before-create: critical for network-partition idempotency.
    let workingSession = session
    if (!workingSession) {
      const { data, error } = await supabase.auth.signInAnonymously()
      if (myTick !== tickRef.current) return
      if (error || !data.session) {
        setRedeemError('network')
        setStatus('redeem_failed')
        return
      }
      workingSession = data.session
    }

    type RedeemSuccess = { ok: true; display_name: string; default_lang: 'en' | 'zh' }
    type RedeemFailure = { ok: false; error: 'invalid' | 'used' | 'expired' }
    type RedeemPayload = RedeemSuccess | RedeemFailure
    const isRedeemPayload = (x: unknown): x is RedeemPayload =>
      !!x && typeof x === 'object' && 'ok' in x && typeof (x as { ok: unknown }).ok === 'boolean'

    let payload: RedeemPayload | null = null
    let networkError = false

    try {
      const { data, error } = await supabase.functions.invoke('redeem-invite', {
        body: { code },
      })
      if (error) {
        // FunctionsHttpError — try to recover the JSON body if our function
        // emitted one (e.g. a 400 with { ok: false, error: 'invalid' }).
        const ctx = (error as { context?: { json?: () => Promise<unknown> } }).context
        if (ctx?.json) {
          try {
            const recovered = await ctx.json()
            if (isRedeemPayload(recovered)) payload = recovered
            else networkError = true
          } catch {
            networkError = true
          }
        } else {
          networkError = true
        }
      } else if (isRedeemPayload(data)) {
        payload = data
      } else {
        networkError = true
      }
    } catch {
      networkError = true
    }

    if (myTick !== tickRef.current) return

    // Network failure path — KEEP the anonymous session so retry can use it
    // to trigger the Edge Function's idempotent recovery.
    if (networkError || !payload) {
      setRedeemError('network')
      setStatus('redeem_failed')
      return
    }

    if (!payload.ok) {
      // Hard failure — anonymous session has no further use.
      await supabase.auth.signOut()
      setRedeemError(payload.error)
      setStatus('redeem_failed')
      return
    }

    // Success! We DO NOT call refreshSession() here because the anonymous token
    // was minted milliseconds ago and Supabase will reject the refresh, causing
    // a silent sign-out and a zombie "authed" UI state (which breaks qa_logs).
    // The anonymous JWT is perfectly fine for this session because Postgres RLS
    // checks the DB-backed is_beta_user() function, not the JWT claim.
    // On the user's next reload, the stale-JWT recovery block at the top will
    // safely refresh the token since enough time will have passed.
    setDisplayName(payload.display_name)
    setDefaultLang(payload.default_lang)
    stripInviteFromWebUrl()
    setStatus('authed')
  }, [])

  useEffect(() => {
    bootstrap()
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setStatus('gated')
        setDisplayName(null)
        setDefaultLang(null)
        setRedeemError(null)
      }
    })
    return () => {
      sub.subscription.unsubscribe()
    }
  }, [bootstrap])

  const retry = useCallback(() => {
    bootstrap()
  }, [bootstrap])

  return { status, displayName, defaultLang, redeemError, retry }
}
