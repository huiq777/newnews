-- 20260424 — digest_sent idempotency table + pg_cron pre-warm for generate-trend-brief
-- Apply via Supabase SQL Editor. Idempotent where reasonable (uses IF NOT EXISTS / DO NOTHING).
--
-- ── One-time prerequisites (run separately in SQL Editor before this file) ──
-- 1. Store the CRON_SECRET in Supabase Vault (encrypted at rest):
--
--      select vault.create_secret('<CRON_SECRET value>', 'cron_secret');
--
--    (If it already exists, rotate via:
--      select vault.update_secret(id, '<new value>')
--      from vault.decrypted_secrets where name = 'cron_secret';)
--
-- 2. Set the same value on the Edge Function side so generate-trend-brief
--    accepts it. Two options:
--      a) Dashboard → Project Settings → Edge Functions → Manage Secrets:
--         add CRON_SECRET = <value>
--      b) Local shell (NOT the SQL editor): `supabase secrets set CRON_SECRET=<value>`
--
-- Project ref is hardcoded below as `exjbwdcxyrkxsmzaowkx` (News Project prod).
-- It is not a secret — it already appears in the Expo frontend bundle.

-- ── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ── digest_sent: per-channel per-day delivery accounting ─────────────────────
create table if not exists digest_sent (
  id           uuid        primary key default gen_random_uuid(),
  channel      text        not null check (channel in ('feishu','slack','discord','telegram')),
  anchor_date  date        not null,
  status       text        not null check (status in ('pending','sent','failed','skipped_empty_brief')),
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (channel, anchor_date)
);

create index if not exists digest_sent_anchor_date_channel_idx
  on digest_sent (anchor_date desc, channel);

alter table digest_sent enable row level security;
-- No anon policy: anon blocked. Service role bypasses RLS for worker writes.

-- ── pg_cron: pre-warm trend brief at 00:25 UTC ────────────────────────────────
-- anchor_date = yesterday UTC: at 00:25 UTC, "today UTC" has only 25 minutes of
-- content. Anchoring on yesterday gives a full 24h window that just closed —
-- "morning brief of what happened yesterday".
-- Unschedule any prior version before (re)scheduling so this file is re-runnable.
select cron.unschedule(jobid)
  from cron.job
  where jobname = 'generate-trend-brief-daily';

select cron.schedule(
  'generate-trend-brief-daily',
  '25 0 * * *',
  $$
    select net.http_post(
      url := 'https://exjbwdcxyrkxsmzaowkx.supabase.co/functions/v1/generate-trend-brief?trigger=true&anchor_date=' || ((now() at time zone 'utc')::date - 1)::text || '&step_days=1',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
        'Content-Type', 'application/json'
      )
    );
  $$
);
