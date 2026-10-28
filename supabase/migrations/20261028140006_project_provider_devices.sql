-- A device's presence for a provider in a space, from its heartbeats.
-- Controllers before this one created the table the first time a route used
-- it, so a table that already exists is kept and brought to this shape.
-- Controller-only: no client reads it.
--
-- Its own file because it holds ACCESS EXCLUSIVE on a table that may already
-- exist, which a migration that locks a table live requests lock in both
-- orders must not (MIGRATIONS.md). The table holds one row per device, so its
-- new check and index are checked and built under that lock at once.
set local lock_timeout = '5s';

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

-- owner_user_id: the person whose own session registered the device as theirs,
-- where device grants are on for them. Only they may then heartbeat it, list
-- its requests, or claim and complete requests as it, and it takes only their
-- requests. Null: the device keeps the project's rules. catalog: the device's
-- tools in MCP tools/list shape, with the MCP initialize instructions they
-- come with: {"instructions"?: text, "tools": [{"name", "inputSchema", ...}]}.
-- context: at most 1,200 characters the device's owner sent with its last
-- heartbeat, which replaces it each time; a granted turn reads it as the
-- device's words, after the catalog's instructions. Only its recorded owner
-- writes an owned device's catalog and context.
alter table public.project_provider_devices
  add column owner_user_id uuid,
  add column catalog jsonb,
  add column context text
    constraint project_provider_devices_context_length check (char_length(context) <= 1200);

create index if not exists project_provider_devices_project_idx
  on public.project_provider_devices (project_id, provider_family_id, last_seen_at desc);

alter table public.project_provider_devices enable row level security;
revoke all privileges on table public.project_provider_devices from public, anon, authenticated;
