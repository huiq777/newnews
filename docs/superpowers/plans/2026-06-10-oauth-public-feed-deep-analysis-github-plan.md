# OAuth Public Feed, Deep Analysis Changelog, And GitHub Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the app from closed-beta invite gating to a public daily-feed plus OAuth-gated analysis model, add Deep Analysis to the changelog, and add login/GitHub actions to the nav.

**Architecture:** Keep the daily article feed public, but gate all analysis surfaces through UI locks, Edge Function auth checks, RLS, rate limits, and operational security controls. Login is a small nav action and reusable inline action, not a first-visit full-screen wall. Security is layered by access level: public feed, authenticated analysis, service-role jobs, and admin/internal operations.

**Tech Stack:** React Native Web, Expo, Supabase Auth/OAuth, Supabase RLS, Supabase Edge Functions, SQL migrations, Node test runner, Font Awesome via existing `WebHTML`.

---

## Goal Details

Move the app from closed-beta invite gating to an OAuth-only access model:

- Logged-out users can read the daily news article feed.
- Logged-out users see locked inline rows for Deep Analysis, Q&A, Trend Brief, question refresh, feedback, subscription-only/manual flows, and other premium/interactive analysis surfaces. These rows show a short "Please log in" message and a small login button, but never show the actual premium content.
- Logged-in users can access the full app with GitHub or Google OAuth.
- Email/password, email OTP, and email sign-up are not exposed in the app and are disabled operationally in Supabase.
- The changelog includes Deep Analysis as a visible product update.
- The nav adds a small `Login` button immediately to the left of the GitHub repo button.
- The nav adds a GitHub repo button with the existing star visual treatment, placed immediately to the left of the current news log button and using the same hover language.

## Current Findings

- `news-app/lib/auth.ts` is still a closed-beta state machine. It parses `?invite=`, signs in anonymously, calls `redeem-invite`, and only allows users with `app_metadata.is_beta_user`.
- `news-app/App.tsx` blocks the entire app behind `BetaGateScreen` unless `authStatus === 'authed'`.
- `ArticleCard` and `XThreadCard` call Q&A and question-refresh functions with either the user session token or the anon key. That makes UI-only gating insufficient.
- `TrendBriefCard` is rendered from `App.tsx` when the active category is `all`.
- `article_deep_analysis` currently has public read access in `supabase/sql/20260529_deep_analysis.sql`.
- `news-app/components/NavBar.tsx` already has the news log button and hover state. That is the right component for the GitHub repo button.
- The existing star icon treatment is a Font Awesome star in `ArticleCard`, rendered through `WebHTML`.

## Implementation Strategy

Use a layered access policy:

1. Public article feed remains available through existing feed RPCs and article card summary content.
2. Premium UI renders locked inline rows for anonymous users and guards event handlers.
3. Edge Functions reject anonymous requests for Q&A, refresh, and trend brief generation.
4. Direct table permissions close Deep Analysis, shared trend brief, and user override tables to browser clients; bounded RPCs and Edge Functions return only the shapes the UI needs.
5. OAuth provider choice is centralized in `lib/auth.ts`; no email login or email sign-up code remains in the app.
6. Security controls are split by access level so public reading stays available while internal/admin surfaces can use IP allowlists, rate limits, strict CORS, and service-role-only paths.

## Security Access Levels

Use these levels consistently in UI, RLS, Edge Functions, and deployment configuration:

| Level | Audience | Examples | Required Controls |
| --- | --- | --- | --- |
| L0 Public Read | Anonymous visitors | Daily article feed, source labels, article links, changelog, GitHub link | Read-only data shape, no secrets, no premium generated content, IP-based abuse throttling only |
| L1 Authenticated User | GitHub/Google users | Deep Analysis, Q&A, Trend Brief, feedback, refresh questions | Supabase JWT, bounded RPC/function reads, per-user and per-IP rate limits, no anon token fallback |
| L2 Service Job | Scheduled jobs and server-side generation | Digest jobs, ingestion, backfills, analysis generation | Service role only in Edge/server env, no browser exposure, job logs, least-privilege SQL where possible |
| L3 Admin/Internal | Operators and debug tools | SQL migrations, internal diagnostics, admin-only Edge paths | IP allowlist, service role, MFA in provider accounts, no public UI entry |

IP restriction rule:

- Do not IP-restrict the whole app because anonymous daily news access is a product requirement.
- Do IP-restrict admin/internal surfaces, staging previews if desired, deploy hooks, SQL/editor access where the platform supports it, and any Edge Function path that performs admin-only work.
- Do not IP-restrict normal GitHub/Google OAuth callbacks because that would block legitimate users.
- Use rate limits and WAF rules for public abuse control instead of allowlisting public readers.

## Task 1: Add Access Policy Tests First

Create `tests/oauth-public-access.test.mjs`.

Test coverage:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function assertBefore(source, first, second, label) {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  assert.notEqual(firstIndex, -1, `${label}: missing ${first}`)
  assert.notEqual(secondIndex, -1, `${label}: missing ${second}`)
  assert.ok(firstIndex < secondIndex, `${label}: expected ${first} before ${second}`)
}

function serveEntry(source) {
  const start = source.indexOf('serve(async')
  assert.notEqual(start, -1, 'missing serve(async entrypoint')
  return source.slice(start, start + 1800)
}

