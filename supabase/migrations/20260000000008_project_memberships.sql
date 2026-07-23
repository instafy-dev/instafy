-- Project memberships (project-level access sharing).

create table if not exists project_memberships (
  project_id uuid references projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'builder' check (role in ('builder','viewer')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists project_memberships_user_idx on project_memberships(user_id);

drop trigger if exists set_project_memberships_updated_at on project_memberships;
create trigger set_project_memberships_updated_at
  before update on project_memberships
  for each row
  execute function set_timestamp();

-- Extend Supabase RLS helper to treat project memberships as access.
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

  -- Allow access while org membership is not enforced.
  if project_record.org_id is null then
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

  return exists (
    select 1
    from org_memberships m
    where m.org_id = project_record.org_id
      and m.user_id = requester
  );
end;
$$;

