-- Durable, project-scoped idempotency for GitHub workspace imports.
-- Credentials never enter this table; it stores only the canonical request
-- identity, short-lived claim ownership, and the replayable success response.

create table if not exists github_import_operations (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    idempotency_key text not null,
    repo text not null,
    git_ref text not null,
    target_path text,
    status text not null check (status in ('pending', 'applied', 'succeeded', 'failed')),
    claim_id uuid not null,
    source_revision text,
    applied_json jsonb,
    response_json jsonb,
    error_message text,
    created_by uuid,
    claim_expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (project_id, idempotency_key)
);

-- Safe for an environment where request-time compatibility DDL created the
-- first version of the table before this migration was applied.
alter table github_import_operations
    add column if not exists source_revision text;
alter table github_import_operations
    add column if not exists applied_json jsonb;
alter table github_import_operations
    drop constraint if exists github_import_operations_status_check;
alter table github_import_operations
    add constraint github_import_operations_status_check
    check (status in ('pending', 'applied', 'succeeded', 'failed')) not valid;
alter table github_import_operations
    validate constraint github_import_operations_status_check;

create index if not exists github_import_operations_project_created_idx
    on github_import_operations(project_id, created_at desc);

alter table github_import_operations enable row level security;
revoke all privileges on table github_import_operations from anon, authenticated;

comment on table github_import_operations is
    'Internal controller receipts and atomic claims for GitHub imports; service-role access only.';
