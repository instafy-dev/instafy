-- Receipts for the AI-connection actions that make the controller call a third
-- party for a person: testing a saved connection (one request through the
-- model proxy to its provider) and starting a ChatGPT device login (a
-- user-code request to auth.openai.com and a poller that asks again about
-- every ten seconds for up to fifteen minutes). The controller counts them
-- under an advisory lock with the database clock, per person and, for device
-- logins, across everyone, so more controller instances or a restart cannot
-- widen an allowance (`ai_connection_limits` in the runtime controller). New
-- connections are counted from user_credentials.created_at instead.
--
-- A device login counts as pending while completed_at is null and expires_at
-- is in the future. completed_at is set when it completes, fails, is
-- cancelled or is replaced by a newer start of the same person's.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.ai_connection_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null
    check (action in ('credential_test', 'codex_device_auth')),
  -- credential_test: the connection tested. No foreign key, so a receipt
  -- outlives its connection and counting takes no lock on user_credentials.
  credential_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  -- codex_device_auth only: when its code expires, and when it ended.
  expires_at timestamptz,
  completed_at timestamptz,
  check (action <> 'codex_device_auth' or expires_at is not null)
);

-- A person's recent attempts of one kind.
create index ai_connection_attempts_user_action_created_idx
  on public.ai_connection_attempts (user_id, action, created_at);
-- Everyone's recent attempts of one kind, and the retention prune.
create index ai_connection_attempts_action_created_idx
  on public.ai_connection_attempts (action, created_at);
-- Device logins still pending.
create index ai_connection_attempts_pending_idx
  on public.ai_connection_attempts (action, expires_at)
  where completed_at is null;

alter table public.ai_connection_attempts enable row level security;
revoke all on public.ai_connection_attempts from public, anon, authenticated;
grant all on public.ai_connection_attempts to service_role;

comment on table public.ai_connection_attempts is
  'Controller-internal receipts for AI-connection tests and ChatGPT device-login starts, counted for per-person and global limits; service-role access only.';
