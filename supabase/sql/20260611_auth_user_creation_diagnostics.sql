-- 20260611_auth_user_creation_diagnostics.sql
-- Diagnose Supabase OAuth callback failures like:
--   error_code=unexpected_failure
--   error_description=Database error saving new user
--
-- Meaning: Supabase Auth reached the database, tried to create auth.users, and
-- a database trigger/function failed before the user row could be committed.
-- Run the diagnostic SELECTs first in Supabase SQL Editor, then apply the
-- remediation section that matches the trigger/function you find.

-- 1. List non-internal triggers attached to auth.users.
select
  t.tgname as trigger_name,
  n_fn.nspname as function_schema,
  p.proname as function_name,
  pg_get_triggerdef(t.oid) as trigger_definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n_tbl on n_tbl.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n_fn on n_fn.oid = p.pronamespace
where n_tbl.nspname = 'auth'
  and c.relname = 'users'
  and not t.tgisinternal
order by t.tgname;

-- 2. Show the trigger function body. Inspect this for inserts into tables such
-- as public.user_tokens, public.profiles, public.users, or NOT NULL email fields.
select
  n_fn.nspname as function_schema,
  p.proname as function_name,
  pg_get_functiondef(p.oid) as function_definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n_tbl on n_tbl.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n_fn on n_fn.oid = p.pronamespace
where n_tbl.nspname = 'auth'
  and c.relname = 'users'
  and not t.tgisinternal
order by n_fn.nspname, p.proname;

-- 3. Check whether the old project accounting table exists.
select to_regclass('public.user_tokens') as user_tokens_table;

-- 4. Check whether common profile tables exist.
select
  to_regclass('public.profiles') as profiles_table,
  to_regclass('public.users') as public_users_table;

-- 5. If the failing trigger is public.handle_new_user and it only grants an
-- initial user_tokens balance, replace it with this non-blocking version.
-- It intentionally never lets token/accounting bootstrap failure block
-- Supabase Auth user creation. This version avoids ON CONFLICT so it does not
-- require a unique constraint on user_tokens.user_id.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;

  if to_regclass('public.user_tokens') is not null then
    insert into public.user_tokens (user_id, balance)
    select new.id, 500
    where not exists (
      select 1
      from public.user_tokens
      where user_id = new.id
    );
  end if;

  return new;
exception
  when others then
    raise warning 'handle_new_user skipped for auth user %, sqlstate %, message %',
      new.id, sqlstate, sqlerrm;
    return new;
end;
$$;

-- 6. If the trigger inserts a profile row, use a version that tolerates missing
-- provider email. GitHub users may hide email, and some providers do not return
-- a verified email on first login.
--
-- create or replace function public.handle_new_user()
-- returns trigger
-- language plpgsql
-- security definer
-- set search_path = public
-- as $$
-- declare
--   v_email text := nullif(new.email, '');
--   v_name text :=
--     coalesce(
--       new.raw_user_meta_data->>'full_name',
--       new.raw_user_meta_data->>'name',
--       new.raw_user_meta_data->>'user_name',
--       v_email,
--       new.id::text
--     );
-- begin
--   if to_regclass('public.profiles') is not null then
--     insert into public.profiles (id, email, display_name)
--     values (new.id, v_email, v_name)
--     on conflict (id) do nothing;
--   end if;
--
--   return new;
-- exception
--   when others then
--     raise warning 'handle_new_user skipped for auth user %, sqlstate %, message %',
--       new.id, sqlstate, sqlerrm;
--     return new;
-- end;
-- $$;

-- 7. Emergency unblock only. Use this if the trigger is not needed for login
-- and you need OAuth signup restored before writing the correct bootstrap
-- function. Replace on_auth_user_created with the trigger name from step 1.
--
-- alter table auth.users disable trigger on_auth_user_created;
