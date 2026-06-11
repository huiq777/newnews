-- 20260610 — OAuth public feed and premium analysis access policy.
--
-- Public daily feed stays readable. Premium generated analysis is returned only
-- to authenticated users through bounded RPCs and Edge Functions.

create table if not exists public.user_article_questions (
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references public.daily_news(id) on delete cascade,
  questions jsonb not null,
  model text,
  tokens_used integer,
  generated_at timestamptz not null default now(),
  primary key (user_id, article_id),
  constraint user_article_questions_shape check (
    jsonb_typeof(questions) = 'object'
    and jsonb_typeof(questions->'en') = 'array'
    and jsonb_typeof(questions->'zh') = 'array'
  )
);

create index if not exists user_article_questions_article_id_idx
  on public.user_article_questions(article_id);

alter table public.user_article_questions enable row level security;

drop policy if exists "users_read_own_article_questions" on public.user_article_questions;
drop policy if exists "users_write_own_article_questions" on public.user_article_questions;

revoke all on public.user_article_questions from anon, authenticated;
grant select, insert, update, delete on public.user_article_questions to service_role;

create table if not exists public.user_trend_briefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  anchor_date date not null,
  step_days integer not null,
  synthesis_en text,
  synthesis_zh text,
  sources_json jsonb not null default '[]'::jsonb,
  model text not null,
  tokens_used integer,
  generated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, anchor_date, step_days)
);

create index if not exists user_trend_briefs_lookup_idx
  on public.user_trend_briefs(user_id, anchor_date, step_days, expires_at);

alter table public.user_trend_briefs enable row level security;

drop policy if exists "users_read_own_trend_briefs" on public.user_trend_briefs;
drop policy if exists "users_write_own_trend_briefs" on public.user_trend_briefs;

revoke all on public.user_trend_briefs from anon, authenticated;
grant select, insert, update, delete on public.user_trend_briefs to service_role;

drop policy if exists "public_read_trend_briefs" on public.trend_briefs;
drop policy if exists "authenticated_read_trend_briefs" on public.trend_briefs;

revoke select on public.trend_briefs from anon, authenticated;
grant select, insert, update, delete on public.trend_briefs to service_role;

drop policy if exists "public_read_article_deep_analysis" on public.article_deep_analysis;
drop policy if exists "authenticated_read_article_deep_analysis" on public.article_deep_analysis;

revoke select on public.article_deep_analysis from anon, authenticated;
grant select, insert, update, delete on public.article_deep_analysis to service_role;

drop function if exists public.fetch_grouped_feed(date, date, text, int, uuid);

create or replace function public.fetch_grouped_feed(
  p_date_start date,
  p_date_end date,
  p_category text default null,
  p_limit int default 10,
  p_cursor uuid default null
)
returns table (
  id uuid,
  title_en text,
  title_zh text,
  summary_en text,
  summary_zh text,
  source_type text,
  source_id uuid,
  source_name text,
  source_category text,
  thread_group text,
  thread_bio text,
  url text,
  published_at timestamptz,
  created_at timestamptz,
  questions jsonb,
  questions_source text,
  engagement jsonb,
  metadata jsonb,
  deep_analysis_id uuid,
  deep_analysis_status text,
  deep_analysis jsonb,
  deep_analysis_feedback_up_count integer,
  deep_analysis_feedback_down_count integer,
  next_cursor uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with caller as (
    select
      auth.role() = 'authenticated' and auth.uid() is not null as can_view_premium,
      auth.uid() as user_id
  ),
  ranked as (
    select
      dn.id,
      coalesce(dn.title_en, dn.title) as title_en,
      coalesce(dn.title_zh, dn.title) as title_zh,
      coalesce(dn.summary_en, dn.summary) as summary_en,
      coalesce(dn.summary_zh, dn.summary) as summary_zh,
      s.source_type,
      dn.source_id,
      s.name as source_name,
      s.category as source_category,
      case when s.source_type in ('x_api', 'apify_tweet') then s.metadata->>'handle' else null end as thread_group,
      case
        when s.source_type in ('x_api', 'apify_tweet')
        then s.metadata->'bio_map'->>(s.metadata->>'handle')
        else null
      end as thread_bio,
      dn.url,
      dn.published_at,
      dn.created_at,
      case
        when (select can_view_premium from caller) then coalesce(uaq.questions, dn.questions)
        else null end as questions,
      case
        when not (select can_view_premium from caller) then null
        when uaq.article_id is not null then 'user_override'
        when dn.questions is not null then 'auto_default'
        else null
      end as questions_source,
      dn.engagement,
      jsonb_strip_nulls(jsonb_build_object(
        'source', case when s.source_type = 'aihot' then dn.metadata->>'source' else null end,
        'aihot_source', case when s.source_type = 'aihot' then dn.metadata->>'source' else null end,
        'aihot_id', case when s.source_type = 'aihot' then dn.metadata->>'aihot_id' else null end,
        'category', dn.metadata->>'category'
      )) as metadata,
      case when (select can_view_premium from caller) then ada.id else null end as deep_analysis_id,
      case when (select can_view_premium from caller) then ada.status else null end as deep_analysis_status,
      case
        when (select can_view_premium from caller) and ada.status = 'ready' then ada.analysis
        else null end as deep_analysis,
      case when (select can_view_premium from caller) then coalesce(ada.feedback_up_count, 0) else null end as deep_analysis_feedback_up_count,
      case when (select can_view_premium from caller) then coalesce(ada.feedback_down_count, 0) else null end as deep_analysis_feedback_down_count
    from public.daily_news dn
    join public.sources s on s.id = dn.source_id
    cross join caller
    left join public.user_article_questions uaq
      on uaq.article_id = dn.id
     and uaq.user_id = caller.user_id
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
    r.source_name,
    r.source_category,
    r.thread_group,
    r.thread_bio,
    r.url,
    r.published_at,
    r.created_at,
    r.questions,
    r.questions_source,
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

grant execute on function public.fetch_grouped_feed(date, date, text, int, uuid)
  to anon, authenticated;

create table if not exists public.edge_rate_limits (
  bucket text primary key,
  request_count integer not null default 0,
  reset_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.edge_rate_limits enable row level security;

revoke all on public.edge_rate_limits from anon;
revoke all on public.edge_rate_limits from authenticated;

create or replace function public.bump_edge_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_count integer;
  v_reset_at timestamptz;
begin
  insert into public.edge_rate_limits (bucket, request_count, reset_at)
  values (p_bucket, 1, v_now + make_interval(secs => p_window_seconds))
  on conflict (bucket) do update
    set request_count = case
          when public.edge_rate_limits.reset_at <= v_now then 1
          else public.edge_rate_limits.request_count + 1
        end,
        reset_at = case
          when public.edge_rate_limits.reset_at <= v_now then v_now + make_interval(secs => p_window_seconds)
          else public.edge_rate_limits.reset_at
        end,
        updated_at = v_now
  returning request_count, reset_at into v_count, v_reset_at;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.bump_edge_rate_limit(text, integer, integer) from public;
grant execute on function public.bump_edge_rate_limit(text, integer, integer) to service_role;
