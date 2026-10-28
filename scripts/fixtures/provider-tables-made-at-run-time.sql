-- The two provider tables as controllers before 20261028140000 made them at
-- run time, the first time a route used them: the DDL of
-- ensure_provider_request_tables and ensure_provider_device_tables, verbatim.
-- scripts/test-supabase-migrations-empty-db.mjs runs it before that migration,
-- so the migrations meet the tables as production has them.

create table if not exists project_provider_requests (
  id uuid primary key,
  project_id uuid not null,
  provider_id text not null,
  request_kind text not null,
  tool_name text,
  resource_uri text,
  arguments jsonb not null default '{}'::jsonb,
  status text not null,
  requested_by uuid,
  claimed_by_device_id text,
  claimed_by_device_label text,
  response jsonb,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists project_provider_requests_lookup_idx
  on project_provider_requests (project_id, provider_id, status, created_at);

create index if not exists project_provider_requests_project_idx
  on project_provider_requests (project_id, created_at desc);

alter table project_provider_requests enable row level security;
revoke all privileges on table project_provider_requests from anon, authenticated;

create table if not exists project_provider_devices (
  project_id uuid not null,
  provider_id text not null,
  provider_family_id text not null,
  device_id text not null,
  device_label text,
  platform text,
  status text not null default 'ready',
  connection_type text not null default 'native_runtime',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (project_id, provider_id, device_id)
);

create index if not exists project_provider_devices_project_idx
  on project_provider_devices (project_id, provider_family_id, last_seen_at desc);

alter table project_provider_devices enable row level security;
revoke all privileges on table project_provider_devices from anon, authenticated;
