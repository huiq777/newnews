import { useCallback, useEffect, useMemo, useState } from 'react'
import { Platform } from 'react-native'
import { supabase } from './config'

export type OAuthProvider = 'github' | 'google'
export type AuthStatus = 'checking' | 'anonymous' | 'authed' | 'auth_error'

function friendlyAuthError(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('unsupported provider') || lower.includes('provider is not enabled')) {
    return 'This sign-in provider is not enabled in Supabase yet. Enable GitHub and Google in Authentication > Providers.'
  }
  if (lower.includes('database error saving new user') || lower.includes('database error creating') || lower.includes('unexpected_failure')) {
    return 'Supabase could not create this user because a database trigger failed. Check Auth Logs and auth.users triggers, especially public.handle_new_user().'
  }
  if (lower.includes('pkce') || lower.includes('code verifier')) {
    return 'Sign-in callback could not be completed. Clear site data for this domain, then try again. If it keeps happening, verify the Supabase redirect URL exactly matches this domain.'
  }
  return message
}

export function useAuthGate() {
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  const hasOAuthCallbackParams = useCallback(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false
    const url = new URL(window.location.href)
    return (
      url.searchParams.has('code') ||
      url.searchParams.has('error') ||
      url.searchParams.has('error_description') ||
      window.location.hash.includes('access_token') ||
      window.location.hash.includes('error_description')
    )
  }, [])

  const syncSession = useCallback(async () => {
    const { data, error } = await supabase.auth.getSession()
    if (error) {
      setAuthError(friendlyAuthError(error.message))
      setStatus('auth_error')
      return
    }

    const user = data.session?.user ?? null
    setDisplayName(
      user?.user_metadata?.user_name ??
        user?.user_metadata?.name ??
        user?.email ??
        null,
    )
    setAuthError(null)
    if (user) {
      setStatus('authed')
      return
    }

    if (hasOAuthCallbackParams()) {
      setAuthError(
        'Sign-in returned to the app, but no session was stored. Clear site data for this domain and try again. If it still happens, the deployed app and Supabase redirect URL are not using the same OAuth flow/origin.',
      )
      setStatus('auth_error')
      return
    }

    setStatus('anonymous')
  }, [hasOAuthCallbackParams])

  useEffect(() => {
    void syncSession()
    const { data } = supabase.auth.onAuthStateChange(() => {
      void syncSession()
    })
    return () => data.subscription.unsubscribe()
  }, [syncSession])

  const redirectTo = useMemo(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return window.location.origin
    }
    return undefined
  }, [])

  const signInWithProvider = useCallback(
    async (provider: OAuthProvider) => {
      setAuthError(null)
      const { error } = provider === 'github'
        ? await supabase.auth.signInWithOAuth({
            provider: 'github',
            options: redirectTo ? { redirectTo } : undefined,
          })
        : await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: redirectTo ? { redirectTo } : undefined,
          })
      if (error) {
        setAuthError(friendlyAuthError(error.message))
        setStatus('auth_error')
      }
    },
    [redirectTo],
  )

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) {
      setAuthError(friendlyAuthError(error.message))
      setStatus('auth_error')
      return
    }
    setDisplayName(null)
    setStatus('anonymous')
  }, [])

  return {
    status,
    displayName,
    authError,
    signInWithProvider,
    signOut,
    retry: syncSession,
  }
}
