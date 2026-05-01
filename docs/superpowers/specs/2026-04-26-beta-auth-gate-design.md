# Beta Auth Gate (Invite-Link, Round 1) — Design Plan

## Status: Shipped 2026-04-28 (with deltas)

The design below is the as-approved blueprint. The shipped implementation matches it with the deltas in the table — kept here so future readers know what the as-built reality is. §6 (Round 2) is unchanged and remains the forward plan.

| # | Delta | Where it landed | Why it diverged from the spec |
|---|---|---|---|
| 1 | **Operator pre-reqs (project settings).** Three Supabase project-level toggles must be set before Round 1 will work: Auth → Sign In/Up → **Anonymous Sign-Ins ON**; Auth → Attack Protection → **CAPTCHA OFF** (or wire a widget); any `on_auth_user_created` trigger on `auth.users` must early-return on `new.is_anonymous`. | Operator runbook ([docs/instructions.md](../../instructions.md)); gotchas in [docs/keep-in-mind.md](../../keep-in-mind.md) | This project's pre-existing `handle_new_user()` inserted into `public.user_tokens` — failed for anonymous users with no clear error (HTTP 500 "Database error creating anonymous user"; real cause only visible in Auth Logs). Spec assumed a clean project. |
| 2 | **CORS allowlist.** Spec said `'authorization, content-type'`. Shipped: `'authorization, apikey, content-type, x-client-info'`. | [supabase/functions/redeem-invite/index.ts](../../../supabase/functions/redeem-invite/index.ts) `corsHeaders` | `supabase-js` adds `apikey` (and sometimes `x-client-info`) headers automatically alongside `Authorization` when calling Edge Functions. Without these in the allowlist the browser fails the preflight before the function runs (`Request header field apikey is not allowed`). |
| 3 | **Removed `refreshSession()` entirely.** Spec said `getUser()` after `ok: true`. Shipped: originally added `refreshSession()` but it caused silent sign-outs due to a race condition with fresh anonymous JWTs. Current implementation relies *entirely* on the stale-JWT recovery branch in `bootstrap()`. | [news-app/lib/auth.ts](../../../news-app/lib/auth.ts) `bootstrap()` | `refreshSession()` was rejecting JWTs that were only milliseconds old, forcing the Supabase client to drop the session entirely. By removing it, the UI achieves `authed` state immediately, and the JWT naturally refreshes on the next reload, unbricking users and maintaining session integrity. |
| 4 | **No Postgres `base64url`.** Spec's operator runbook used `encode(gen_random_bytes(12), 'base64url')`. Shipped uses the explicit URL-safe replace chain. | [supabase/sql/20260426_beta_invites.sql](../../../supabase/sql/20260426_beta_invites.sql) operator workflow comment; [docs/instructions.md](../../instructions.md) "Generate a beta invite" | Postgres `encode()` only supports `base64`, `escape`, `hex`. The shipped form is `replace(replace(replace(encode(gen_random_bytes(12), 'base64'), '+', '-'), '/', '_'), '=', '')`. |
| 5 | **Forward-compat schema.** Spec §6 designs but defers Round 2. Shipped: `beta_invites.email TEXT NULL` was added in the Round 1 migration so Round 2 doesn't require a schema change. | [supabase/sql/20260426_beta_invites.sql](../../../supabase/sql/20260426_beta_invites.sql) | Pure forward-compat; no design change. Round 1 inserts leave it null. |

Verification (§Verification) was completed on the shipped code: §B Security audit B1–B5 all passed against `https://exjbwdcxyrkxsmzaowkx.supabase.co`. §A behavioral A1–A10 are partially run (happy path verified via live redeem); A8b (network-partition recovery) is the one critical-path scenario still pending live verification — recommended before broad invite distribution.

---

## Context

The News Project is entering closed beta. Round 1 users are the operator's WeChat contacts — **no email exchange happens at invite time**, so any email-dependent auth (magic link, OAuth) is dead on arrival. Round 2+ will introduce email-based onboarding.

The user requirement is unambiguous: **"auth login should appear before everything shows up"** — full-screen gate at app root, blocking all data fetches and UI until a session exists. The gate will eventually move into an onboarding flow at public launch; for now it is the literal first thing the user sees.

