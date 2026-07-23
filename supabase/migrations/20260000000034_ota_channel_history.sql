-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

create table if not exists ota_channel_history (
    history_id text primary key,
    platform text not null check (platform in ('ios', 'android')),
    channel text not null,
    action text not null check (action in ('activate', 'rollback')),
    previous_release_id text references ota_releases(release_id) on delete set null,
    next_release_id text not null references ota_releases(release_id) on delete restrict,
    rollout_percentage integer not null check (rollout_percentage between 0 and 100),
    activated_at timestamptz not null,
    activated_by text not null,
    created_at timestamptz not null default now()
);

alter table ota_channel_history add column if not exists created_at timestamptz not null default now();

create index if not exists ota_channel_history_lookup_idx
    on ota_channel_history (platform, channel, activated_at desc);

alter table ota_channel_history enable row level security;

revoke all privileges on table ota_channel_history from anon, authenticated;
