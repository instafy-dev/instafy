-- A person's runtime token for a new private self-hosted machine names a
-- runtime that has no `runtimes` row until its first registration. The mint
-- records it here, under the person's owner lock, so a membership change that
-- leaves the person unable to write the space can end it before it registers:
-- the change deletes the person's rows for that space, and a first
-- registration whose token carries a machine lifetime is refused without its
-- row. The first registration deletes the row it used. A row whose token has
-- expired is pruned by the controller's retention ticker. No token is stored.
set local lock_timeout = '5s';
create table public.runtime_pending_machine_mints (
  runtime_id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_user_id uuid not null,
  generation uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index runtime_pending_machine_mints_owner_project_idx
  on public.runtime_pending_machine_mints (owner_user_id, project_id);

alter table public.runtime_pending_machine_mints enable row level security;
revoke all on public.runtime_pending_machine_mints from anon, authenticated;
grant all on public.runtime_pending_machine_mints to service_role;
