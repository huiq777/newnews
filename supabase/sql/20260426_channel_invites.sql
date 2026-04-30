-- 20260426 — channel_invites: redeploy-free invite-URL config for the
-- "How to Subscribe?" trend-brief modal.
--
-- Why a table instead of EXPO_PUBLIC_* / config.ts:
--   Feishu group invites typically expire (~7d on the free tier) and Slack
--   invites can be revoked. If invite URLs lived in the JS bundle, every
--   rotation would require a frontend rebuild — and for native, an app-store
--   review cycle. Storing them in a tiny DB table with anon-read RLS lets the
--   operator paste a new URL into the Supabase dashboard and have it live for
--   every user on next modal open.
--
-- Apply via Supabase SQL Editor. Idempotent (uses IF NOT EXISTS guards and
-- ON CONFLICT DO NOTHING for the seed).

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.channel_invites (
  channel       text primary key check (channel in ('feishu','slack','discord','telegram')),
  invite_url    text not null default '',                       -- empty = hidden in UI
  language      text not null check (language in ('en','zh')),
  display_label text,
  updated_at    timestamptz not null default now()
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- anon SELECT only. Writes go through service role / dashboard.
alter table public.channel_invites enable row level security;

drop policy if exists "anon_read_invites" on public.channel_invites;
create policy "anon_read_invites" on public.channel_invites
  for select to anon, authenticated using (true);

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- Operator fills invite_url via dashboard. Empty rows are simply hidden by the
-- modal — graceful degradation, no UI breakage.
insert into public.channel_invites (channel, language, display_label) values
  ('feishu',   'zh', null),
  ('slack',    'en', '#ai-trend-brief in News Project Slack'),
  ('discord',  'en', '#ai-trend-brief in News Project Discord'),
  ('telegram', 'en', null)
on conflict (channel) do nothing;

-- Verification:
--   select channel, language, display_label, invite_url from channel_invites;
-- Expected: 4 rows; all invite_url = ''.
