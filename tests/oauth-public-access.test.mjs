import test from 'node:test'
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
  const config = read('news-app/lib/config.ts')

  assert.match(auth, /signInWithOAuth\(\{\s*provider:\s*'github'/s)
  assert.match(auth, /signInWithOAuth\(\{\s*provider:\s*'google'/s)
  assert.match(config, /APP_URL\s*=\s*\n\s*process\.env\.EXPO_PUBLIC_APP_URL\s*\|\|\s*'https:\/\/newnews\.dev'/)
  assert.match(auth, /redirectTo \? \{ redirectTo \} : undefined/)
  assert.match(auth, /return APP_URL/)
  assert.match(auth, /exchangeCodeForSession\(code\)/)
  assert.match(auth, /url\.searchParams\.delete\('code'\)/)
  assert.doesNotMatch(auth, /window\.location\.origin/)
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
  const loginRequired = read('news-app/components/LoginRequiredInline.tsx')
  const authPrompt = read('news-app/components/AuthPrompt.tsx')
  const navBar = read('news-app/components/NavBar.tsx')
  const app = read('news-app/App.tsx')

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
  assert.match(loginRequired, /lang\?: 'en' \| 'zh'/)
  assert.match(loginRequired, /请登录后查看。/)
  assert.match(loginRequired, /lang === 'en' \? 'Login' : '登录'/)
  assert.match(articleCard, /请登录后查看深度分析和问答。/)
  assert.match(xThreadCard, /请登录后提问这条动态串。/)
  assert.match(trendBrief, /请登录查看趋势简报。/)
  assert.match(authPrompt, /登录后继续/)
  assert.match(navBar, /lang === 'en' \? 'Login' : '登录'/)
  assert.match(app, /<AuthPrompt\s*\n\s*visible=\{authPromptOpen\}\s*\n\s*lang=\{lang\}/)
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

test('security helper exact-matches admin allowlist and avoids cidr parsing', () => {
  const security = read('supabase/functions/_shared/security.ts')

  assert.match(security, /ADMIN_IP_ALLOWLIST/)
  assert.match(security, /allowlist\.includes\(ip\)/)
  assert.doesNotMatch(security, /cidr/i)
})
