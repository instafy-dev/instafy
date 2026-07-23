-- Make durable hosted-browser profiles a first-class project-owned resource.
-- The controller still removes a profile during the normal soft-delete path;
-- this foreign key covers hard project/org deletion and manual maintenance.

create table if not exists public.project_browser_profiles (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  scope text not null,
  version bigint not null default 0,
  nonce_b64 text not null,
  ciphertext_b64 text not null,
  bytes bigint not null default 0,
  updated_by_runtime uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A legacy controller may have created the table before the ownership foreign
-- key existed. Remove impossible orphan rows before adding the constraint.
delete from public.project_browser_profiles profile
where not exists (
  select 1 from public.projects project where project.id = profile.project_id
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_browser_profiles_project_id_fkey'
      and conrelid = 'public.project_browser_profiles'::regclass
  ) then
    alter table public.project_browser_profiles
      add constraint project_browser_profiles_project_id_fkey
      foreign key (project_id) references public.projects(id) on delete cascade;
  end if;
end $$;

create unique index if not exists project_browser_profiles_project_scope_uidx
  on public.project_browser_profiles (project_id, scope);

alter table public.project_browser_profiles enable row level security;
revoke all privileges on table public.project_browser_profiles from anon, authenticated;

comment on table public.project_browser_profiles is
  'AES-GCM encrypted shared hosted-browser profile state. Controller access only.';
