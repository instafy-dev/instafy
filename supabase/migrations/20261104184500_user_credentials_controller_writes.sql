set local lock_timeout = '5s';

-- Only the controller writes credential rows, through its own connection
-- (create, rename, set default, revoke). The "user credentials self" policy
-- allowed every operation to the signed-in owner, so a browser session could
-- change a row behind the controller's back: its metadata (the provider and
-- endpoint a lease names), its revocation, or the row itself while a job was
-- queued on it. No client writes this table. Owners keep reading their own
-- rows; every write from the browser roles is refused.
revoke insert, update, delete, truncate on public.user_credentials from anon, authenticated;

drop policy if exists "user credentials self" on public.user_credentials;
create policy "user credentials self" on public.user_credentials
  for select using (auth.uid() = user_id);
