-- Provider requests and provider device presence. Controllers before this one
-- created both tables the first time a route used them, so a table that
-- already exists is kept and brought to this shape. Controller-only: no client
-- reads either table.
set local lock_timeout = '5s';

-- A tool call or resource read queued for the device a provider is attached
-- on, which claims it and completes it.
create table if not exists public.project_provider_requests (
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

-- No device may claim a request after expires_at. The controller sets it from
-- the dispatch's wait. A row written without one, before this migration or by
-- an older controller during a rollout, closes after the longest wait a
-- dispatch can ask for.
alter table public.project_provider_requests
  add column if not exists expires_at timestamptz;
update public.project_provider_requests
   set expires_at = created_at + interval '120 seconds'
 where expires_at is null;
alter table public.project_provider_requests
  alter column expires_at set default (now() + interval '120 seconds'),
  alter column expires_at set not null;

create index if not exists project_provider_requests_lookup_idx
  on public.project_provider_requests (project_id, provider_id, status, created_at);
create index if not exists project_provider_requests_project_idx
  on public.project_provider_requests (project_id, created_at desc);

alter table public.project_provider_requests enable row level security;
revoke all privileges on table public.project_provider_requests from public, anon, authenticated;

-- A device's presence for a provider in a space, from its heartbeats.
create table if not exists public.project_provider_devices (
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
  on public.project_provider_devices (project_id, provider_family_id, last_seen_at desc);

alter table public.project_provider_devices enable row level security;
revoke all privileges on table public.project_provider_devices from public, anon, authenticated;
