-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

create table if not exists ota_releases (
    release_id text primary key,
    platform text not null check (platform in ('ios', 'android')),
    channel text not null,
    bundle_version text not null,
    git_sha text not null,
    native_version text not null,
    min_supported_native_version text not null,
    artifact_url text not null,
    artifact_sha256 text not null,
    artifact_size_bytes bigint not null check (artifact_size_bytes >= 0),
    artifact_type text not null check (artifact_type = 'zip'),
    signature text,
    rollout_percentage integer not null check (rollout_percentage between 0 and 100),
    status text not null check (status in ('draft', 'live', 'paused', 'rolled_back', 'archived')),
    published_at timestamptz not null,
    published_by text not null,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists ota_channel_assignments (
    platform text not null check (platform in ('ios', 'android')),
    channel text not null,
    active_release_id text not null references ota_releases(release_id) on delete restrict,
    previous_release_id text references ota_releases(release_id) on delete set null,
    rollout_percentage integer not null check (rollout_percentage between 0 and 100),
    activated_at timestamptz not null,
    activated_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (platform, channel)
);

create table if not exists ota_device_states (
    platform text not null check (platform in ('ios', 'android')),
    channel text not null,
    device_id text not null,
    native_version text not null,
    current_bundle_version text,
    current_git_sha text,
    last_seen_at timestamptz not null,
    last_check_at timestamptz,
    last_event_type text,
    last_event_at timestamptz,
    last_release_id text,
    last_session_id text,
    last_user_id text,
    last_space_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (platform, channel, device_id)
);

create table if not exists ota_events (
    event_id text primary key,
    event_type text not null,
    occurred_at timestamptz not null,
    device_id text not null,
    platform text not null check (platform in ('ios', 'android')),
    channel text not null,
    native_version text not null,
    bundle_version text,
    git_sha text,
    space_id text,
    user_id text,
    session_id text,
    properties jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table ota_releases add column if not exists created_at timestamptz not null default now();
alter table ota_releases add column if not exists updated_at timestamptz not null default now();
alter table ota_channel_assignments add column if not exists created_at timestamptz not null default now();
alter table ota_channel_assignments add column if not exists updated_at timestamptz not null default now();
alter table ota_device_states add column if not exists created_at timestamptz not null default now();
alter table ota_device_states add column if not exists updated_at timestamptz not null default now();
alter table ota_events add column if not exists created_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'ota_device_states'
      and c.relkind = 'r'
  ) and not exists (
    select 1
    from pg_constraint
    where conname = 'ota_device_states_last_release_id_fkey'
  ) then
    alter table public.ota_device_states
      add constraint ota_device_states_last_release_id_fkey
      foreign key (last_release_id) references public.ota_releases(release_id) on delete set null;
  end if;
end
$$;

create index if not exists ota_releases_platform_channel_published_idx
    on ota_releases (platform, channel, published_at desc);
create unique index if not exists ota_releases_platform_channel_bundle_version_idx
    on ota_releases (platform, channel, bundle_version);
create index if not exists ota_channel_assignments_active_release_idx
    on ota_channel_assignments (active_release_id);
create index if not exists ota_device_states_last_seen_idx
    on ota_device_states (last_seen_at desc);
create index if not exists ota_events_occurred_at_idx
    on ota_events (occurred_at desc);
create index if not exists ota_events_platform_channel_idx
    on ota_events (platform, channel, occurred_at desc);
create index if not exists ota_events_device_idx
    on ota_events (device_id, occurred_at desc);

alter table ota_releases enable row level security;
alter table ota_channel_assignments enable row level security;
alter table ota_device_states enable row level security;
alter table ota_events enable row level security;

revoke all privileges on table ota_releases from anon, authenticated;
revoke all privileges on table ota_channel_assignments from anon, authenticated;
revoke all privileges on table ota_device_states from anon, authenticated;
revoke all privileges on table ota_events from anon, authenticated;