There are no per-user token limits; the gate is purely access control, not throttling.

This spec ships **Round 1** (invite-link redemption) and **designs but defers** Round 2 (magic link).

## Diagnose (5-Dimension Lens)

| Dim | Status |
|---|---|
| 1. Ingestion | N/A. |
| 2. Advanced RAG | N/A directly, but the `auth.uid()` this spec creates is the prerequisite for Spec C's qa_logs RLS, which is the prerequisite for any flywheel-driven RAG improvement. |
| 3. Metrics / RBAC | Today there is no `auth.uid()`-scoped table at all. The first one lands here (`beta_invites`); future user-scoped tables (`qa_logs`, history, subscriptions) inherit the same pattern. RLS is the access-control layer per Architectural Principle 7. |
| 4. Flywheel | Closed beta with stable user identity is the cleanest possible source for badcase capture. Spec C will key qa_logs on `auth.uid()` produced here. |
| 5. Safety / PII | `auth.users.email` will land in round 2 and is the system's first PII surface. Round 1 is email-less, but `display_name` ("Wang Lei", "Founder Park 朋友") is operator-attributable. RLS must lock all `beta_invites` reads/writes to service-role only. |

## Decision (locked, per AskUserQuestion confirmation)

| Item | Decision |
|---|---|
| Round 1 auth method | **Invite-link redemption** — admin generates URL with embedded code, shares over WeChat. Click = signed in. No email, no password, no OTP. |
| User type under the hood | Supabase **anonymous user** (`auth.users.is_anonymous = true`). Real `auth.uid()` UUID, real RLS, no email/phone column populated. |
| Display name | Set by admin **at invite creation**. Immutable from the client side. Stored in `auth.users.raw_app_meta_data.display_name` (server-only, untamperable). |
| Round 2 method (deferred build) | **Magic link** to email. Anonymous users from Round 1 can be upgraded via `supabase.auth.updateUser({ email })` keeping their `auth.uid()`. |
| Gate behavior | **Full-screen** while `status === 'checking'` or `'gated'`. App data fetches do not fire until `status === 'authed'`. |
| Scope | One round of beta users; admin manually creates `beta_invites` rows in Supabase dashboard. No invite-creation UI. |

## Architectural reality check

- **No new cron trigger.** `redeem-invite` is request-driven. Decision Framework Q1 = clear.
- **Token budget:** zero LLM calls on this path. Q2 = clear.
- **Subrequest budget:** new Edge Function makes 2 PostgREST calls (lookup invite, mark used + update user). Not a CF Worker, so subrequest cap N/A. Q3 = clear.
- **Queue path:** auth events are not ingested content. Q4 = clear.
- **Failure mode:** if `redeem-invite` is unreachable, the anonymous user is left without `is_beta_user = true`. Frontend treats this as "gated" and shows a retry button. The orphaned anonymous user costs nothing (Supabase MAU only counts active users). Q5 = clear.

## Recommended approach

### 1. Schema — `beta_invites` table

**File:** `supabase/sql/20260426_beta_invites.sql` (new)

```sql
create table public.beta_invites (
  code          text primary key,                                 -- random URL-safe slug (admin generates)
  display_name  text not null,                                    -- "Wang Lei", "Founder Park 朋友"
  default_lang  text not null default 'zh' check (default_lang in ('en','zh')),
  expires_at    timestamptz,                                      -- nullable = never expires
  used_at       timestamptz,                                      -- set on redemption
  user_id       uuid references auth.users(id) on delete set null,-- the redeeming user
  created_at    timestamptz not null default now()
);

create index beta_invites_user_id_idx on public.beta_invites(user_id) where user_id is not null;

-- RLS: NO anon policies. Only the redeem-invite Edge Function (service role) reads/writes.
alter table public.beta_invites enable row level security;

-- Helper used by future user-scoped tables (qa_logs, etc.)
create or replace function public.is_beta_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.beta_invites
    where user_id = auth.uid()
      and used_at is not null
      and (expires_at is null or expires_at > now())
  );
$$;
grant execute on function public.is_beta_user() to anon, authenticated;
-- anon role is granted defensively. Anonymous users receive the `authenticated`
-- role in their JWT, but explicit `anon` grant guards against any future code path
-- that calls this from an unauthenticated context (e.g. a public RPC that gates
-- behavior on whether the caller is a beta user).
```

