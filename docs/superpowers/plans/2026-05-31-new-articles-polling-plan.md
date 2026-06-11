
# New Articles Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frontend Supabase Realtime `daily_news` subscription with low-frequency polling while preserving the existing new-articles banner behavior.

**Architecture:** Keep `checkMissedArticles()` as the single source of truth for banner count checks. Remove `.channel('public:daily_news').on('postgres_changes'...)` entirely, then call `checkMissedArticles()` from a guarded interval and from app/browser focus events. The polling query remains the existing cheap `HEAD` count query against `daily_news`.

**Tech Stack:** Expo React Native Web, Supabase JS, `AppState`, browser `visibilitychange`/`focus`, Node test runner for static regression checks.

---

## Operational Context

The Supabase outlier report shows `realtime.list_changes(...)` as a top database workload:

- `709,182` calls
- `01:05:07` total execution time
- `25.2%` of total execution time

The only app usage found is in `news-app/App.tsx:201-222`, where a Realtime subscription listens for `INSERT` on `public.daily_news` and calls `checkMissedArticles()`. The existing `checkMissedArticles()` function already performs the desired lightweight count query, including auth, active category, date range, loading-state, and feed-baseline guards.

## Non-Goals

- Do not remove the `NewArticlesBanner` component.
- Do not change feed loading, pagination, category filters, date range semantics, or the fallback from Today to 3D.
- Do not add a new backend endpoint unless the existing count query proves expensive after Realtime is removed.
- Do not change Supabase database Realtime settings from code. This frontend change should be deployable independently.

## Files

- Modify: `news-app/App.tsx`
- Add: `tests/new-articles-polling.test.mjs`
- Optional later, only if needed after measurement: `docs/keep-in-mind.md`

---

### Task 1: Add Static Regression Coverage

**Files:**
- Add: `tests/new-articles-polling.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/new-articles-polling.test.mjs`:

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = () => readFileSync('news-app/App.tsx', 'utf8')

