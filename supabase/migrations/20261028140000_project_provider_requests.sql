-- Provider requests: a tool call or resource read queued for the device a
-- provider is attached on, which claims it and completes it. Controllers
-- before this one created the table the first time a route used it, so a
-- table that already exists is kept and brought to this shape.
-- Controller-only: no client reads it.
--
-- Its own file because it holds ACCESS EXCLUSIVE on a table that may already
-- exist and that live requests now lock in both orders with agent_jobs
-- (MIGRATIONS.md), so it locks no other table. Its check goes in NOT VALID,
-- so existing rows are not scanned under that lock: the next migration
-- validates it, and the one after builds the indexes under SHARE alone.
set local lock_timeout = '5s';

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
-- the dispatch's wait. A row from before this migration reads as closed, so a
-- request still pending when it runs closes early; the constant default
-- rewrites no row. A row an older controller writes during a rollout closes
-- after the longest wait a dispatch can ask for. Two statements, so that only
-- existing rows take the constant.
alter table public.project_provider_requests
  add column expires_at timestamptz not null default 'epoch';
alter table public.project_provider_requests
  alter column expires_at set default (now() + interval '120 seconds');

-- target_device_id: only this device may claim the request. Null: any device
-- of the provider. job_id: the agent job the request belongs to; when the job
-- ends, its pending and claimed requests are canceled in the job's own
-- transaction. cancel_reason: steered when a person's new words were steered
-- into the request's job, which goes on without it. Null on any other cancel
-- and every other status.
alter table public.project_provider_requests
  add column target_device_id text,
  add column job_id uuid,
  add column cancel_reason text,
  add constraint project_provider_requests_cancel_reason_check
    check (cancel_reason = 'steered') not valid;

alter table public.project_provider_requests enable row level security;
revoke all privileges on table public.project_provider_requests from public, anon, authenticated;
