drop policy if exists "users_update_own_feedback" on public.qa_logs;
create policy "users_update_own_feedback" on public.qa_logs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
