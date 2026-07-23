-- Move project integration storage out of request-time DDL and add the
-- non-secret preparation checkpoint used to recover a completed origin apply
-- without asking GitHub for the private repository again.

create table if not exists project_integrations (
    id uuid primary key,
    project_id uuid not null,
    provider text not null,
    status text not null,
    connection_type text not null,
    credential_id uuid,
    metadata jsonb not null default '{}'::jsonb,
    required_scopes jsonb not null default '[]'::jsonb,
    capabilities jsonb not null default '[]'::jsonb,
    created_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project_id, provider)
);

-- Compatibility for controller-created tables from older releases.
alter table project_integrations
    add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table project_integrations
    add column if not exists required_scopes jsonb not null default '[]'::jsonb;
alter table project_integrations
    add column if not exists capabilities jsonb not null default '[]'::jsonb;
alter table project_integrations add column if not exists created_by uuid;
alter table project_integrations
    add column if not exists created_at timestamptz not null default now();
alter table project_integrations
    add column if not exists updated_at timestamptz not null default now();

create unique index if not exists project_integrations_project_provider_uidx
    on project_integrations(project_id, provider);
create index if not exists project_integrations_project_idx
    on project_integrations(project_id, provider);

alter table project_integrations enable row level security;
revoke all privileges on table project_integrations from anon, authenticated;

comment on table project_integrations is
    'Controller-owned per-project integration connection state; service-role access only.';

alter table github_import_operations
    add column if not exists prepared_json jsonb;

comment on column github_import_operations.prepared_json is
    'Non-secret origin/auth-mode checkpoint used for crash-safe receipt recovery.';