test('new article monitoring does not use Supabase Realtime channels', () => {
  const app = source()

  assert.doesNotMatch(app, /\.channel\(['"]public:daily_news['"]\)/)
  assert.doesNotMatch(app, /postgres_changes/)
  assert.doesNotMatch(app, /removeChannel/)
})

test('new article monitoring keeps lightweight polling and focus checks', () => {
  const app = source()

  assert.match(app, /NEW_ARTICLES_POLL_INTERVAL_MS/)
  assert.match(app, /setInterval\(\(\) => \{\s*checkMissedArticles\(\)\s*\}/s)
  assert.match(app, /AppState\.addEventListener\('change'/)
  assert.match(app, /visibilitychange/)
  assert.match(app, /\.select\('id', \{ count: 'exact', head: true \}\)/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test tests/new-articles-polling.test.mjs
```

Expected: fail because `App.tsx` still contains `.channel('public:daily_news')` and `postgres_changes`.

---

### Task 2: Introduce Polling Constants and Browser Focus Guards

**Files:**
- Modify: `news-app/App.tsx`

- [ ] **Step 1: Add polling constants near the `FeedRow` type**

Add:

```ts
const NEW_ARTICLES_POLL_INTERVAL_MS = 5 * 60 * 1000
const NEW_ARTICLES_FOCUS_THROTTLE_MS = 30 * 1000
```

Rationale:

- Five-minute polling cuts hundreds of thousands of Realtime polling calls down to a tiny number of cheap count checks.
- A 30-second focus throttle avoids duplicate checks when browsers emit both `focus` and `visibilitychange`.

- [ ] **Step 2: Add refs for focus throttling**

Near the existing refs:

```ts
const lastNewArticlesCheckRef = useRef(0)
const newArticlesCheckInFlightRef = useRef(false)
```

- [ ] **Step 3: Wrap `checkMissedArticles()` with in-flight and throttle logic**

Update the top of `checkMissedArticles()`:

```ts
const checkMissedArticles = useCallback(async (opts: { force?: boolean } = {}) => {
  if (authStatusRef.current !== 'authed') return
  if (feedLoadingRef.current) return
  if (newArticlesCheckInFlightRef.current) return

  const now = Date.now()
  if (!opts.force && now - lastNewArticlesCheckRef.current < NEW_ARTICLES_FOCUS_THROTTLE_MS) return
  lastNewArticlesCheckRef.current = now
  newArticlesCheckInFlightRef.current = true

  try {
    const latestDate = feedBaselineRef.current
    if (!latestDate) return

    const cat = activeCategoryRef.current
    const dr = dateRangeRef.current

    let query = supabase
      .from('daily_news')
      .select('id', { count: 'exact', head: true })
      .gt('created_at', latestDate)

    if (cat !== 'all') {
      query = query.eq('category', cat)
    }

    if (dr) {
      const s = dr.start.toISOString()
      const e = dr.end.toISOString()
      query = query.or(
        `and(published_at.gte.${s},published_at.lt.${e}),and(published_at.is.null,created_at.gte.${s},created_at.lt.${e})`
      )
    }

    const { count, error } = await query
    if (error) {
      console.error('Error checking missed articles:', error)
      return
    }

    if (count != null && count > 0) {
      setNewArticlesCount(count)
    }
  } finally {
    newArticlesCheckInFlightRef.current = false
  }
}, [])
```

The `force` option lets interval checks run every 5 minutes even though focus checks have a shorter throttle.

---

### Task 3: Remove Realtime Subscription and Add Polling Sources

**Files:**
- Modify: `news-app/App.tsx`

- [ ] **Step 1: Replace the Realtime effect**

Replace the existing comment and effect at `news-app/App.tsx:201-222` with:

```ts
// Polling + focus watcher for new-article catch-up. Avoid Supabase Realtime:
// realtime.list_changes dominated DB execution time on the Nano instance.
useEffect(() => {
  if (authStatus !== 'authed') return

  const pollId = setInterval(() => {
    checkMissedArticles({ force: true })
  }, NEW_ARTICLES_POLL_INTERVAL_MS)

  const appStateSubscription = AppState.addEventListener('change', nextAppState => {
    if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
      checkMissedArticles()
    }
    appStateRef.current = nextAppState
  })

  const handleBrowserFocus = () => {
    checkMissedArticles()
  }

  const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      checkMissedArticles()
    }
  }

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.addEventListener('focus', handleBrowserFocus)
  }
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  return () => {
    clearInterval(pollId)
    appStateSubscription.remove()
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.removeEventListener('focus', handleBrowserFocus)
    }
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }
}, [checkMissedArticles, authStatus])
```

- [ ] **Step 2: Confirm there are no Realtime calls left in `App.tsx`**

Run:

```bash
rg -n "\.channel\(|postgres_changes|removeChannel" news-app/App.tsx
```

Expected: no matches.

---

### Task 4: Preserve Feed Baseline Semantics

**Files:**
- Modify: `news-app/App.tsx`

- [ ] **Step 1: Review the existing baseline assignment**

Keep:

```ts
feedBaselineRef.current = new Date().toISOString()
```

Do not switch it to `rows[0].created_at`.

Reason:

- The current baseline asks “what arrived after this feed load completed?”
- That avoids showing old articles that were returned in the current page but have a `created_at` greater than the first visible row due to date-range/category sorting.
- It also matches the current banner behavior and avoids product behavior churn.

- [ ] **Step 2: Keep `handleLoadNew()` unchanged**

Keep:

```ts
function handleLoadNew() {
  setNewArticlesCount(0)
  setRefreshTrigger(v => v + 1)
}
```

The banner still triggers a normal feed refresh.

---

### Task 5: Verify Locally

**Files:**
- Test: `tests/new-articles-polling.test.mjs`

- [ ] **Step 1: Run the new focused test**

Run:

```bash
node --test tests/new-articles-polling.test.mjs
```

Expected: pass.

- [ ] **Step 2: Run all Node tests**

Run:

```bash
node --test tests/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Run whitespace diff check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Manual browser QA**

Run the app using the existing project command. In the browser:

- Sign in through the beta gate.
- Open Today or 3D feed.
- Confirm no WebSocket/Reatime `channel` connection is created in the Network tab.
- Background the tab for at least 30 seconds, then focus it.
- Confirm a single lightweight `daily_news?select=id` count request runs.
- Leave the tab active for more than 5 minutes.
- Confirm one polling request runs, not continuous Realtime traffic.
- Click the new-articles banner when present and confirm it refreshes the feed.

---

### Task 6: Post-Deploy Measurement

**Files:**
- No code files.

- [ ] **Step 1: Reset expectations**

The outlier report is cumulative since `pg_stat_statements` reset, so the old Realtime query may remain visible for a while. Judge success by new deltas after deploy, not the existing 74-day aggregate.

- [ ] **Step 2: Recheck Supabase after deploy**

Run:

```bash
supabase inspect db outliers
supabase inspect db calls
```

Expected after enough post-deploy traffic:

- `realtime.list_changes(...)` call count no longer climbs quickly.
- The app’s count query may appear, but with tiny total execution time.

- [ ] **Step 3: If Realtime is still hot**

Check whether other clients or old deployed bundles are still open. After active clients age out, Realtime should quiet down. If it does not, inspect Supabase Realtime publications and any other `.channel()` usage.

---

## Separate DB Ops Note: `net._http_response` Ownership Error

The error:

```text
ERROR: 42501: must be owner of table _http_response
```

means the SQL editor role cannot create an index on Supabase-managed `net._http_response`. Do not fight this with app code.

Use one of these routes:

1. Ask Supabase support / AI Assistant whether they can add or recommend an index for `net._http_response(created)` in your project.
2. Reduce the number of pg_cron → `net.http_post` jobs if possible.
3. Keep Edge Functions returning tiny bodies to pg_net so `_http_response` rows stay small.
4. Prefer moving frequent schedules back to external cron/Cloudflare where practical, so Postgres is not doing HTTP dispatch every few minutes.

Do not make the Realtime removal depend on this. The Realtime subscription is a separate and larger avoidable workload.

---

## Self-Review

- Spec coverage: removes Realtime subscription, preserves new-article banner, keeps count query, adds focus and interval checks, defines verification.
- Placeholder scan: no `TBD`, `TODO`, or open-ended implementation steps.
- Type consistency: `checkMissedArticles(opts?: { force?: boolean })` is used consistently by focus and interval callers.
