-- Deleting a space only marks it (projects.status = 'deleted'): its rows stay,
-- and the controller answers 404 for it and leaves it out of every list. Direct
-- Supabase reads follow the same rule, so the space's owner, members and team
-- no longer read it, or its chats, runs, prompts, jobs and other rows, through
-- row-level security. The service-role branch is unchanged. Everything that
-- goes through has_project_access follows it: has_conversation_access, the
-- onboarding choice functions and the chat attachment policies. The author's
-- own read of a prompt outside any chat does not, and is fenced below.

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

  if project_record.status = 'deleted' then
    return false;
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

-- Space pictures get the same fence: nobody uploads to or removes from a
-- deleted space's folder. Team pictures are unchanged.
create or replace function public.can_manage_identity_image(object_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
  target_id uuid;
  kind text := split_part(object_name, '/', 1);
begin
  if requester is null or object_name !~ '^(orgs|spaces)/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$' then
    return false;
  end if;
  begin target_id := split_part(object_name, '/', 2)::uuid;
  exception when invalid_text_representation then return false; end;
  if kind = 'orgs' then
    return exists (select 1 from public.org_memberships
      where org_id = target_id and user_id = requester and role in ('owner', 'admin'));
  end if;
  return exists (select 1 from public.projects p where p.id = target_id and p.status <> 'deleted' and (
    p.owner_user_id = requester
    or exists (select 1 from public.project_memberships pm where pm.project_id = p.id
      and pm.user_id = requester and pm.role in ('owner', 'admin', 'builder'))
    or exists (select 1 from public.org_memberships om where om.org_id = p.org_id
      and om.user_id = requester and om.role in ('owner', 'admin', 'builder'))
  ));
end;
$$;

-- The author of a prompt outside any chat reads it without access to its
-- space, but not once the space is deleted. The projects policy hides a space
-- from an author outside it, so its status is read here, and only for one of
-- the caller's own prompts.
create or replace function public.can_read_own_prompt(target_prompt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from prompts pr
    left join projects p on p.id = pr.project_id
    where pr.id = target_prompt_id
      and pr.user_id = auth.uid()
      and (pr.project_id is null or p.status <> 'deleted')
  );
$$;

-- The policy statements lock prompts. Fail fast and retry rather than queue
-- every prompt read behind a long transaction.
set local lock_timeout = '5s';

drop policy if exists "prompts read" on public.prompts;
create policy "prompts read" on public.prompts
  for select using (
    auth.uid() is not null
    and (
      (
        conversation_id is null
        and (
          (project_id is not null and public.has_project_access(project_id))
          or (user_id = auth.uid() and public.can_read_own_prompt(id))
        )
      )
      or (
        conversation_id is not null
        and (project_id is null or public.has_project_access(project_id))
        and public.has_conversation_access(conversation_id)
      )
    )
  );
