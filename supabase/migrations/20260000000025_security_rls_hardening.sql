-- Security hardening: tighten project access + lock down push-token tables.
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

-- Ensure project access checks never fall back to "allow all" for org-less projects.
create or replace function public.has_project_access(target_project_id uuid)
returns boolean
language plpgsql
stable
security definer
as $$
declare
  requester uuid := auth.uid();
  requester_role text := public.current_request_role();
  project_record projects%ROWTYPE;
begin
  if target_project_id is null then
    return false;
  end if;

  select * into project_record
  from projects
  where id = target_project_id;

  if project_record.id is null then
    return false;
  end if;

  if requester_role = 'service_role' then
    return true;
  end if;

  if requester is null then
    return false;
  end if;

  if project_record.owner_user_id = requester then
    return true;
  end if;

  if exists (
    select 1
    from project_memberships pm
    where pm.project_id = project_record.id
      and pm.user_id = requester
  ) then
    return true;
  end if;

  if project_record.org_id is null then
    return false;
  end if;

  return exists (
    select 1
    from org_memberships m
    where m.org_id = project_record.org_id
      and m.user_id = requester
  );
end;
$$;

-- Avoid anon reads via helper fallbacks (belt + suspenders).
drop policy if exists "org credit ledger read" on org_credit_ledger;
create policy "org credit ledger read" on org_credit_ledger
  for select using (
    auth.uid() is not null
    and (
      public.has_org_access(org_id)
      or (project_id is not null and public.has_project_access(project_id))
    )
  );

-- Push notification endpoints should only be accessible to the owning user or service role.
alter table if exists web_push_subscriptions enable row level security;

drop policy if exists "web push subscriptions service role" on web_push_subscriptions;
create policy "web push subscriptions service role" on web_push_subscriptions
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "web push subscriptions self" on web_push_subscriptions;
create policy "web push subscriptions self" on web_push_subscriptions
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table if exists native_push_tokens enable row level security;

drop policy if exists "native push tokens service role" on native_push_tokens;
create policy "native push tokens service role" on native_push_tokens
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "native push tokens self" on native_push_tokens;
create policy "native push tokens self" on native_push_tokens
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