test('auth uses GitHub and Google OAuth only', () => {
  const auth = read('news-app/lib/auth.ts')

  assert.match(auth, /signInWithOAuth\(\{\s*provider:\s*'github'/s)
  assert.match(auth, /signInWithOAuth\(\{\s*provider:\s*'google'/s)
  assert.doesNotMatch(auth, /signInAnonymously/)
  assert.doesNotMatch(auth, /redeem-invite/)
  assert.doesNotMatch(auth, /signUp\(/)
  assert.doesNotMatch(auth, /signInWithPassword/)
  assert.doesNotMatch(auth, /signInWithOtp/)
})

test('app does not full-screen gate the public feed', () => {
  const app = read('news-app/App.tsx')

  assert.doesNotMatch(app, /return\s+<BetaGateScreen/s)
  assert.match(app, /const\s+isAuthed\s*=\s*authStatus\s*===\s*'authed'/)
  assert.match(app, /fetch_grouped_feed/)
  assert.match(app, /LoginRequiredInline/)
  assert.match(app, /authStatus\]/)
})

test('premium article and thread actions render login-required rows when anonymous', () => {
  const articleCard = read('news-app/components/ArticleCard.tsx')
  const xThreadCard = read('news-app/components/XThreadCard.tsx')
  const trendBrief = read('news-app/components/TrendBriefCard.tsx')

  assert.match(articleCard, /isAuthed:\s*boolean/)
  assert.match(articleCard, /onRequireAuth:\s*\(\)\s*=>\s*void/)
  assert.match(articleCard, /if\s*\(!isAuthed\)/)
  assert.match(articleCard, /LoginRequiredInline/)
  assert.match(xThreadCard, /isAuthed:\s*boolean/)
  assert.match(xThreadCard, /onRequireAuth:\s*\(\)\s*=>\s*void/)
  assert.match(xThreadCard, /if\s*\(!isAuthed\)/)
  assert.match(xThreadCard, /LoginRequiredInline/)
  assert.match(trendBrief, /isAuthed:\s*boolean/)
  assert.match(trendBrief, /if\s*\(!isAuthed\)/)
  assert.match(trendBrief, /LoginRequiredInline/)
  assert.doesNotMatch(trendBrief, /SUPABASE_ANON_KEY/)
})

test('public feed rpc nulls premium fields for anonymous callers', () => {
  const sql = read('supabase/sql/20260610_oauth_access_policy.sql')

  assert.match(sql, /auth\.role\(\)\s*=\s*'authenticated'/)
  assert.match(sql, /user_article_questions/)
  assert.match(sql, /coalesce\(uaq\.questions,\s*dn\.questions\)/)
  assert.match(sql, /else null end as questions/)
  assert.match(sql, /else null end as deep_analysis/)
  assert.match(sql, /source_name/)
  assert.match(sql, /jsonb_build_object\(/)
  assert.doesNotMatch(sql, /dn\.metadata,\s*$/m)
})

test('manual generation writes user-scoped overrides instead of shared defaults', () => {
  const sql = read('supabase/sql/20260610_oauth_access_policy.sql')
  const refreshQuestions = read('supabase/functions/refresh-questions/index.ts')
  const trendBrief = read('supabase/functions/generate-trend-brief/index.ts')

  assert.match(sql, /user_article_questions/)
  assert.match(sql, /primary key \(user_id,\s*article_id\)/)
  assert.match(sql, /user_trend_briefs/)
  assert.match(sql, /primary key \(user_id,\s*anchor_date,\s*step_days\)/)
  assert.match(sql, /revoke all on public\.user_article_questions from anon,\s*authenticated/)
  assert.match(sql, /revoke all on public\.user_trend_briefs from anon,\s*authenticated/)
  assert.match(sql, /grant select,\s*insert,\s*update,\s*delete on public\.user_article_questions to service_role/)
  assert.match(sql, /grant select,\s*insert,\s*update,\s*delete on public\.user_trend_briefs to service_role/)
  assert.doesNotMatch(sql, /create policy "users_read_own_article_questions"/)
  assert.doesNotMatch(sql, /create policy "users_write_own_article_questions"/)
  assert.doesNotMatch(sql, /create policy "users_read_own_trend_briefs"/)
  assert.doesNotMatch(sql, /create policy "users_write_own_trend_briefs"/)
  assert.doesNotMatch(sql, /grant\s+select,\s*insert,\s*update,\s*delete\s+on public\.user_article_questions to authenticated/i)
  assert.doesNotMatch(sql, /grant\s+select,\s*insert,\s*update,\s*delete\s+on public\.user_trend_briefs to authenticated/i)
  assert.match(refreshQuestions, /user_article_questions/)
  assert.doesNotMatch(refreshQuestions, /PATCH[^`]+daily_news/s)
  assert.match(trendBrief, /user_trend_briefs/)
})

test('premium tables are not directly readable by authenticated clients', () => {
  const sql = read('supabase/sql/20260610_oauth_access_policy.sql')
  const trendBrief = read('news-app/components/TrendBriefCard.tsx')

  assert.match(sql, /revoke select on public\.trend_briefs from anon,\s*authenticated/)
  assert.match(sql, /revoke select on public\.article_deep_analysis from anon,\s*authenticated/)
  assert.match(sql, /grant select,\s*insert,\s*update,\s*delete on public\.trend_briefs to service_role/)
  assert.match(sql, /grant select,\s*insert,\s*update,\s*delete on public\.article_deep_analysis to service_role/)
  assert.doesNotMatch(sql, /grant select on public\.trend_briefs to authenticated/)
  assert.doesNotMatch(sql, /grant select on public\.article_deep_analysis to authenticated/)
  assert.doesNotMatch(trendBrief, /rest\/v1\/trend_briefs/)
  assert.doesNotMatch(trendBrief, /from\('trend_briefs'\)/)
  assert.doesNotMatch(trendBrief, /from\('user_trend_briefs'\)/)
})

test('backend analysis endpoints require auth before expensive work', () => {
  const answerQuestion = read('supabase/functions/answer-question/index.ts')
  const refreshQuestions = read('supabase/functions/refresh-questions/index.ts')
  const trendBrief = read('supabase/functions/generate-trend-brief/index.ts')

  assert.match(answerQuestion, /auth_required/)
  assert.match(refreshQuestions, /auth_required/)
  assert.match(trendBrief, /auth_required/)
  assertBefore(serveEntry(answerQuestion), 'requireAuthenticatedUser', 'requireRateLimit', 'answer-question auth')
  assertBefore(serveEntry(answerQuestion), 'requireRateLimit', 'route(', 'answer-question rate limit')
  assertBefore(serveEntry(refreshQuestions), 'requireAuthenticatedUser', 'requireRateLimit', 'refresh-questions auth')
  assertBefore(serveEntry(refreshQuestions), 'requireRateLimit', 'generateQuestions', 'refresh-questions rate limit')
  assertBefore(serveEntry(trendBrief), "searchParams.get('trigger')", 'requireAuthenticatedUser', 'generate-trend-brief trigger branch')
  assertBefore(serveEntry(trendBrief), 'requireAuthenticatedUser', 'requireRateLimit', 'generate-trend-brief auth')
  assertBefore(serveEntry(trendBrief), 'requireRateLimit', 'streamBriefToUser', 'generate-trend-brief user branch')
})

test('security layer includes rate limits and admin IP allowlisting', () => {
  const security = read('supabase/functions/_shared/security.ts')
  const sql = read('supabase/sql/20260610_oauth_access_policy.sql')

  assert.match(security, /getClientIp/)
  assert.match(security, /requireAuthenticatedUser/)
  assert.match(security, /requireRateLimit/)
  assert.match(security, /corsHeadersFor/)
  assert.match(security, /securityJson/)
  assert.match(security, /ADMIN_IP_ALLOWLIST/)
  assert.match(security, /assertAdminIpAllowed/)
  assert.match(sql, /edge_rate_limits/)
  assert.match(sql, /bump_edge_rate_limit/)
})
```

Add this test file to the existing `npm test` suite if the test runner does not already discover every `tests/*.test.mjs` file.

Expected first run:

```bash
node --test tests/oauth-public-access.test.mjs
```

It should fail before implementation because the current app still contains invite redemption and full-screen beta gating.

## Task 2: Replace Invite Auth With OAuth-Only Session State

Update `news-app/lib/config.ts` so Supabase can process OAuth redirects:

```ts
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
```

Replace `news-app/lib/auth.ts` with a smaller OAuth session hook.

Target shape:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Platform } from 'react-native'
import { APP_URL, supabase } from './config'

export type OAuthProvider = 'github' | 'google'
export type AuthStatus = 'checking' | 'anonymous' | 'authed' | 'auth_error'

export function useAuthGate() {
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  const syncSession = useCallback(async () => {
    const { data, error } = await supabase.auth.getSession()
    if (error) {
      setAuthError(error.message)
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
  }, [])

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
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: redirectTo ? { redirectTo } : undefined,
      })
      if (error) {
        setAuthError(error.message)
        setStatus('auth_error')
      }
    },
    [redirectTo],
  )

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) {
      setAuthError(error.message)
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
```

OAuth redirect scope decision:

- Superseded 2026-06-11: web OAuth `redirectTo` should use `APP_URL` / `EXPO_PUBLIC_APP_URL`, defaulting to `https://newnews.dev`, not `window.location.origin`. This prevents local dev from accidentally sending provider callbacks to `http://localhost:8081`.
- Do not ship native iOS/Android OAuth from this plan with `redirectTo` undefined.
- If native Expo builds are in scope for the same release, add `expo-auth-session` and a configured app scheme before implementation:

```ts
import * as AuthSession from 'expo-auth-session'

const redirectTo = Platform.OS === 'web'
  ? APP_URL
  : AuthSession.makeRedirectUri({ scheme: 'newsapp' })
```

- Native setup must also add the `newsapp` scheme to Expo config and Supabase redirect URLs.

Remove frontend references to:

- `invite`
- `redeem-invite`
- `signInAnonymously`
- `is_beta_user`
- `desktop_required_no_invite`
- `desktop_required_with_invite`
- `redeeming`
- `redeem_failed`

Keep the `redeem-invite` Edge Function in the repo for now. It becomes legacy code and can be removed in a later cleanup after deploy verification.

## Task 3: Replace Full-Screen Beta Gate With Lightweight Auth Controls

Do not use `BetaGateScreen` as the root fallback anymore.

Create `news-app/components/LoginActionButton.tsx`:

- This is the shared small login button used in the top nav and in inline locked rows.
- The default label is `Login`.
- Pressing it opens the same OAuth prompt everywhere.
- It is not a large hero or first-visit wall.
- It uses the same border, radius, background, and hover language as the existing news log button.

Target props:

```ts
export type LoginActionButtonProps = {
  label?: string
  onPress: () => void
  compact?: boolean
}
```

Create `news-app/components/AuthPrompt.tsx` for locked-premium click attempts:

- Modal or compact panel with only GitHub and Google sign-in buttons.
- Copy: `Sign in to continue`.
- Supporting copy: `Daily news is public. Analysis tools require an account.`
- No email input.
- No invite language.

This prompt is used when an anonymous user tries to access a gated route or deep link.

Create `news-app/components/LoginRequiredInline.tsx`:

- This is the locked row shown where premium content would normally appear.
- It must not show Deep Analysis text, Q&A answers, trend brief text, feedback controls, or any generated premium content.
- It shows one short sentence and the shared `LoginActionButton`.

Target props:

```ts
export type LoginRequiredInlineProps = {
  message?: string
  onLoginPress: () => void
}
```

Default message:

```ts
const DEFAULT_MESSAGE = 'Please log in to view this.'
```

Target structure:

```tsx
<View style={styles.lockedRow}>
  <Text style={styles.lockedText}>{message ?? DEFAULT_MESSAGE}</Text>
  <LoginActionButton label="Login" compact onPress={onLoginPress} />
</View>
```

Use this component in:

- `ArticleCard` where Deep Analysis and Q&A content would appear.
- `XThreadCard` where Q&A content would appear.
- `TrendBriefCard` or its parent slot where trend brief content would appear.

## Task 4: Keep Daily Feed Public In `App.tsx`

Update `news-app/App.tsx`:

```ts
const {
  status: authStatus,
  displayName,
  authError,
  signInWithProvider,
  signOut,
  retry,
} = useAuthGate()
const isAuthed = authStatus === 'authed'
const [authPromptOpen, setAuthPromptOpen] = useState(false)
const requireAuth = useCallback(() => {
  setAuthPromptOpen(true)
}, [])
```

Remove:

```tsx
if (authStatus !== 'authed') {
  return <BetaGateScreen ... />
}
```

Article feed behavior:

- `fetch_grouped_feed` should run for anonymous and authenticated users.
- `fetch_grouped_feed` must be auth-aware because it is `SECURITY DEFINER`; RLS on `article_deep_analysis`, `trend_briefs`, or future override tables does not protect values returned by this function.
- Anonymous `fetch_grouped_feed` rows must return `questions = null`, `deep_analysis_id = null`, `deep_analysis_status = null`, `deep_analysis = null`, and feedback counts as `null`.
- Authenticated `fetch_grouped_feed` rows return auto-generated defaults plus user-scoped overrides where they exist.
- The feed RPC must include safe source display fields: `source_name`, `source_category`, and `thread_bio`. `App.tsx` should use those returned fields so anonymous users still see source labels without direct `sources` table reads.
- Remove the `if (authStatus !== 'authed') return` guard from the initial feed load and pagination paths.
- Keep `authStatus` in the feed effect dependency list. It is acceptable for the first pass to load public-safe rows while the auth hook is `checking`, but the effect must refetch when `checking -> authed` so authenticated users receive questions, Deep Analysis, and user override data without a manual refresh.
- Remove the source-name loading dependency on auth, or delete the source loading effect once the feed RPC returns safe display fields.
- New article feed refresh can remain public because it only exposes daily article availability.

Premium behavior:

- `TrendBriefCard` or its parent slot renders `LoginRequiredInline` when `isAuthed` is false, with no trend brief content loaded or shown.
- `TrendBriefCard` receives `isAuthed` and `onLoginPress`.
- Every `TrendBriefCard` effect, cache read, and generate path starts with `if (!isAuthed) return`; the component still renders its hooks normally, then returns `LoginRequiredInline` for anonymous users.
- `TrendBriefCard` must not import or use `SUPABASE_ANON_KEY`.
- `TrendBriefCard` must not call `rest/v1/trend_briefs`, `rest/v1/user_trend_briefs`, `supabase.from('trend_briefs')`, or `supabase.from('user_trend_briefs')`.
- `TrendBriefCard` calls `generate-trend-brief` with the authenticated user's access token for both cache reads and manual generation.
- `generate-trend-brief` checks `user_trend_briefs` first, then shared `trend_briefs`, and returns a bounded response shape.
- `force_refresh=true` creates or updates the current user's override only.
- `ArticleCard` receives `isAuthed` and `onRequireAuth`.
- `XThreadCard` receives `isAuthed` and `onRequireAuth`.
- Subscription/manual modals render `LoginRequiredInline` or route through `requireAuth` for anonymous users.
- Feedback controls for Deep Analysis and trend brief are not rendered for anonymous users because their parent content is locked.
- Locked rows use the exact same login action as the nav login button.

Nav behavior:

```tsx
<NavBar
  lang={lang}
  onLangChange={setLang}
  activeCategory={activeCategory}
  onCategoryChange={setActiveCategory}
  authStatus={authStatus}
  authDisplayName={displayName}
  authError={authError}
  onLoginPress={() => setAuthPromptOpen(true)}
  onSignOut={signOut}
/>
```

Render the auth prompt near the root:

```tsx
<AuthPrompt
  visible={authPromptOpen}
  authError={authError}
  onDismiss={() => setAuthPromptOpen(false)}
  onSignIn={signInWithProvider}
/>
```

## Task 5: Gate Article And Thread Premium Actions

Update `news-app/components/ArticleCard.tsx`.

Add props:

```ts
isAuthed: boolean
onRequireAuth: () => void
```

Guard function calls:

```ts
if (!isAuthed) {
  onRequireAuth()
  return
}
const { data: sessionData } = await supabase.auth.getSession()
const token = sessionData.session?.access_token
if (!token) {
  onRequireAuth()
  return
}
```

Do not call Q&A or refresh functions with `SUPABASE_ANON_KEY`.

Render rules:

- Article headline, source, date, tags, summary, and original link remain visible.
- Deep Analysis content is replaced by `LoginRequiredInline` when `isAuthed` is false.
- Q&A content, generated questions, custom question input, refresh questions, and Deep Think controls are replaced by `LoginRequiredInline` when `isAuthed` is false.
- Anonymous users never receive or render `daily_news.questions`; the public-safe feed RPC must return `questions = null`.
- Authenticated users see `user_article_questions.questions` when they have manually refreshed questions for that article; otherwise they see the auto-generated `daily_news.questions`.
- Manual question refresh upserts only `user_article_questions` for the current user and must not patch `daily_news.questions`.
- Deep Analysis feedback is rendered only inside authenticated Deep Analysis.
- The locked row message for article analysis is `Please log in to view Deep Analysis and Q&A.`

Update `news-app/components/XThreadCard.tsx` the same way:

- Public: thread summary, source/account, date, original link.
- Authenticated only: Q&A, refresh, custom question, Deep Think.
- Anonymous: replace the thread Q&A area with `LoginRequiredInline` using `Please log in to ask questions about this thread.`
- No Q&A call uses anon credentials.

## Task 6: Public-Safe Feed RPC And User-Scoped Overrides

Create `supabase/sql/20260610_oauth_access_policy.sql`.

This migration must handle both security and personalization:

- `fetch_grouped_feed` is `SECURITY DEFINER`, so RLS alone cannot stop it from returning premium fields.
- Anonymous callers must receive public article fields only.
- Authenticated callers must receive shared auto-generated defaults unless they have user-specific manual overrides.
- Manual refresh/generation must never mutate shared defaults that other users see.

Add user-specific question overrides:

```sql
create table if not exists public.user_article_questions (
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references public.daily_news(id) on delete cascade,
  questions jsonb not null,
  model text,
  tokens_used integer,
  generated_at timestamptz not null default now(),
  primary key (user_id, article_id),
  constraint user_article_questions_shape check (
    jsonb_typeof(questions) = 'object'
    and jsonb_typeof(questions->'en') = 'array'
    and jsonb_typeof(questions->'zh') = 'array'
  )
);

create index if not exists user_article_questions_article_id_idx
  on public.user_article_questions(article_id);

alter table public.user_article_questions enable row level security;

drop policy if exists "users_read_own_article_questions" on public.user_article_questions;
drop policy if exists "users_write_own_article_questions" on public.user_article_questions;

revoke all on public.user_article_questions from anon, authenticated;
grant select, insert, update, delete on public.user_article_questions to service_role;
```

Add user-specific trend brief overrides:

```sql
create table if not exists public.user_trend_briefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  anchor_date date not null,
  step_days integer not null,
  synthesis_en text,
  synthesis_zh text,
  sources_json jsonb not null default '[]'::jsonb,
  model text not null,
  tokens_used integer,
  generated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, anchor_date, step_days)
);

create index if not exists user_trend_briefs_lookup_idx
  on public.user_trend_briefs(user_id, anchor_date, step_days, expires_at);

alter table public.user_trend_briefs enable row level security;

drop policy if exists "users_read_own_trend_briefs" on public.user_trend_briefs;
drop policy if exists "users_write_own_trend_briefs" on public.user_trend_briefs;

revoke all on public.user_trend_briefs from anon, authenticated;
grant select, insert, update, delete on public.user_trend_briefs to service_role;
```

Make `trend_briefs` service-owned and unavailable to direct client reads. This is mandatory because direct authenticated REST reads would bypass Edge rate limits and return an unbounded cache table:

```sql
drop policy if exists "public_read_trend_briefs" on public.trend_briefs;
drop policy if exists "authenticated_read_trend_briefs" on public.trend_briefs;

revoke select on public.trend_briefs from anon, authenticated;
grant select, insert, update, delete on public.trend_briefs to service_role;
```

Make `article_deep_analysis` service-owned and unavailable to direct client reads. Authenticated users receive bounded Deep Analysis payloads through `fetch_grouped_feed`, not through direct table access:

```sql
drop policy if exists "public_read_article_deep_analysis" on public.article_deep_analysis;
drop policy if exists "authenticated_read_article_deep_analysis" on public.article_deep_analysis;

revoke select on public.article_deep_analysis from anon, authenticated;
grant select, insert, update, delete on public.article_deep_analysis to service_role;
```

Replace `fetch_grouped_feed` so premium columns are nulled for anonymous callers. Keep the existing function name so the frontend can continue using one RPC, but make the returned values role-aware:

```sql
drop function if exists public.fetch_grouped_feed(date, date, text, int, uuid);

create or replace function public.fetch_grouped_feed(
  p_date_start date,
  p_date_end date,
  p_category text default null,
  p_limit int default 10,
  p_cursor uuid default null
)
returns table (
  id uuid,
  title_en text,
  title_zh text,
  summary_en text,
  summary_zh text,
  source_type text,
  source_id uuid,
  source_name text,
  source_category text,
  thread_group text,
  thread_bio text,
  url text,
  published_at timestamptz,
  created_at timestamptz,
  questions jsonb,
  questions_source text,
  engagement jsonb,
  metadata jsonb,
  deep_analysis_id uuid,
  deep_analysis_status text,
  deep_analysis jsonb,
  deep_analysis_feedback_up_count integer,
  deep_analysis_feedback_down_count integer,
  next_cursor uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with caller as (
    select
      auth.role() = 'authenticated' and auth.uid() is not null as can_view_premium,
      auth.uid() as user_id
  ),
  ranked as (
    select
      dn.id,
      coalesce(dn.title_en, dn.title) as title_en,
      coalesce(dn.title_zh, dn.title) as title_zh,
      coalesce(dn.summary_en, dn.summary) as summary_en,
      coalesce(dn.summary_zh, dn.summary) as summary_zh,
      s.source_type,
      dn.source_id,
      s.name as source_name,
      s.category as source_category,
      case when s.source_type in ('x_api', 'apify_tweet') then s.metadata->>'handle' else null end as thread_group,
      case
        when s.source_type in ('x_api', 'apify_tweet')
        then s.metadata->'bio_map'->>(s.metadata->>'handle')
        else null
      end as thread_bio,
      dn.url,
      dn.published_at,
      dn.created_at,
      case
        when (select can_view_premium from caller) then coalesce(uaq.questions, dn.questions)
        else null
      end as questions,
      case
        when not (select can_view_premium from caller) then null
        when uaq.article_id is not null then 'user_override'
        when dn.questions is not null then 'auto_default'
        else null
      end as questions_source,
      dn.engagement,
      jsonb_strip_nulls(jsonb_build_object(
        'source', case when s.source_type = 'aihot' then dn.metadata->>'source' else null end,
        'aihot_source', case when s.source_type = 'aihot' then dn.metadata->>'source' else null end,
        'aihot_id', case when s.source_type = 'aihot' then dn.metadata->>'aihot_id' else null end,
        'category', dn.metadata->>'category'
      )) as metadata,
      case when (select can_view_premium from caller) then ada.id else null end as deep_analysis_id,
      case when (select can_view_premium from caller) then ada.status else null end as deep_analysis_status,
      case
        when (select can_view_premium from caller) and ada.status = 'ready' then ada.analysis
        else null
      end as deep_analysis,
      case when (select can_view_premium from caller) then coalesce(ada.feedback_up_count, 0) else null end as deep_analysis_feedback_up_count,
      case when (select can_view_premium from caller) then coalesce(ada.feedback_down_count, 0) else null end as deep_analysis_feedback_down_count
    from public.daily_news dn
    join public.sources s on s.id = dn.source_id
    cross join caller
    left join public.user_article_questions uaq
      on uaq.article_id = dn.id
     and uaq.user_id = caller.user_id
    left join public.article_deep_analysis ada on ada.article_id = dn.id
    where
      (
        (dn.published_at::date >= p_date_start and dn.published_at::date < p_date_end)
        or
        (dn.published_at is null and dn.created_at::date >= p_date_start and dn.created_at::date < p_date_end)
      )
      and (p_category is null or dn.category = p_category)
      and (p_cursor is null or dn.created_at < (select created_at from public.daily_news where id = p_cursor))
    order by dn.created_at desc
    limit p_limit
  )
  select
    r.id,
    r.title_en,
    r.title_zh,
    r.summary_en,
    r.summary_zh,
    r.source_type,
    r.source_id,
    r.source_name,
    r.source_category,
    r.thread_group,
    r.thread_bio,
    r.url,
    r.published_at,
    r.created_at,
    r.questions,
    r.questions_source,
    r.engagement,
    r.metadata,
    r.deep_analysis_id,
    r.deep_analysis_status,
    r.deep_analysis,
    r.deep_analysis_feedback_up_count,
    r.deep_analysis_feedback_down_count,
    (select id from ranked order by created_at asc limit 1) as next_cursor
  from ranked r
  order by r.created_at desc;
$$;

grant execute on function public.fetch_grouped_feed(date, date, text, int, uuid)
  to anon, authenticated;
```

Frontend mapping rule:

- Anonymous feed receives `questions = null`; `ArticleCard` and `XThreadCard` render `LoginRequiredInline` in Q&A areas.
- Authenticated feed receives `questions_source = 'auto_default'` until the user refreshes, then `questions_source = 'user_override'`.
- `source_name`, `source_category`, and `thread_bio` populate labels for all users.
- `metadata` is a sanitized public subset. Do not return raw `daily_news.metadata` through the public feed RPC.
- Current allowed metadata keys are `source`, `aihot_source`, `aihot_id`, and `category`.
- Deep Analysis fields are `null` for anonymous users even though the RPC is `SECURITY DEFINER`.

## Task 7: Enforce Auth In Edge Functions With The Shared Helper

Add auth requirement helpers to these Edge Functions:

- `supabase/functions/answer-question/index.ts`
- `supabase/functions/refresh-questions/index.ts`
- `supabase/functions/generate-trend-brief/index.ts`

Create or update `supabase/functions/_shared/security.ts` before changing these callers. The helper implementation is specified in Task 8 and must expose `requireAuthenticatedUser`, `securityJson`, `getClientIp`, and `assertAdminIpAllowed`.

Shared behavior:

```ts
const auth = await requireAuthenticatedUser(req)
if (!auth.ok) {
  return auth.response
}
const { user, token } = auth
```

Function-specific notes:

- `answer-question`: call `requireAuthenticatedUser` before model calls, retrieval, logging, or streaming begins. Existing per-user `qa_logs` cache remains the right storage for answers because it is keyed by `user_id`.
- `answer-question`: call `requireRateLimit` immediately after auth and before `route(...)`.
- `refresh-questions`: call `requireAuthenticatedUser` before generation or DB writes. Then call `requireRateLimit` before `generateQuestions(...)`. Fetch article summaries with service role, generate questions, then upsert `public.user_article_questions` for the current user. Do not patch `public.daily_news.questions`.
- `generate-trend-brief`: preserve trigger mode before user-mode auth. The `trigger=true` branch must continue accepting a service-role JWT or `CRON_SECRET` and must write shared auto-generated defaults to `public.trend_briefs`.
- `generate-trend-brief`: user mode must call `requireAuthenticatedUser` before reading cached brief content or generating fresh analysis. User-mode `force_refresh=true` and any user-initiated generation must write `public.user_trend_briefs`, not shared `public.trend_briefs`.
- `generate-trend-brief`: user mode must call `requireRateLimit` before `streamBriefToUser(...)`.
- `generate-trend-brief`: user mode reads cache in this order: current user's `user_trend_briefs`, then shared `trend_briefs`. That gives logged-in users the shared auto-generated default until they manually generate their own version.
- Service-role scheduled jobs must keep using `handleTrigger(req, url)` and should not pass through normal user JWT checks.

Target premium function entry shape:

```ts
const auth = await requireAuthenticatedUser(req)
if (!auth.ok) {
  return auth.response
}

const rate = await requireRateLimit({
  req,
  serviceRoleClient: sbService,
  userId: auth.user.id,
  surface: 'answer-question',
  limit: 30,
  windowSeconds: 3600,
})
if (!rate.ok) {
  return rate.response
}
```

Target `generate-trend-brief` entry shape:

```ts
serve(async (req) => {
  if (req.method === 'OPTIONS') return securityOptions(req)

  const url = new URL(req.url)
  if (url.searchParams.get('trigger') === 'true') {
    return handleTrigger(req, url)
  }

  const auth = await requireAuthenticatedUser(req)
  if (!auth.ok) {
    return auth.response
  }

  const rate = await requireRateLimit({
    req,
    serviceRoleClient: sbService,
    userId: auth.user.id,
    surface: 'generate-trend-brief',
    limit: 15,
    windowSeconds: 3600,
  })
  if (!rate.ok) {
    return rate.response
  }

  return streamBriefToUser(req, url, auth.user)
})
```

Target `refresh-questions` write shape:

```ts
const { error: upsertError } = await sbService
  .from('user_article_questions')
  .upsert({
    user_id: user.id,
    article_id,
    questions,
    model: resolvedModel,
    tokens_used: tokensUsed,
    generated_at: new Date().toISOString(),
  }, {
    onConflict: 'user_id,article_id',
  })

if (upsertError) {
  return securityJson(req, { error: 'question_override_write_failed' }, 500)
}

return securityJson(req, questions)
```

Target user-mode trend brief cache read order:

```ts
const userBrief = await readUserTrendBrief(user.id, anchorDate, stepDays)
if (userBrief && !forceRefresh) {
  return streamCachedBrief(userBrief, 'user_override')
}

const sharedBrief = await readSharedTrendBrief(anchorDate, stepDays)
if (sharedBrief && !forceRefresh) {
  return streamCachedBrief(sharedBrief, 'auto_default')
}
```

Target user-mode trend brief write:

```ts
await sbService
  .from('user_trend_briefs')
  .upsert({
    user_id: user.id,
    anchor_date: anchorDate,
    step_days: stepDays,
    synthesis_en,
    synthesis_zh,
    sources_json: sourcesJson,
    model: TREND_BRIEF_MODEL,
    tokens_used: tokensUsed,
    generated_at: new Date().toISOString(),
    expires_at: expiresAt,
  }, {
    onConflict: 'user_id,anchor_date,step_days',
  })
```

## Task 8: Add Security Controls, Rate Limits, And IP Restrictions

Create `supabase/functions/_shared/security.ts`.

Responsibilities:

- Extract a client IP from trusted platform headers.
- Detect admin IP allowlist violations for internal-only paths.
- Keep public paths available while still enabling abuse controls.
- Centralize `auth_required` responses and security error shapes.

Target implementation:

```ts
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

export function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
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
```

Do not use code-level CIDR matching in this file. CIDR and geographic restrictions belong in Cloudflare, Supabase platform controls, or the hosting provider WAF. The Edge Function helper uses exact IP matches only for internal/admin paths where the allowed IPs are known.

Extend `supabase/sql/20260610_oauth_access_policy.sql` with rate-limit storage:

```sql
create table if not exists public.edge_rate_limits (
  bucket text primary key,
  request_count integer not null default 0,
  reset_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.edge_rate_limits enable row level security;

revoke all on public.edge_rate_limits from anon;
revoke all on public.edge_rate_limits from authenticated;

create or replace function public.bump_edge_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_count integer;
  v_reset_at timestamptz;
begin
  insert into public.edge_rate_limits (bucket, request_count, reset_at)
  values (p_bucket, 1, v_now + make_interval(secs => p_window_seconds))
  on conflict (bucket) do update
    set request_count = case
          when public.edge_rate_limits.reset_at <= v_now then 1
          else public.edge_rate_limits.request_count + 1
        end,
        reset_at = case
          when public.edge_rate_limits.reset_at <= v_now then v_now + make_interval(secs => p_window_seconds)
          else public.edge_rate_limits.reset_at
        end,
        updated_at = v_now
  returning request_count, reset_at into v_count, v_reset_at;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.bump_edge_rate_limit(text, integer, integer) from public;
grant execute on function public.bump_edge_rate_limit(text, integer, integer) to service_role;
```

Use rate-limit buckets from Edge Functions with service-role clients only:

```ts
const rate = await requireRateLimit({
  req,
  serviceRoleClient,
  userId: user.id,
  surface: 'answer-question',
  limit: 30,
  windowSeconds: 3600,
})
if (!rate.ok) {
  return rate.response
}
```

Recommended first-pass limits:

| Surface | Bucket | Limit |
| --- | --- | --- |
| Public feed RPC | Platform/WAF IP bucket | 120 requests per minute per IP |
| `answer-question` | user id + IP | 30 requests per hour |
| `refresh-questions` | user id + IP | 20 requests per hour |
| `generate-trend-brief` | user id + IP | 15 requests per hour |
| Admin/internal function path | exact IP allowlist + service role | no public access |

Apply IP restrictions at the correct layers:

- Production app: no global IP allowlist because daily news is public.
- Staging app: optional hosting/WAF IP allowlist.
- Admin/debug Edge paths: `assertAdminIpAllowed(req)` plus service-role authentication.
- Supabase dashboard and GitHub deploy access: enforce MFA and organization/provider access controls.
- Cloudflare or hosting WAF: add rate-limit rules for feed abuse and block obvious malicious traffic.

Add tests in `tests/oauth-public-access.test.mjs`:

```js
test('security helper exact-matches admin allowlist and avoids cidr parsing', () => {
  const security = read('supabase/functions/_shared/security.ts')

  assert.match(security, /ADMIN_IP_ALLOWLIST/)
  assert.match(security, /allowlist\.includes\(ip\)/)
  assert.doesNotMatch(security, /cidr/i)
})
```

## Task 9: Add Deep Analysis To The Changelog

Update `news-app/lib/changelog.ts` with a top entry:

```ts
{
  date: '2026-06-10',
  en: 'Deep Analysis is now available for eligible long-form articles.',
  zh: '符合条件的长文现已支持深度分析。',
}
```

Add `tests/changelog-nav.test.mjs` coverage:

```js
test('changelog includes Deep Analysis launch entry', () => {
  const changelog = read('news-app/lib/changelog.ts')
  assert.match(changelog, /Deep Analysis/)
  assert.match(changelog, /2026-06-10/)
})
```

## Task 10: Add Login And GitHub Repo Buttons To The Nav

Update `news-app/lib/config.ts`:

```ts
export const GITHUB_REPO_URL =
  process.env.EXPO_PUBLIC_GITHUB_REPO_URL || 'https://github.com/huiq777/news-app'

export const GITHUB_STARS_LABEL =
  process.env.EXPO_PUBLIC_GITHUB_STARS_LABEL || 'Star'
```

Set `EXPO_PUBLIC_GITHUB_STARS_LABEL=xx` only if the placeholder count is intentional for a prototype or unreleased build. The default should read as deliberate when the env var is missing.

Update `news-app/components/NavBar.tsx`:

- Import `Linking`.
- Import `WebHTML`.
- Import `GITHUB_REPO_URL` and `GITHUB_STARS_LABEL`.
- Import `LoginActionButton`.
- Place the `Login` button immediately before the GitHub button in `navLangCol` when the user is anonymous.
- Place the GitHub button immediately before the current news log button in `navLangCol`.
- Use the same hover state pattern as `whatsNewHovered`.
- Keep the news log button visually unchanged.
- Use the existing Font Awesome star treatment from `ArticleCard`.

Target structure:

```tsx
const [githubHovered, setGithubHovered] = React.useState(false)

const openGithub = React.useCallback(() => {
  void Linking.openURL(GITHUB_REPO_URL)
}, [])
```

Button placement:

```tsx
{authStatus !== 'authed' ? (
  <LoginActionButton label="Login" compact onPress={onLoginPress} />
) : (
  <Pressable
    nativeID="logout-btn"
    accessibilityRole="button"
    accessibilityLabel="Sign out"
    onPress={onSignOut}
    style={styles.loginBtn}
  >
    <Text style={styles.loginBtnText}>Sign out</Text>
  </Pressable>
)}

<Pressable
  nativeID="github-repo-btn"
  accessibilityRole="link"
  accessibilityLabel="Open GitHub repository"
  onPress={openGithub}
  onHoverIn={() => setGithubHovered(true)}
  onHoverOut={() => setGithubHovered(false)}
  style={[styles.githubBtn, githubHovered && styles.whatsNewBtnHovered]}
>
  <WebHTML html={'<i class="fa-brands fa-github" style="font-size: 14px;"></i>'} />
  <Text style={styles.githubStarsText}>{GITHUB_STARS_LABEL}</Text>
  <WebHTML html={'<i class="fa-solid fa-star" style="color: rgb(255, 203, 44); font-size: 11px;"></i>'} />
</Pressable>

<Pressable
  nativeID="whats-new-btn"
  ...
>
```

Style intent:

- `LoginActionButton` in the nav appears immediately left of the GitHub button and uses the same compact hover treatment.
- `githubBtn` reuses the news log border, background, radius, and hover effect.
- Width is content-based with `minHeight: 28`, not the fixed `28 x 28` circle.
- Gap and padding should match adjacent nav controls.
- Hover lift, shadow, and background should be the same as `whatsNewBtnHovered`.
- On narrow widths, keep the GitHub button in the same right-side cluster and do not overlap language controls.

Add tests:

```js
test('login, github repo, and news log buttons are ordered correctly', () => {
  const nav = read('news-app/components/NavBar.tsx')
  assert.match(nav, /LoginActionButton/)
  assert.match(nav, /nativeID="github-repo-btn"/)
  assert.match(nav, /nativeID="whats-new-btn"/)
  assert.ok(nav.indexOf('LoginActionButton') < nav.indexOf('nativeID="github-repo-btn"'))
  assert.ok(nav.indexOf('nativeID="github-repo-btn"') < nav.indexOf('nativeID="whats-new-btn"'))
  assert.match(nav, /GITHUB_STARS_LABEL/)
  assert.match(nav, /fa-solid fa-star/)
})
```

## Task 11: Supabase Auth Configuration

Make these operational changes in Supabase before production rollout:

- Enable GitHub OAuth provider.
- Enable Google OAuth provider.
- Disable the Email provider, or at minimum disable email sign-up and remove all email login surfaces from the app.
- Add the production origin as an allowed redirect URL.
- Add the local development origin as an allowed redirect URL.
- Confirm OAuth callback returns to the app root and `detectSessionInUrl: true` hydrates the session.
- Confirm there is no anonymous invite redemption path in the production UI.

Document the exact provider status and redirect origins in `docs/api-keys-and-env.md` or the repo's existing deployment notes file.

## Task 12: Documentation Updates

Update docs that still describe closed-beta invite behavior:

- `docs/current-state.md`
- `docs/instructions.md`
- `docs/project-interview-resume-brief.md`
- Any superpowers handoff doc that calls the app invite-gated instead of OAuth-gated.

Required wording:

- Public daily news feed is available without login.
- Anonymous users see a small nav `Login` button and inline `Please log in` rows where Deep Analysis, Q&A, Trend Brief, and premium interactive analysis would appear.
- Deep Analysis, Q&A, Trend Brief, and premium interactive analysis require GitHub or Google login before actual content is shown.
- Logged-in premium content is served through bounded feed RPCs and Edge Functions, not broad direct REST reads from `article_deep_analysis`, `trend_briefs`, `user_article_questions`, or `user_trend_briefs`.
- Anonymous users never receive generated questions, Deep Analysis payloads, or Trend Brief payloads through `fetch_grouped_feed` or direct REST reads.
- Authenticated users see shared auto-generated defaults until they manually refresh or generate a replacement.
- Manual question refresh writes `user_article_questions` for the current user and does not mutate `daily_news.questions`.
- Manual Trend Brief generation writes `user_trend_briefs` for the current user and does not mutate shared `trend_briefs`.
- User A's manual generation never changes what User B sees.
- Email sign-up is intentionally disabled for now.
- Closed-beta invite logic is legacy and no longer the primary user access model.
- The whole production app is not IP-allowlisted because daily news is public.
- Admin/internal operations, staging previews where desired, and service-role paths use IP restrictions or platform access controls.

## Task 13: Verification

Run focused tests:

```bash
node --test tests/oauth-public-access.test.mjs
node --test tests/changelog-nav.test.mjs
```

These static tests are guardrails, not proof of security. Do not treat the implementation as release-ready until the manual/browser/API checks below pass against a running local or staging instance.

Run the broader suite:

```bash
npm test
```

Run app type checking or the repo's closest equivalent:

```bash
npm --prefix news-app run typecheck
```

Add this script to `news-app/package.json` before running it:

```json
"typecheck": "tsc --noEmit"
```

If the package script cannot be added in the same slice, use:

```bash
cd news-app
npx tsc --noEmit
```

Run SQL lint/smoke checks if available. At minimum, inspect the migration for valid SQL:

```bash
rg "public_read_article_deep_analysis|revoke select on public.article_deep_analysis|revoke select on public.trend_briefs|auth_required|requireRateLimit" supabase/sql supabase/functions
```

Manual QA:

1. Anonymous web session:
   - Open app in a clean browser profile.
   - Daily articles load.
   - A small `Login` button appears in the nav immediately left of the GitHub repo button.
   - GitHub repo button appears left of the news log button.
   - GitHub repo button opens the configured repository URL.
   - News log opens and includes the Deep Analysis entry.
   - Deep Analysis areas show `Please log in to view Deep Analysis and Q&A.` with a `Login` button, and do not show Deep Analysis content.
   - Q&A areas show a login-required row with a `Login` button, and do not show questions, answers, or Deep Think controls.
   - Trend Brief shows a login-required row with a `Login` button, and does not show trend brief content.
   - Clicking any inline `Login` button opens the same OAuth prompt as the top nav `Login` button.

2. Authenticated GitHub session:
   - Sign in with GitHub.
   - Session survives refresh.
   - Deep Analysis controls appear.
   - Q&A works.
   - Trend Brief appears.
   - Sign out returns to public-feed-only mode.

3. Authenticated Google session:
   - Repeat the same smoke checks.

4. Direct API checks:
   - Anonymous `fetch_grouped_feed` returns daily articles with source labels, but `questions`, `deep_analysis_id`, `deep_analysis_status`, and `deep_analysis` are all `null`.
   - Authenticated `fetch_grouped_feed` returns `questions_source = 'auto_default'` before manual refresh.
   - After User A refreshes article questions, User A's `fetch_grouped_feed` returns `questions_source = 'user_override'`.
   - After User A refreshes article questions, User B's `fetch_grouped_feed` still returns `questions_source = 'auto_default'`.
   - Anonymous direct REST read of `trend_briefs` is denied by permissions.
   - Authenticated direct REST read of `trend_briefs` is denied by permissions.
   - Authenticated direct REST read of `article_deep_analysis` is denied by permissions.
   - Authenticated Trend Brief Edge Function cache path checks `user_trend_briefs` before shared `trend_briefs`.
   - After User A manually generates a Trend Brief, User B still sees the shared auto-generated brief.
   - Anonymous `answer-question` request returns `401` with `auth_required`.
   - Anonymous `refresh-questions` request returns `401` with `auth_required`.
   - Anonymous `generate-trend-brief` request returns `401` with `auth_required`.
   - Browser-visible `401`, `403`, and `429` responses include `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers`, and JSON bodies.
   - Authenticated requests continue to work.
   - Repeated authenticated Q&A calls eventually return `429` with `rate_limited` after the configured test limit.
   - Admin/internal paths return `403` with `admin_ip_allowlist_not_configured` when `ADMIN_IP_ALLOWLIST` is unset.
   - Admin/internal paths return `403` with `ip_not_allowed` from a non-allowlisted IP.
   - Public daily feed still works from anonymous sessions and is not blocked by the admin IP allowlist.

## Rollout Plan

1. Merge the code and SQL migration behind a short release branch.
2. Apply the SQL migration in staging.
3. Configure Supabase OAuth providers in staging.
4. Verify anonymous public feed and authenticated premium flows.
5. Apply the SQL migration in production.
6. Configure production OAuth redirect URLs.
7. Deploy frontend and functions.
8. Watch logs for:
   - OAuth callback errors.
   - 401 counts from premium endpoints.
   - 403 counts from admin IP allowlist checks.
   - 429 counts from per-user/per-IP rate limits.
   - feed RPC errors for anonymous sessions.
   - direct table permission denials for `trend_briefs` or `article_deep_analysis` from browser clients.
   - Deep Analysis feed RPC errors for authenticated users.
9. Keep `redeem-invite` deployed for one release as unused legacy code.
10. Remove invite redemption in a follow-up cleanup after production behavior is stable.

## Rollback Plan

Fast frontend rollback:

- Revert the app deploy to the prior beta-gated build.
- Keep OAuth providers enabled because they do not break existing users.

Fast backend rollback:

- If authenticated Deep Analysis breaks, first roll back the `fetch_grouped_feed` function body to the last working bounded version.
- Keep direct `article_deep_analysis` and `trend_briefs` table reads closed to browser clients.
- If rate limits are too strict, increase `p_limit` values or disable the specific Edge Function rate-limit call while keeping JWT auth and RLS in place.
- Do not remove `auth_required` checks from premium endpoints as a rollback shortcut.

SQL rollback for the bounded feed function only:

```sql
-- Reapply the previous known-good public-safe fetch_grouped_feed body.
-- Do not grant direct browser select on public.article_deep_analysis.
revoke select on public.article_deep_analysis from anon, authenticated;
revoke select on public.trend_briefs from anon, authenticated;
```

Only use the SQL rollback if production authenticated users cannot access Deep Analysis and a frontend rollback is not enough.
