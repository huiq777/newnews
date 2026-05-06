-- Per-user trend brief feedback.
-- Keyed on (user_id, anchor_date, step_days) — survives brief refreshes,
-- independent per user, no shared-row conflicts.

create table if not exists trend_brief_feedback (
  user_id     uuid not null references auth.users(id) on delete cascade,
  anchor_date date not null,
  step_days   int  not null,
  feedback    smallint not null check (feedback in (-1, 1)),
  feedback_at timestamptz not null default now(),
  primary key (user_id, anchor_date, step_days)
);

alter table trend_brief_feedback enable row level security;

drop policy if exists "users_read_own_brief_feedback" on trend_brief_feedback;
create policy "users_read_own_brief_feedback" on trend_brief_feedback
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "users_write_own_brief_feedback" on trend_brief_feedback;
create policy "users_write_own_brief_feedback" on trend_brief_feedback
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Verification:
--   select * from trend_brief_feedback limit 1;
--   -- As authenticated user — insert feedback:
--   insert into trend_brief_feedback (user_id, anchor_date, step_days, feedback)
--   values (auth.uid(), current_date, 1, 1);
--   -- As anon — must be blocked:
--   select * from trend_brief_feedback;  -- 0 rows (RLS filters)
