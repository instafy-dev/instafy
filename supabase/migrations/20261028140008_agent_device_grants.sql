-- Device grants, and the columns agent_jobs gains for them.
-- Controller-only: no client reads these.
--
-- Its own file because it holds ACCESS EXCLUSIVE on agent_jobs, so it may hold
-- that lock on no other table that existed before it (MIGRATIONS.md). The new
-- table does not count, and its reference to projects holds SHARE ROW
-- EXCLUSIVE there, which the rules allow. It takes projects before agent_jobs,
-- the order dispatch writes them in, and alters agent_jobs last, so that lock
-- is held for the shortest time.
set local lock_timeout = '5s';

-- A person's revocable consent that one of their agents may call named tools
-- on one of their own devices, in turns that person starts in one
-- conversation. user_id: the grant's person, who owns the device and whose
-- own turns get its tools. tool_ids: the tools those turns may call, by the
-- names the device's catalog publishes. conversation_id: only turns in that
-- conversation, and there only the person's own messages start agent turns.
-- not_before: a turn asked for before this gets none of the grant; a stop
-- moves it forward. revoked_at: the grant ended.
create table public.agent_device_grants (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null,
  agent_id uuid not null,
  provider_id text not null,
  device_id text not null,
  tool_ids text[] not null,
  conversation_id uuid not null,
  not_before timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- One live grant of a device to an agent of a person's.
create unique index agent_device_grants_live_idx
  on public.agent_device_grants (user_id, project_id, agent_id, provider_id, device_id)
  where revoked_at is null;
-- Dispatch and stops look up the live grants that name a conversation.
create index agent_device_grants_conversation_idx
  on public.agent_device_grants (conversation_id)
  where revoked_at is null;

alter table public.agent_device_grants enable row level security;
revoke all privileges on table public.agent_device_grants from public, anon, authenticated;

-- trigger_received_at: when the controller received what started the job, on
-- the database clock: for a queued message, when it was queued; for a job with
-- no message, when the job was queued. Only controller code writes it, once,
-- when it queues the job, and never from a request body. Null on jobs queued
-- before it. grant_ids: the device grants the job holds, which only dispatch
-- writes. Null: none. A job that holds grants is leased once, and only within
-- a minute of trigger_received_at.
alter table public.agent_jobs
  add column trigger_received_at timestamptz,
  add column grant_ids uuid[];
