import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type SecurityJson = Record<string, unknown>
export type AuthenticatedUser = {
  id: string
  email?: string
  user_metadata?: Record<string, unknown>
}
export type AuthResult =
  | { ok: true; user: AuthenticatedUser; token: string }
  | { ok: false; response: Response }
export type RateLimitResult =
  | { ok: true }
  | { ok: false; response: Response }

export function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allowedOrigins = parseCsvEnv(Deno.env.get('ALLOWED_WEB_ORIGINS'))
  const allowOrigin =
    allowedOrigins.length === 0
      ? '*'
      : allowedOrigins.includes(origin)
        ? origin
        : allowedOrigins[0]

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  }
}

export function securityJson(req: Request, body: SecurityJson, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeadersFor(req),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

export function securityOptions(req: Request): Response {
  return new Response('ok', {
    status: 200,
    headers: corsHeadersFor(req),
  })
}

export function getClientIp(req: Request): string {
  const cfIp = req.headers.get('cf-connecting-ip')?.trim()
  if (cfIp) return cfIp

  const realIp = req.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwardedFor) return forwardedFor

  return 'unknown'
}

export async function requireAuthenticatedUser(req: Request): Promise<AuthResult> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()

  if (!supabaseUrl || !anonKey || !token || token === anonKey) {
    return { ok: false, response: securityJson(req, { error: 'auth_required' }, 401) }
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)

  if (error || !user) {
    return { ok: false, response: securityJson(req, { error: 'auth_required' }, 401) }
  }

  return { ok: true, user: user as AuthenticatedUser, token }
}

export function assertAdminIpAllowed(req: Request): Response | null {
  const allowlist = parseCsvEnv(Deno.env.get('ADMIN_IP_ALLOWLIST'))
  if (allowlist.length === 0) {
    return securityJson(req, { error: 'admin_ip_allowlist_not_configured' }, 403)
  }

  const ip = getClientIp(req)
  if (!allowlist.includes(ip)) {
    return securityJson(req, { error: 'ip_not_allowed' }, 403)
  }

  return null
}

export function assertAllowedOrigin(req: Request, allowedOrigins: string[]): Response | null {
  const origin = req.headers.get('origin')
  if (!origin) return null
  if (allowedOrigins.includes(origin)) return null
  return securityJson(req, { error: 'origin_not_allowed' }, 403)
}

export async function requireRateLimit(params: {
  req: Request
  serviceRoleClient: {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: boolean | null; error: { message: string } | null }>
  }
  userId: string
  surface: string
  limit: number
  windowSeconds: number
}): Promise<RateLimitResult> {
  const ip = getClientIp(params.req)
  const bucket = `${params.surface}:${params.userId}:${ip}`
  const { data: allowed, error } = await params.serviceRoleClient.rpc(
    'bump_edge_rate_limit',
    {
      p_bucket: bucket,
      p_limit: params.limit,
      p_window_seconds: params.windowSeconds,
    },
  )

  if (error) {
    return {
      ok: false,
      response: securityJson(params.req, { error: 'rate_limit_check_failed' }, 503),
    }
  }

  if (!allowed) {
    return {
      ok: false,
      response: securityJson(params.req, { error: 'rate_limited' }, 429),
    }
  }

  return { ok: true }
}
