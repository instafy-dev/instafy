-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

create table if not exists bug_reports (
    id uuid primary key,
    user_id uuid,
    reporter_email text,
    message text not null,
    details text,
    project_id uuid,
    runtime_id uuid,
    run_id uuid,
    conversation_id uuid,
    status text not null default 'open',
    metadata jsonb not null default '{}'::jsonb,
    logs jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists bug_report_attachments (
    id uuid primary key,
    bug_report_id uuid not null references bug_reports(id) on delete cascade,
    file_name text not null,
    media_type text not null,
    byte_size bigint not null,
    content bytea not null,
    created_at timestamptz not null default now()
);

create index if not exists bug_reports_created_at_idx on bug_reports (created_at desc);
create index if not exists bug_reports_user_id_idx on bug_reports (user_id, created_at desc);
create index if not exists bug_reports_project_id_idx on bug_reports (project_id, created_at desc);
create index if not exists bug_report_attachments_bug_report_id_idx on bug_report_attachments (bug_report_id, created_at asc);
