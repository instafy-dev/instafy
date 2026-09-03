-- Home activity feed: one append-only ledger of what happened across every
-- team a user belongs to. One row per event (never one per recipient); who
-- may see a row is decided at read time with the same project/conversation
-- grant checks the inbox and the events stream use, so a revoked membership
-- hides history instantly and nothing is copied per user.
--
-- Written by the controller inside the transaction that mutates the source
-- (a message, a run, a membership). Read only through the controller.

create table if not exists activity_events (
  id bigint generated always as identity primary key,
  kind text not null,
  org_id uuid null references organizations(id) on delete cascade,
  project_id uuid null references projects(id) on delete cascade,
  conversation_id uuid null references conversations(id) on delete cascade,
  run_id uuid null,
  prompt_id uuid null,
  automation_id uuid null,
  visibility text not null check (visibility in ('project', 'conversation', 'org', 'owner')),
  actor_kind text not null check (actor_kind in ('user', 'agent', 'automation', 'system')),
  -- Humans: no FK on purpose; deleting an auth user must not erase history.
  actor_user_id uuid null,
  -- Agents: {handle, displayName, avatarSeed} only — allow-listed at write time.
  actor_agent jsonb null,
  owner_user_id uuid null,
  target_user_id uuid null,
  title text null,
  preview text null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Rows are written consistently or not at all (fail closed at the schema).
  constraint activity_events_project_scope check (
    visibility not in ('project', 'conversation') or project_id is not null
  ),
  constraint activity_events_conversation_scope check (
    visibility <> 'conversation' or conversation_id is not null
  ),
  constraint activity_events_org_scope check (
    visibility <> 'org' or (org_id is not null and project_id is null)
  ),
  constraint activity_events_owner_scope check (
    visibility <> 'owner' or owner_user_id is not null
  ),
  constraint activity_events_conversation_has_project check (
    conversation_id is null or project_id is not null
  )
);

create index if not exists activity_events_project_id_idx
  on activity_events (project_id, id desc);
create index if not exists activity_events_org_id_idx
  on activity_events (org_id, id desc)
  where project_id is null;
create index if not exists activity_events_conversation_idx
  on activity_events (conversation_id)
  where conversation_id is not null;

-- The cross-device "you're caught up" cut.
create table if not exists activity_seen (
  user_id uuid primary key,
  last_seen_event_id bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Per-event dismissal for rows that "need you" until acknowledged.
create table if not exists activity_acks (
  user_id uuid not null,
  event_id bigint not null references activity_events(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

alter table activity_events enable row level security;
alter table activity_seen enable row level security;
alter table activity_acks enable row level security;
revoke all privileges on table activity_events from anon, authenticated;
revoke all privileges on table activity_seen from anon, authenticated;
revoke all privileges on table activity_acks from anon, authenticated;
revoke all privileges on sequence activity_events_id_seq from anon, authenticated;
