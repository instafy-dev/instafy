create table if not exists desktop_update_device_states (
    device_id text primary key,
    channel text not null check (channel in ('internal', 'beta', 'stable')),
    current_version text not null,
    available_version text,
    phase text not null check (phase in ('idle', 'checking', 'update_available', 'downloading', 'downloaded', 'up_to_date', 'error')),
    feed_url text not null,
    platform text,
    arch text,
    last_seen_at timestamptz not null,
    last_event_type text,
    last_event_at timestamptz,
    last_checked_at timestamptz,
    last_downloaded_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists desktop_update_events (
    event_id text primary key,
    event_type text not null check (event_type in ('update_available', 'update_not_available', 'download_started', 'download_completed', 'update_ready', 'install_applied', 'update_error')),
    occurred_at timestamptz not null,
    device_id text not null,
    channel text not null check (channel in ('internal', 'beta', 'stable')),
    current_version text not null,
    available_version text,
    phase text not null check (phase in ('idle', 'checking', 'update_available', 'downloading', 'downloaded', 'up_to_date', 'error')),
    feed_url text not null,
    platform text,
    arch text,
    properties jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists desktop_update_promotions (
    request_id text primary key,
    source_channel text not null check (source_channel in ('internal', 'beta', 'stable')),
    target_channel text not null check (target_channel in ('internal', 'beta', 'stable')),
    workflow_ref text not null,
    requested_at timestamptz not null,
    requested_by text not null,
    status text not null check (status in ('dispatched')),
    notes text,
    created_at timestamptz not null default now()
);

create index if not exists desktop_update_device_states_last_seen_idx
    on desktop_update_device_states (last_seen_at desc);
create index if not exists desktop_update_events_occurred_at_idx
    on desktop_update_events (occurred_at desc);
create index if not exists desktop_update_events_channel_idx
    on desktop_update_events (channel, occurred_at desc);
create index if not exists desktop_update_promotions_requested_at_idx
    on desktop_update_promotions (requested_at desc);

alter table desktop_update_device_states enable row level security;
alter table desktop_update_events enable row level security;
alter table desktop_update_promotions enable row level security;

revoke all privileges on table desktop_update_device_states from anon, authenticated;
revoke all privileges on table desktop_update_events from anon, authenticated;
revoke all privileges on table desktop_update_promotions from anon, authenticated;
