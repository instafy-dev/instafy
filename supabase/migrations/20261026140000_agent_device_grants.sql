-- Device grants: a person's revocable consent that one of their agents may
-- call named tools on one of their own devices, in turns that person starts
-- in one conversation. A job a grant applies to names it in
-- agent_jobs.grant_ids. Controller-only.
set local lock_timeout = '5s';

-- user_id: the grant's person, who owns the device and whose own turns get its
-- tools. tool_ids: the tools those turns may call, from the device's catalog,
-- whose hash (catalog_hash) the grant pins: a catalog that changes ends the
-- grant's turns until its person grants it again. budgets: coarse per-turn
-- call limits. conversation_id: only turns in that conversation, and there
-- only the person's own messages start agent turns. runtime_id: the grant's
-- turns run on that runtime only. voice: speech the device heard starts
-- granted turns too. not_before: a turn asked for before this gets none of
-- the grant; a stop moves it forward. revoked_at: the grant ended.
create table if not exists public.agent_device_grants (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null,
  agent_id uuid not null,
  provider_id text not null,
  device_id text not null,
  tool_ids text[] not null,
  budgets jsonb not null default '{}'::jsonb,
  catalog_hash text not null,
  conversation_id uuid not null,
  runtime_id uuid,
  voice boolean not null default false,
  not_before timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- One live grant of a device to an agent of a person's.
create unique index if not exists agent_device_grants_live_idx
  on public.agent_device_grants (user_id, project_id, agent_id, provider_id, device_id)
  where revoked_at is null;
-- Dispatch and stops look up the live grants that name a conversation.
create index if not exists agent_device_grants_conversation_idx
  on public.agent_device_grants (conversation_id)
  where revoked_at is null;

alter table public.agent_device_grants enable row level security;
revoke all privileges on table public.agent_device_grants from public, anon, authenticated;

-- The grants a job holds, which only dispatch writes. Null: none.
alter table public.agent_jobs
  add column if not exists grant_ids uuid[];