**Why a function and not a column on `auth.users`:**
- `auth.users` is owned by the Supabase Auth schema; we do not add columns to it.
- `raw_app_meta_data.is_beta_user` would work for client-side gate logic but cannot be referenced from RLS policies cleanly.
- A `security definer` function called from frontend logic gives a clean boolean. However, **do not use this function in `UPDATE` or `SELECT` RLS policies** (like in `qa_logs`), as Postgres `RETURNING` clauses can fail when evaluating the security definer context against the updated row state. Use `user_id = auth.uid()` instead.

**Operator workflow** (Supabase dashboard SQL editor):

```sql
insert into beta_invites (code, display_name, default_lang)
values (
  encode(gen_random_bytes(12), 'base64url'),  -- e.g. "K8aJ2mN4qP1xR7vZ"
  'Wang Lei',
  'zh'
)
returning code;
-- Operator copies the returned code, shares: https://news.app/?invite=<code>
```

### 2. Edge Function — `redeem-invite`

**File:** `supabase/functions/redeem-invite/index.ts` (new)

**Contract:**
- Method: POST
- Auth: requires the *just-created anonymous JWT* in the Authorization header (Supabase default `verify_jwt = true`).
- Body: `{ code: string }`
- Returns: `{ ok: true, display_name, default_lang }` on success; `{ ok: false, error: 'invalid' | 'used' | 'expired' }` on failure.

**JWT handling:** Deploy with `verify_jwt = true` (the Supabase default). The Supabase API gateway verifies the JWT signature *before* the function runs — there is no need to import `jose` or re-verify in code. Inside the function, instantiate a per-request Supabase client with the caller's `Authorization` header and call `auth.getUser()` to obtain the verified `userId`.

**Pseudocode:**

```ts
const { code } = await req.json()
const authHeader = req.headers.get('Authorization') ?? ''

// 1. Per-request client carrying the caller's JWT; getUser() returns the verified user.
const sbAsUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: authHeader } },
})
const { data: { user } } = await sbAsUser.auth.getUser()
if (!user) return json({ ok: false, error: 'invalid' }, 401)
const userId = user.id

// 2. Service-role client for the privileged writes that follow.
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// 3. Atomic claim: lookup + mark-used in a single update.
let { data } = await sb
  .from('beta_invites')
  .update({ used_at: new Date().toISOString(), user_id: userId })
  .eq('code', code)
  .is('used_at', null)
  .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
  .select('display_name, default_lang')
  .maybeSingle()

// 4. If the atomic claim found nothing, distinguish the cause AND recover idempotently.
if (!data) {
  const { data: row } = await sb
    .from('beta_invites')
    .select('used_at, expires_at, user_id, display_name, default_lang')
    .eq('code', code)
    .maybeSingle()

  if (!row) return json({ ok: false, error: 'invalid' })

  if (row.used_at) {
    // IDEMPOTENT RECOVERY: the caller already owns this invite — most likely
    // a network-partition retry where step 3 succeeded server-side but the
    // client never received the response. Fall through to step 5 so the
    // app_metadata update is re-applied (cheap, safe, and ensures the client
    // is in the correct state).
    if (row.user_id === userId) {
      data = { display_name: row.display_name, default_lang: row.default_lang }
    } else {
      // Truly used by someone else — hard fail.
      return json({ ok: false, error: 'used' })
    }
  } else {
    // Not used, but the .or() filter rejected it → expired.
    return json({ ok: false, error: 'expired' })
  }
}

// 5. Set the server-only metadata. Runs for both first-claim and idempotent retry.
await sb.auth.admin.updateUserById(userId, {
  app_metadata: {
    is_beta_user: true,
    display_name: data.display_name,
    default_lang: data.default_lang,
  },
})

return json({ ok: true, display_name: data.display_name, default_lang: data.default_lang })
```

