import { useCallback, useEffect, useMemo, useState } from 'react'
import { Platform } from 'react-native'
import { APP_URL, supabase } from './config'

export type OAuthProvider = 'github' | 'google'
export type AuthStatus = 'checking' | 'anonymous' | 'authed' | 'auth_error'

function friendlyAuthError(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('unsupported provider') || lower.includes('provider is not enabled')) {
    return 'This sign-in provider is not enabled in Supabase yet. Enable GitHub and Google in Authentication > Providers.'
  }
  return message
}

export function useAuthGate() {
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  const consumeOAuthRedirect = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return true

    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')
    const errorDescription = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (!code && !errorDescription) return true

    const cleanUrl = () => {
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      url.searchParams.delete('error')
      url.searchParams.delete('error_code')
      url.searchParams.delete('error_description')
      window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
    }

    if (errorDescription) {
      cleanUrl()
      setAuthError(friendlyAuthError(errorDescription))
      setStatus('auth_error')
      return false
    }

    if (!code) return true

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    cleanUrl()
    if (error) {
      setAuthError(friendlyAuthError(error.message))
      setStatus('auth_error')
      return false
    }

    return true
  }, [])

  const syncSession = useCallback(async () => {
    const canContinue = await consumeOAuthRedirect()
    if (!canContinue) return

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
    setStatus(user ? 'authed' : 'anonymous')
  }, [consumeOAuthRedirect])

  useEffect(() => {
    void syncSession()
    const { data } = supabase.auth.onAuthStateChange(() => {
      void syncSession()
    })
    return () => data.subscription.unsubscribe()
  }, [syncSession])

  const redirectTo = useMemo(() => {
    if (Platform.OS === 'web') {
      return APP_URL
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
