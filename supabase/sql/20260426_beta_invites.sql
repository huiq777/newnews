-- 20260426 — beta_invites: invite-link redemption table for the closed-beta
-- auth gate (Round 1). See docs/superpowers/specs/2026-04-26-beta-auth-gate-design.md.
--
-- Round 1 is invite-link only (no email). The operator generates a `code`
-- via the dashboard, shares `https://<host>/?invite=<code>` over WeChat,
-- and the user's first click mints an anonymous Supabase user that the
-- redeem-invite Edge Function then ties to this row.
--
-- The `email` column is added now so the Round 2 magic-link flow does not
-- require a future migration. Round 1 inserts leave it null.
--
-- Apply via Supabase SQL Editor. Idempotent — safe to re-run.

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.beta_invites (
  code          text primary key,                                  -- random URL-safe slug (admin generates)
  display_name  text not null,                                     -- "Wang Lei", "Founder Park 朋友"
  default_lang  text not null default 'zh' check (default_lang in ('en','zh')),
  email         text,                                              -- Round 2 magic-link target; null in Round 1
  expires_at    timestamptz,                                       -- nullable = never expires
  used_at       timestamptz,                                       -- set on redemption
  user_id       uuid references auth.users(id) on delete set null, -- the redeeming user
  created_at    timestamptz not null default now()
);

create index if not exists beta_invites_user_id_idx
  on public.beta_invites(user_id) where user_id is not null;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- No anon / authenticated policies. The redeem-invite Edge Function (service
-- role) is the only legitimate reader and writer. A direct PostgREST select
-- from a logged-in anonymous user must return zero rows.
alter table public.beta_invites enable row level security;

-- ── Helper function ──────────────────────────────────────────────────────────
-- Used by future user-scoped tables (qa_logs, etc.) for one-line RLS:
--   using (is_beta_user() and user_id = auth.uid())
--
-- security definer + search_path lock is required so the function can read
-- public.beta_invites despite the RLS policy above.
create or replace function public.is_beta_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.beta_invites
    where user_id = auth.uid()
      and used_at is not null
      and (expires_at is null or expires_at > now())
  );
$$;

-- anon role is granted defensively. Anonymous Supabase users carry the
-- `authenticated` role in their JWT, so `authenticated` is the load-bearing
-- grant; `anon` guards any future code path that calls this without a session.
grant execute on function public.is_beta_user() to anon, authenticated;

-- ── Operator workflow ────────────────────────────────────────────────────────
-- To mint an invite (run in the Supabase SQL Editor):
--
--   insert into beta_invites (code, display_name, default_lang)
--   values (
--     -- 96 bits of entropy, URL-safe (base64 with +/= → -_ stripped).
--     -- Postgres `encode()` has no native base64url, hence the replace chain.
--     replace(replace(replace(
--       encode(gen_random_bytes(12), 'base64'),
--       '+', '-'), '/', '_'), '=', ''),
--     'Wang Lei',
--     'zh'
--   )
--   returning code;
--
-- Copy the returned code, share: https://<host>/?invite=<code>
--
-- Verification:
--   select code, display_name, default_lang, used_at, user_id from beta_invites order by created_at desc;