**Why this shape:**
- **Atomic claim first.** The `update ... where used_at is null` is the happy-path: one round-trip, race-safe (Postgres serializes the row update). If two devices race the same invite, exactly one wins.
- **Idempotent recovery on `used_at IS NOT NULL` AND `user_id = caller`.** This is the network-partition fix: if step 3 wrote the row but the response never reached the client, the client retries with the same JWT, the atomic claim returns nothing, and we recognize *the caller is already the owner* — re-apply metadata (cheap, no-op if already set) and return `ok: true`. Without this branch, any dropped response permanently locks the user out with a misleading `error: 'used'`.
- **`maybeSingle()` instead of `single()`** so the no-row case doesn't throw — we want to fall through to the diagnostic lookup.
- **`app_metadata` (not `user_metadata`)** means the client cannot tamper with `is_beta_user` via `supabase.auth.updateUser({ data })`. The metadata write is service-role only.
- **No manual `jose` import.** The Supabase API gateway verifies the JWT signature (per `verify_jwt = true`); the function only needs to extract the verified user via the SDK pattern above. This matches Architectural Principle 7's "stateless JWT verification" without re-implementing it.

**Deploy command:** `supabase functions deploy redeem-invite` — `verify_jwt = true` is on by default, so external attackers cannot call it without a Supabase-issued token.

### 3. Supabase client — session persistence

**File:** [news-app/lib/config.ts](../../../news-app/lib/config.ts)

The existing client has no auth config. Update:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'

const isWeb = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: isWeb ? undefined : AsyncStorage,  // web auto-uses localStorage
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,                  // we handle ?invite= ourselves; Supabase has no email-link flow yet
    },
  }
)
```

**Package add:** `@react-native-async-storage/async-storage` (Expo-managed; one `npx expo install` away).

### 4. Frontend — `AuthGate` hook + screen

**Files:**
- `news-app/lib/auth.ts` (new) — the `useAuthGate` hook
- `news-app/components/BetaGateScreen.tsx` (new) — the full-screen gate UI

#### 4a. `useAuthGate` hook contract

```ts
type GateStatus = 'checking' | 'gated' | 'authed' | 'redeeming' | 'redeem_failed'

export function useAuthGate(): {
  status: GateStatus
  displayName: string | null
  defaultLang: 'en' | 'zh' | null
  redeemError: 'invalid' | 'used' | 'expired' | 'network' | null
  retry: () => void
}
```

**Bootstrap sequence (runs once on mount, and on every `retry()`):**

1. `supabase.auth.getSession()` → call this `existing`.
2. If `existing` has `app_metadata.is_beta_user === true` → `status = 'authed'`. Done.
3. Parse `?invite=<code>` from URL (web) or initial deep-link URL (native via `Linking.getInitialURL()`).
4. If no `code` and no `existing` session → `status = 'gated'`. Done.
5. If `code` is present:
   - `status = 'redeeming'`.
   - **Reuse before create.** If `existing` is non-null (it's an unredeemed anonymous user from a previous attempt), **skip `signInAnonymously()` and reuse that session**. Otherwise call `signInAnonymously()` to mint a new anonymous user.
   - Call `redeem-invite` Edge Function with `{ code }`. The user's JWT is sent automatically by the Supabase JS client.
   - **On `ok: true`:** refresh user (`getUser()` to pull the fresh `app_metadata`), strip `?invite=` from URL, `status = 'authed'`.
   - **On `error: 'used' | 'expired' | 'invalid'`:** the invite is hard-failed. Sign out the anonymous user (it has no further use), set `status = 'redeem_failed'` with the error code.
   - **On network error** (fetch threw, no `ok`/`error` field returned): **do NOT sign out.** Keep the anonymous session intact in AsyncStorage so the next `retry()` can reuse the same `auth.uid()` and trigger the Edge Function's idempotent-recovery branch (Step 2 §4). Set `status = 'redeem_failed'` with reason `'network'`.

**Why "reuse before create" matters:** if the redeem-invite request reached the server and succeeded, but the response was lost in transit, the server has already written `beta_invites.user_id = <anon-uid>`. The retry **must** present the same `auth.uid()` so the Edge Function recognizes the caller as the rightful owner and re-applies metadata instead of returning `error: 'used'`. Calling `signInAnonymously()` a second time would mint a fresh UUID and permanently lock the user out — this is the bug the spec exists to prevent.

The `retry()` action re-runs this bootstrap from step 1. Because the failed-but-not-signed-out anonymous session is still in storage, step 1 picks it up and step 5 reuses it.

**Subscribe to auth state changes:** `supabase.auth.onAuthStateChange` → if user signs out, drop back to `'gated'`.

#### 4b. `BetaGateScreen` UI

Three render branches, all full-screen, all using the existing design language (`#F7F6F2` background, Space Grotesk + Manrope, no dark mode):

