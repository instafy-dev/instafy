-- Bound GitHub device-code starts across controller nodes and make process-
-- local poller ownership explicit. GitHub's device_code is intentionally not
-- persisted, so a pending session whose poller lease expires cannot recover
-- after node loss and must fail closed with an actionable retry.

alter table public.github_device_auth_sessions
  add column if not exists poll_owner_id uuid;
alter table public.github_device_auth_sessions
  add column if not exists poll_lease_expires_at timestamptz;

-- During a rolling deploy, an older controller can still own an in-memory
-- poller but cannot renew the new lease. Give legacy rows a compatibility
-- lease through the provider's existing expiry. New-controller rows supply a
-- shorter renewable lease explicitly and are therefore reaped much sooner
-- after node loss.
update public.github_device_auth_sessions
set poll_owner_id = coalesce(poll_owner_id, session_id),
    poll_lease_expires_at = coalesce(poll_lease_expires_at, device_expires_at),
    updated_at = now()
where status = 'pending';

create or replace function public.set_github_device_auth_legacy_poller_lease()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'pending' then
    new.poll_owner_id := coalesce(new.poll_owner_id, new.session_id);
    new.poll_lease_expires_at := coalesce(
      new.poll_lease_expires_at,
      new.device_expires_at
    );
  end if;
  return new;
end;
$$;

drop trigger if exists set_github_device_auth_legacy_poller_lease
  on public.github_device_auth_sessions;
create trigger set_github_device_auth_legacy_poller_lease
  before insert on public.github_device_auth_sessions
  for each row execute function public.set_github_device_auth_legacy_poller_lease();
revoke all on function public.set_github_device_auth_legacy_poller_lease()
  from public, anon, authenticated;

alter table public.github_device_auth_sessions
  drop constraint if exists github_device_auth_sessions_pending_poller_check;
alter table public.github_device_auth_sessions
  add constraint github_device_auth_sessions_pending_poller_check
  check (
    status <> 'pending'
    or (poll_owner_id is not null and poll_lease_expires_at is not null)
  ) not valid;
alter table public.github_device_auth_sessions
  validate constraint github_device_auth_sessions_pending_poller_check;

create index if not exists github_device_auth_sessions_pending_user_lease_idx
  on public.github_device_auth_sessions (user_id, poll_lease_expires_at)
  where status = 'pending';

create table if not exists public.github_device_auth_start_attempts (
  attempt_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  reservation_expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (reservation_expires_at >= created_at)
);

create index if not exists github_device_auth_start_attempts_user_created_idx
  on public.github_device_auth_start_attempts (user_id, created_at desc);
create index if not exists github_device_auth_start_attempts_active_idx
  on public.github_device_auth_start_attempts (reservation_expires_at)
  where completed_at is null;
create index if not exists github_device_auth_start_attempts_retention_idx
  on public.github_device_auth_start_attempts (created_at);

alter table public.github_device_auth_start_attempts enable row level security;
revoke all privileges on table public.github_device_auth_start_attempts from anon, authenticated;

comment on table public.github_device_auth_start_attempts is
  'Short-lived controller-internal reservations and rate-limit receipts for GitHub device-code starts; service-role access only.';
comment on column public.github_device_auth_sessions.poll_lease_expires_at is
  'Lease for the process-local GitHub token poller; an expired lease makes a pending session unrecoverable and safe to fail.';
comment on function public.set_github_device_auth_legacy_poller_lease() is
  'Rolling-deploy compatibility for pre-lease controllers; remove only after every deployed controller writes explicit GitHub poll leases.';
