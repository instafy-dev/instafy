-- A person's computers (docs/Local-Engine-Turns.md 11.23, D54): each computer
-- where Instafy Desktop runs signed in as them, so their Claude Code turns can
-- reach it from any client. A row is that computer's presence and what it can
-- do, as its Desktop reports it with the person's own session and the
-- controller checks it. It never makes a runtime eligible to lease a turn:
-- the lease clause reads the runtime's attested capability alone.
--
-- device_key: Desktop's own id for the computer, `desktop-<uuid>`.
-- label: what Studio shows, trimmed, 1 to 60 characters; Desktop's report
-- names a new row and the person may rename it.
-- logins: ids of the person's claude_code_logins that are set up and ready on
-- this computer, never a folder, path, account or sign-in.
-- runtime_id, project_id: the runtime Desktop runs now and its space, kept
-- only for a private runtime attested to the person.
-- claimed_project_id, claimed_until: a space this computer is starting, so the
-- person's other computers leave it alone.
-- decisions: at most 20 {projectId, reason}, why this computer did or did not
-- start a space where a turn waits, from a fixed list.
-- failed_project_id, failed_until: a space whose start failed here, left alone
-- until then.
-- status: 'paused' is the person's own stop, from any client.
-- Online means last_seen_at within 45 s and no offline_at since.
--
-- Controller only: RLS is on, only the service role has a policy, and neither
-- browser role holds a privilege. The new table references only auth.users.
set local lock_timeout = '5s';

create table public.user_computers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_key text not null,
  label text not null,
  platform text not null,
  desktop_version text,
  starts_spaces boolean not null default false,
  logins uuid[] not null default '{}',
  runtime_id uuid,
  project_id uuid,
  claimed_project_id uuid,
  claimed_until timestamptz,
  decisions jsonb not null default '[]'::jsonb,
  failed_project_id uuid,
  failed_until timestamptz,
  status text not null default 'available',
  last_seen_at timestamptz not null default now(),
  offline_at timestamptz,
  offline_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_key),
  check (char_length(device_key) between 1 and 80),
  check (label = btrim(label) and char_length(label) between 1 and 60),
  check (char_length(platform) between 1 and 16),
  check (desktop_version is null or char_length(desktop_version) between 1 and 32),
  check (cardinality(logins) <= 10),
  check (jsonb_typeof(decisions) = 'array' and jsonb_array_length(decisions) <= 20),
  check (status in ('available', 'paused')),
  check (offline_reason is null or offline_reason in ('quit', 'sleep'))
);

comment on table public.user_computers is
  'A person''s computers where Instafy Desktop runs (docs/Local-Engine-Turns.md 11.23): presence, the Claude Code login ids ready there and what Desktop runs. It holds no folder, path, account or sign-in, and never makes a runtime eligible to lease.';

-- A person's computers in the order they were added, as the routes list them.
create index user_computers_user_created_idx
  on public.user_computers (user_id, created_at, id);

create trigger user_computers_set_updated_at
  before update on public.user_computers
  for each row execute function public.set_timestamp();

alter table public.user_computers enable row level security;
create policy "user computers service role" on public.user_computers
  for all using (public.current_request_role() = 'service_role')
  with check (true);
revoke all privileges on table public.user_computers from public, anon, authenticated;
