-- Store the first-run AI choice as an insert-only project preference.
-- A row is monotonic and idempotent, so concurrent devices cannot lose each
-- other's choices through an auth.user_metadata read/modify/write race.

set local lock_timeout = '5s';

create table if not exists public.user_project_ai_onboarding_choices (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  settled_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

create index if not exists user_project_ai_onboarding_choices_project_idx
  on public.user_project_ai_onboarding_choices(project_id);

alter table public.user_project_ai_onboarding_choices enable row level security;

drop policy if exists "user project AI onboarding choices service role"
  on public.user_project_ai_onboarding_choices;
create policy "user project AI onboarding choices service role"
  on public.user_project_ai_onboarding_choices
  for all
  using (public.current_request_role() = 'service_role')
  with check (public.current_request_role() = 'service_role');

-- Browser clients can only use the two access-checked functions below. They
-- cannot directly insert, rewrite, enumerate, or delete preference rows.
revoke all privileges on table public.user_project_ai_onboarding_choices
  from public, anon, authenticated;
grant all privileges on table public.user_project_ai_onboarding_choices
  to service_role;

create or replace function public.has_settled_getting_started_ai_choice(
  expected_user_id uuid,
  target_project_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
begin
  if requester is null or expected_user_id is null or requester <> expected_user_id then
    raise exception 'The authenticated user changed during onboarding preference access'
      using errcode = '42501';
  end if;

  if target_project_id is null
     or not public.has_project_access(target_project_id) then
    return false;
  end if;

  return exists (
    select 1
    from public.user_project_ai_onboarding_choices preference
    where preference.user_id = requester
      and preference.project_id = target_project_id
  );
end;
$$;

create or replace function public.settle_getting_started_ai_choice(
  expected_user_id uuid,
  target_project_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
begin
  if requester is null or expected_user_id is null or requester <> expected_user_id then
    raise exception 'The authenticated user changed during onboarding preference access'
      using errcode = '42501';
  end if;

  if target_project_id is null
     or not public.has_project_access(target_project_id) then
    raise exception 'Project access is required to settle the onboarding AI choice'
      using errcode = '42501';
  end if;

  insert into public.user_project_ai_onboarding_choices (user_id, project_id)
  values (requester, target_project_id)
  on conflict (user_id, project_id) do nothing;

  return true;
end;
$$;

revoke all on function public.has_settled_getting_started_ai_choice(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.settle_getting_started_ai_choice(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.has_settled_getting_started_ai_choice(uuid, uuid)
  to authenticated;
grant execute on function public.settle_getting_started_ai_choice(uuid, uuid)
  to authenticated;

comment on table public.user_project_ai_onboarding_choices is
  'Insert-only record that a user settled the initial AI choice for a project.';
comment on function public.has_settled_getting_started_ai_choice(uuid, uuid) is
  'Returns the signed-in user''s durable AI-choice state for an accessible project.';
comment on function public.settle_getting_started_ai_choice(uuid, uuid) is
  'Idempotently records the signed-in user''s first-run AI choice for an accessible project.';
