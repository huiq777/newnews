-- Extend digest_sent to track delivery per (channel, anchor_date, step_days).
-- DEFAULT 1 backfills existing rows correctly.

alter table digest_sent add column if not exists step_days integer not null default 1;

-- Replace unique constraint to include step_days
alter table digest_sent drop constraint if exists digest_sent_channel_anchor_date_key;
alter table digest_sent add constraint digest_sent_channel_anchor_date_step_days_key
  unique (channel, anchor_date, step_days);

-- Replace index
drop index if exists digest_sent_anchor_date_channel_idx;
create index digest_sent_anchor_date_channel_step_days_idx
  on digest_sent (anchor_date desc, channel, step_days);

-- ── pg_cron pre-warm jobs ─────────────────────────────────────────────────────

-- Weekly pre-warm: every Monday at 00:20 UTC (10 min before send-digest fires at 00:30)
-- anchor_date = Sunday (today UTC - 1); step_days = 7 → Mon–Sun window
select cron.unschedule(jobid)
  from cron.job where jobname = 'generate-trend-brief-weekly';

select cron.schedule(
  'generate-trend-brief-weekly',
  '20 0 * * 1',
  $$
    select net.http_post(
      url := 'https://exjbwdcxyrkxsmzaowkx.supabase.co/functions/v1/generate-trend-brief'
             || '?trigger=true'
             || '&anchor_date=' || ((now() at time zone 'utc')::date - 1)::text
             || '&step_days=7',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
        'Content-Type', 'application/json'
      )
    );
  $$
);

-- Monthly pre-warm: 1st of each month at 00:15 UTC (15 min before send-digest)
-- anchor_date = last day of prev month; step_days = 30
select cron.unschedule(jobid)
  from cron.job where jobname = 'generate-trend-brief-monthly';

select cron.schedule(
  'generate-trend-brief-monthly',
  '15 0 1 * *',
  $$
    select net.http_post(
      url := 'https://exjbwdcxyrkxsmzaowkx.supabase.co/functions/v1/generate-trend-brief'
             || '?trigger=true'
             || '&anchor_date=' || ((now() at time zone 'utc')::date - 1)::text
             || '&step_days=30',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
        'Content-Type', 'application/json'
      )
    );
  $$
);