| Status | Render |
|---|---|
| `checking`, `redeeming` | Centered logo + spinner + label ("Loading…" / "Redeeming invite…") |
| `gated` | Logo + headline "News Project — Closed Beta" + body "This is an invite-only beta. Ask Hui for an invite link." + a `?` link to a static "How to request access" page (operator's choice; can be empty for round 1). |
| `redeem_failed` | Logo + headline "Invite link couldn't be used" + reason-specific copy ("This invite was already used" / "This invite expired" / "Invite code not recognized" / "Network error — try again") + primary CTA: `Try again` (calls `retry()`) for `network`, otherwise just "Ask Hui for a fresh invite." |

Bilingual strings live inline on the component (matching existing house style — e.g. `SubscriptionManualModal.tsx`'s `STRINGS` constant). Default language for the gate before any session = browser/device locale → fall back to `zh` (per round-1 audience).

### 5. `App.tsx` integration

**File:** [news-app/App.tsx](../../../news-app/App.tsx)

The integration is surgically small:

```tsx
import { useAuthGate } from './lib/auth'
import BetaGateScreen from './components/BetaGateScreen'

export default function App() {
  const { status, displayName, defaultLang } = useAuthGate()

  // Existing state hooks remain
  const [lang, setLang] = useState<'en' | 'zh'>('en')

  // NEW: when defaultLang lands from auth, prefer it once
  useEffect(() => {
    if (defaultLang && status === 'authed') setLang(defaultLang)
  }, [defaultLang, status])

  // CRITICAL: gate every data-fetching effect on `status === 'authed'`
  useEffect(() => {
    if (status !== 'authed') return
    // existing source/article fetch logic
  }, [status, /* existing deps */])

  if (status !== 'authed') {
    return <BetaGateScreen status={status} onRetry={...} />
  }

  // existing app shell render
}
```

**Every existing `useEffect` that fires Supabase queries must add `if (status !== 'authed') return` at the top.** This is the spec's most error-prone instruction — list every effect to be guarded:
- `sources` fetch (current ~line 75)
- articles fetch (the main feed effect)
- trend brief generation/fetch
- `AppState` change listener (still safe to mount, but its handler must early-return)
- Any polling intervals

The SWE will produce the exact list as part of implementation; the spec mandates the rule.

### 6. Round 2 design (built later, not now)

Email + magic link, deferred but designed so the schema/RLS doesn't need rework:

- `beta_invites.email TEXT NULL` column added (round 1 leaves it null).
- Operator workflow for round 2: insert with `email` populated, share the `?invite=` URL **and** instruct the user to enter their email at the gate.
- Gate gains a second screen: "Enter your email" → calls `supabase.auth.signInWithOtp({ email })`. After magic link click, the user lands in the app already signed in; the gate runs `redeem-invite` with the code in URL, this time on a non-anonymous user. The `redeem-invite` server logic is unchanged — it accepts both anonymous and email-bound users.
- Round-1 anonymous users can later add an email via `supabase.auth.updateUser({ email })`. `auth.uid()` is preserved; qa_logs continuity is preserved.

The schema/Edge-Function contract above is forward-compatible with this — no breaking change required.

## Verification

### A. Behavioral (manual, blocking before round-1 ship)

| # | Scenario | Expected |
|---|---|---|
| 1 | Fresh browser, no `?invite=` | Gate renders ("ask Hui for invite"); no `daily_news` request fired (verify in Network tab) |
| 2 | Fresh browser, valid unused `?invite=K8a...` | Gate flashes `redeeming` → app loads with `displayName` set; `?invite=` stripped from URL |
| 3 | Reload after #2 | App loads directly without flashing the gate (session persists) |
| 4 | Same `?invite=` on a second device | Gate shows `redeem_failed` with reason `'used'` |
| 5 | Invalid `?invite=NOPE` | Gate shows `redeem_failed` with reason `'invalid'` |
| 6 | Expired invite | Gate shows `redeem_failed` with reason `'expired'` |
| 7 | Sign out via dev console (`supabase.auth.signOut()`) | Gate re-appears immediately (auth state listener); reload behavior matches #1 |
| 8 | Network failure during redeem (offline simulator) | Gate shows `redeem_failed` reason `'network'` with `Try again` button; clicking it retries |
| 8b | **Network-partition recovery (CRITICAL).** Use Chrome DevTools Network tab → set throttling to "Offline" *after* the redeem-invite POST has flown but before the response returns (or use `Block request URL` mid-flight). Then go back online and click `Try again`. | Gate transitions to `authed`. Verify in Supabase dashboard that `beta_invites.used_at` is set exactly once and `user_id` matches the **same** `auth.uid()` across both attempts (no orphaned anonymous user). |
| 8c | **Hard duplicate** — open the same `?invite=` URL in a second incognito window before retrying #8b. | Second window gets `redeem_failed` reason `'used'`. The first window still recovers cleanly via #8b. |
| 9 | Native (Expo Go on phone): deep link `news://?invite=...` | Same flow as web |
| 10 | After redeem, all existing app functionality works (feed loads, trend brief generates, RAG answers stream) | No regressions |

### B. Security audit (architect, before round-1 ship)

1. **Anonymous user without `is_beta_user`:** call `supabase.from('beta_invites').select('*')` from a browser dev console after `signInAnonymously()`. Expected: zero rows (RLS blocks). If you can read any row, RLS is misconfigured.
2. **`is_beta_user()` cannot be tricked:** call the function as an unredeemed anonymous user. Expected: returns `false`.
3. **`raw_app_meta_data.is_beta_user` is uneditable client-side:** from the dev console after redemption, attempt `supabase.auth.updateUser({ data: { is_beta_user: false } })`. Expected: this updates `user_metadata`, not `app_metadata`. The `is_beta_user()` function (which queries `beta_invites`, not metadata) is unaffected. Verify in Supabase dashboard that `raw_app_meta_data` is unchanged.
4. **Direct redeem-invite call without JWT:** `curl` the function endpoint without `Authorization`. Expected: 401.
5. **Direct redeem-invite call with anon-key JWT (not a user JWT):** Expected: 401 (the function distinguishes user-bound JWT from anon-key JWT by extracting `sub` claim and checking it's a real user UUID).

### C. Forward-compatibility check (architect, paper exercise)

Read this spec's Round 2 section side-by-side with the schema and confirm: adding `email` column + adding the OTP flow at the gate require **zero changes** to `redeem-invite/index.ts`, `is_beta_user()`, or the existing AuthGate state machine. If anything would need to change, fix the round-1 design now.

## Out of scope

- Per-user token quotas / throttling. (User stated: no token limits in beta.)
- Invite-creation admin UI. (Operator uses Supabase dashboard SQL editor.)
- Email magic link **build** (designed in §6, deferred).
- Anonymous-to-email upgrade UI (designed in §6, deferred).
- Onboarding tour. (User stated: gate moves into onboarding at public launch; not now.)
- iOS deep-link configuration in `app.json`. (Required when round-1 ships on iOS — current state is web-first; native deep-link wiring is its own small spec.)
- `qa_logs` table and 👍/👎 capture (Spec C — depends on this spec).

## Critical files

| File | Status |
|---|---|
| `supabase/sql/20260426_beta_invites.sql` | New |
| `supabase/functions/redeem-invite/index.ts` | New |
| [news-app/lib/config.ts](../../../news-app/lib/config.ts) | Modified (auth config block) |
| `news-app/lib/auth.ts` | New (useAuthGate hook) |
| `news-app/components/BetaGateScreen.tsx` | New |
| [news-app/App.tsx](../../../news-app/App.tsx) | Modified (gate render + every data effect guarded) |
| `news-app/package.json` | `@react-native-async-storage/async-storage` added |

## Sequencing

- **Independent of Spec A** (P0 cap) — both can ship in parallel.
- **Required by Spec C** (qa_logs) — qa_logs RLS uses `is_beta_user() and user_id = auth.uid()` defined here. Spec C cannot start until this lands.
- **Independent of Spec D** (chunking).
