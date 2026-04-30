-- 20260429 — Delivery channels: add WeCom + Notion to channel_invites and
-- widen the CHECK constraint that gates the channel column.
--
-- Why no digest_sent change: digest_sent.channel is free-form text (no CHECK
-- constraint today). New channel values ('wecom', 'notion') flow through the
-- existing UNIQUE (channel, anchor_date) without a migration.
--
-- Apply via Supabase SQL Editor. Idempotent — safe to re-run.

-- ── channel_invites widening ─────────────────────────────────────────────────
-- The CHECK is inline at column level (see 20260426_channel_invites.sql),
-- so Postgres auto-named it `channel_invites_channel_check`. Drop with
-- IF EXISTS so this migration is safe even if the constraint name was
-- different at apply time.
alter table public.channel_invites
  drop constraint if exists channel_invites_channel_check;

alter table public.channel_invites
  add constraint channel_invites_channel_check
  check (channel in ('feishu','slack','discord','telegram','wecom','notion'));

-- Seed rows. Operator fills `invite_url` via the dashboard later — empty rows
-- are simply hidden from the SubscriptionManualModal rail (graceful degrade).
insert into public.channel_invites (channel, language, display_label) values
  ('wecom',  'zh', null),
  ('notion', 'en', 'AI Trend Briefs Notion archive')
on conflict (channel) do nothing;

-- Verification:
--   select channel, language, display_label, invite_url
--   from channel_invites order by channel;
-- Expected: 6 rows total (feishu, slack, discord, telegram, wecom, notion);
-- wecom + notion start with empty invite_url until operator fills them in.
