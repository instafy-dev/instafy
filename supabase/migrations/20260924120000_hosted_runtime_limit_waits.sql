-- Spaces whose hosted runtime launch was refused because their organization
-- had every hosted runtime slot in use. The controller retries the refused
-- launch for them in the background while agent work is queued there, so a
-- message sent behind the limit starts once a slot frees up instead of waiting
-- for the next user interaction. Controller-only: no client reads this table.
set local lock_timeout = '5s';

create table if not exists public.hosted_runtime_limit_waits (
  project_id uuid primary key references public.projects(id) on delete cascade,
  -- The refused ensure (provider, runtime, size, origin) replayed by the
  -- retry. Metadata is stored after the controller's managed-runtime request
  -- sanitizer, never raw client input.
  ensure_request jsonb not null default '{}'::jsonb,
  -- A user's own ensure outranks a server-initiated one (dispatch reconnect,
  -- requeue), which does not carry the user's size choice.
  request_source text not null default 'server'
    check (request_source in ('user', 'server')),
  first_refused_at timestamptz not null default now(),
  last_refused_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  -- Cross-replica single flight: a controller claims a row before retrying it
  -- and clears the claim when the attempt finishes. An abandoned claim expires.
  claimed_until timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hosted_runtime_limit_waits_next_attempt_idx
  on public.hosted_runtime_limit_waits (next_attempt_at);

alter table public.hosted_runtime_limit_waits enable row level security;
revoke all privileges on table public.hosted_runtime_limit_waits from public, anon, authenticated;
