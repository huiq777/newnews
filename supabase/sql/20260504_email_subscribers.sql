-- supabase/sql/20260504_email_subscribers.sql
create table email_subscribers (
  id              uuid        primary key default gen_random_uuid(),
  email           text        not null unique,
  lang            text        not null default 'en' check (lang in ('en', 'zh')),
  created_at      timestamptz not null default now(),
  unsubscribed_at timestamptz
);

alter table email_subscribers enable row level security;
create policy "anon can subscribe"
  on email_subscribers for insert to anon, authenticated
  with check (true);

create table email_digest_sent (
  id            uuid        primary key default gen_random_uuid(),
  subscriber_id uuid        not null references email_subscribers(id) on delete cascade,
  anchor_date   date        not null,
  step_days     integer     not null default 1,
  status        text        not null check (status in ('pending','sent','failed','skipped_empty_brief')),
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (subscriber_id, anchor_date, step_days)
);

create index email_digest_sent_anchor_idx on email_digest_sent (anchor_date desc, subscriber_id);
