-- 20260529 — Deep Analysis v1
-- Derived long-form article analysis generated after daily_news insert.
-- Applies idempotently via SQL Editor.

create extension if not exists vector;
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.article_deep_analysis (
  id                          uuid primary key default gen_random_uuid(),
  article_id                  uuid unique not null references public.daily_news(id) on delete cascade,
  status                      text not null check (status in ('pending', 'processing', 'ready', 'error', 'ineligible')),
  analysis                    jsonb,
  analysis_embedding          vector(1024),
  model                       text,
  prompt_version              text not null,
  tokens_used                 integer,
  retry_count                 integer not null default 0,
  last_error                  text,
  input_chars                 integer,
  truncated                   boolean not null default false,
  feedback_up_count           integer not null default 0,
  feedback_down_count         integer not null default 0,
  generated_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists article_deep_analysis_article_id_idx
  on public.article_deep_analysis(article_id);

create index if not exists article_deep_analysis_pending_idx
  on public.article_deep_analysis(status, retry_count, created_at)
  where status in ('pending', 'error');

create index if not exists article_deep_analysis_ready_idx
  on public.article_deep_analysis(status, generated_at desc)
  where status = 'ready';

create index if not exists article_deep_analysis_embedding_hnsw_idx
  on public.article_deep_analysis
  using hnsw (analysis_embedding vector_cosine_ops)
  where status = 'ready' and analysis_embedding is not null;

insert into public.article_deep_analysis (
  article_id,
  status,
  prompt_version,
  input_chars
)
select
  dn.id,
  case
    when length(coalesce(dn.article_content, '')) > 500 then 'pending'
    else 'ineligible'
  end,
  'deep-analysis-v2-2026-05-29',
  length(coalesce(dn.article_content, ''))
from public.daily_news dn
where not exists (
  select 1
  from public.article_deep_analysis ada
  where ada.article_id = dn.id
);

create table if not exists public.article_deep_analysis_feedback (
  user_id       uuid not null references auth.users(id) on delete cascade,
  analysis_id   uuid not null references public.article_deep_analysis(id) on delete cascade,
  article_id    uuid not null references public.daily_news(id) on delete cascade,
  article_title text not null,
  feedback      smallint not null check (feedback in (-1, 1)),
  feedback_at   timestamptz not null default now(),
  primary key (user_id, analysis_id)
);

create index if not exists article_deep_analysis_feedback_article_id_idx
  on public.article_deep_analysis_feedback(article_id);

alter table public.article_deep_analysis enable row level security;
alter table public.article_deep_analysis_feedback enable row level security;

drop policy if exists "public_read_article_deep_analysis" on public.article_deep_analysis;
create policy "public_read_article_deep_analysis" on public.article_deep_analysis
  for select using (true);

drop policy if exists "users_read_own_deep_analysis_feedback" on public.article_deep_analysis_feedback;
create policy "users_read_own_deep_analysis_feedback" on public.article_deep_analysis_feedback
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "users_write_own_deep_analysis_feedback" on public.article_deep_analysis_feedback;
create policy "users_write_own_deep_analysis_feedback" on public.article_deep_analysis_feedback
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke insert, update, delete on public.article_deep_analysis from anon, authenticated;
grant select on public.article_deep_analysis to anon, authenticated;
grant select, insert, update, delete on public.article_deep_analysis_feedback to authenticated;
revoke all on public.article_deep_analysis_feedback from anon;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists article_deep_analysis_set_updated_at on public.article_deep_analysis;
create trigger article_deep_analysis_set_updated_at
  before update on public.article_deep_analysis
  for each row execute function public.set_updated_at();

create or replace function public.refresh_deep_analysis_feedback_counts()
returns trigger
language plpgsql
security definer
as $$
declare
  target_analysis_id uuid;
begin
  target_analysis_id := coalesce(new.analysis_id, old.analysis_id);

  update public.article_deep_analysis ada
  set
    feedback_up_count = (
      select count(*)::int
      from public.article_deep_analysis_feedback f
      where f.analysis_id = target_analysis_id and f.feedback = 1
    ),
    feedback_down_count = (
      select count(*)::int
      from public.article_deep_analysis_feedback f
      where f.analysis_id = target_analysis_id and f.feedback = -1
    )
  where ada.id = target_analysis_id;

  return coalesce(new, old);
end;
$$;

drop trigger if exists article_deep_analysis_feedback_counts_ins on public.article_deep_analysis_feedback;
create trigger article_deep_analysis_feedback_counts_ins
  after insert on public.article_deep_analysis_feedback
  for each row execute function public.refresh_deep_analysis_feedback_counts();

drop trigger if exists article_deep_analysis_feedback_counts_upd on public.article_deep_analysis_feedback;
create trigger article_deep_analysis_feedback_counts_upd
  after update on public.article_deep_analysis_feedback
  for each row execute function public.refresh_deep_analysis_feedback_counts();

drop trigger if exists article_deep_analysis_feedback_counts_del on public.article_deep_analysis_feedback;
create trigger article_deep_analysis_feedback_counts_del
  after delete on public.article_deep_analysis_feedback
  for each row execute function public.refresh_deep_analysis_feedback_counts();

create or replace function public.claim_deep_analysis_batch(batch_size int default 2)
returns table (
  analysis_id      uuid,
  article_id       uuid,
  title            text,
  title_en         text,
  title_zh         text,
  summary_en       text,
  summary_zh       text,
  article_content  text,
  source_name      text,
  source_type      text,
  category         text,
  published_at     timestamptz,
  retry_count      integer
)
language plpgsql
security definer
as $$
begin
  if auth.role() != 'service_role' then
    raise exception 'Unauthorized: service_role required';
  end if;

  return query
  with claimed as (
    update public.article_deep_analysis ada
    set status = 'processing',
        last_error = null
    where ada.id in (
      select ada2.id
      from public.article_deep_analysis ada2
      join public.daily_news dn2 on dn2.id = ada2.article_id
      where ada2.status in ('pending', 'error')
        and ada2.retry_count < 3
        and dn2.article_content is not null
        and length(dn2.article_content) > 500
      order by ada2.created_at asc
      limit batch_size
      for update skip locked
    )
    returning ada.*
  )
  select
    c.id as analysis_id,
    dn.id as article_id,
    dn.title,
    dn.title_en,
    dn.title_zh,
    dn.summary_en,
    dn.summary_zh,
    dn.article_content,
    s.name as source_name,
    s.source_type,
    dn.category,
    dn.published_at,
    c.retry_count
  from claimed c
  join public.daily_news dn on dn.id = c.article_id
  join public.sources s on s.id = dn.source_id;
end;
$$;

revoke all on function public.claim_deep_analysis_batch(int) from public;
grant execute on function public.claim_deep_analysis_batch(int) to service_role;

create or replace function public.match_articles_prefer_analysis(
  query_embedding vector(1024),
  match_count     int default 5
)
returns table (
  id               uuid,
  title            text,
  summary          text,
  published_at     timestamptz,
  score            float,
  embedding_source text
)
language sql
stable
as $$
  with analysis_hits as (
    select
      dn.id,
      dn.title,
      dn.summary,
      dn.published_at,
      ada.analysis_embedding <=> query_embedding as dist,
      'deep_analysis'::text as embedding_source
    from public.article_deep_analysis ada
    join public.daily_news dn on dn.id = ada.article_id
    where ada.status = 'ready'
      and ada.analysis_embedding is not null
    order by ada.analysis_embedding <=> query_embedding
    limit match_count
  ),
  daily_hits as (
    select
      dn.id,
      dn.title,
      dn.summary,
      dn.published_at,
      dn.embedding <=> query_embedding as dist,
      'daily_news'::text as embedding_source
    from public.daily_news dn
    where dn.embedding is not null
      and not exists (
        select 1
        from public.article_deep_analysis ada
        where ada.article_id = dn.id
          and ada.status = 'ready'
          and ada.analysis_embedding is not null
      )
    order by dn.embedding <=> query_embedding
    limit match_count
  ),
  combined as (
    select * from analysis_hits
    union all
    select * from daily_hits
  )
  select
    combined.id,
    combined.title,
    combined.summary,
    combined.published_at,
    1 - combined.dist as score,
    combined.embedding_source
  from combined
  order by combined.dist
  limit match_count;
$$;

grant execute on function public.match_articles_prefer_analysis(vector, int) to anon, authenticated, service_role;

drop function if exists public.fetch_grouped_feed(date, date, text, int, uuid);
create or replace function public.fetch_grouped_feed(
  p_date_start  date,
  p_date_end    date,
  p_category    text    default null,
  p_limit       int     default 10,
  p_cursor      uuid    default null
)
returns table (
  id                                  uuid,
  title_en                            text,
  title_zh                            text,
  summary_en                          text,
  summary_zh                          text,
  source_type                         text,
  source_id                           uuid,
  thread_group                        text,
  url                                 text,
  published_at                        timestamptz,
  created_at                          timestamptz,
  questions                           jsonb,
  engagement                          jsonb,
  metadata                            jsonb,
  deep_analysis_id                    uuid,
  deep_analysis_status                text,
  deep_analysis                       jsonb,
  deep_analysis_feedback_up_count     integer,
  deep_analysis_feedback_down_count   integer,
  next_cursor                         uuid
)
language sql
stable
security definer
as $$
  with ranked as (
    select
      dn.id,
      coalesce(dn.title_en,   dn.title)   as title_en,
      coalesce(dn.title_zh,   dn.title)   as title_zh,
      coalesce(dn.summary_en, dn.summary) as summary_en,
      coalesce(dn.summary_zh, dn.summary) as summary_zh,
      s.source_type,
      dn.source_id,
      case when s.source_type in ('x_api', 'apify_tweet') then s.metadata->>'handle' else null end as thread_group,
      dn.url,
      dn.published_at,
      dn.created_at,
      dn.questions,
      dn.engagement,
      dn.metadata,
      ada.id as deep_analysis_id,
      ada.status as deep_analysis_status,
      case when ada.status = 'ready' then ada.analysis else null end as deep_analysis,
      coalesce(ada.feedback_up_count, 0) as deep_analysis_feedback_up_count,
      coalesce(ada.feedback_down_count, 0) as deep_analysis_feedback_down_count
    from public.daily_news dn
    join public.sources s on s.id = dn.source_id
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
    r.thread_group,
    r.url,
    r.published_at,
    r.created_at,
    r.questions,
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

grant execute on function public.fetch_grouped_feed(date, date, text, int, uuid) to anon, authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'generate-deep-analysis';

select cron.schedule(
  'generate-deep-analysis',
  '2-59/5 * * * *',
  $$
    select net.http_post(
      url := 'https://exjbwdcxyrkxsmzaowkx.supabase.co/functions/v1/generate-deep-analysis',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $$
);
