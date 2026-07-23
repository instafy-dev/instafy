-- Finish the ownership and maintenance contract for the controller-owned
-- GitHub import tables. The foreign keys are installed NOT VALID first so
-- concurrent writes are protected before legacy orphan cleanup begins.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_oauth_tokens_user_id_fkey'
      and conrelid = 'public.user_oauth_tokens'::regclass
  ) then
    alter table public.user_oauth_tokens
      add constraint user_oauth_tokens_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade
      not valid;
  end if;
end $$;

-- OAuth rows cannot be used once their owning auth user is gone. Delete only
-- those true legacy orphans before validating the ownership constraint.
delete from public.user_oauth_tokens token
where not exists (
  select 1
  from auth.users owner
  where owner.id = token.user_id
);

alter table public.user_oauth_tokens
  validate constraint user_oauth_tokens_user_id_fkey;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_integrations_project_id_fkey'
      and conrelid = 'public.project_integrations'::regclass
  ) then
    alter table public.project_integrations
      add constraint project_integrations_project_id_fkey
      foreign key (project_id) references public.projects(id) on delete cascade
      not valid;
  end if;
end $$;

-- Integration metadata has no meaning without its project. As above, remove
-- only rows whose referenced parent is demonstrably absent.
delete from public.project_integrations integration
where not exists (
  select 1
  from public.projects project
  where project.id = integration.project_id
);

alter table public.project_integrations
  validate constraint project_integrations_project_id_fkey;

-- Migrations 53 and 54 created compatibility indexes in addition to the
-- tables' primary/unique constraint indexes. Keep the constraint-backed
-- indexes as the single source of uniqueness and remove identical copies.
drop index if exists public.user_oauth_tokens_user_provider_uidx;
drop index if exists public.project_integrations_project_provider_uidx;
drop index if exists public.project_integrations_project_idx;

-- Accelerate the controller's project-scoped active-operation check without
-- making completed receipts compete for index space.
create index if not exists github_import_operations_active_claim_idx
  on public.github_import_operations (project_id, claim_expires_at)
  include (idempotency_key)
  where status in ('pending', 'applied');

-- Support a future bounded terminal-receipt pruner. This migration does not
-- delete import operations: pending/applied rows must never be age-pruned, and
-- succeeded/failed receipts remain replayable for at least 30 days after
-- completed_at (currently they are retained indefinitely).
create index if not exists github_import_operations_terminal_retention_idx
  on public.github_import_operations (completed_at, id)
  where status in ('succeeded', 'failed') and completed_at is not null;

comment on index public.github_import_operations_active_claim_idx is
  'Project-scoped lookup for live GitHub import claims; excludes terminal receipts.';

comment on index public.github_import_operations_terminal_retention_idx is
  'Supports bounded pruning of terminal GitHub import receipts after the supported 30-day replay window; no automatic pruning is currently enabled.';
