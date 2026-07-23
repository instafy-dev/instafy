-- Note: Instafy Studio is not live yet; no backfills required beyond schema updates.

alter table if exists bug_reports
    add column if not exists priority text not null default 'normal',
    add column if not exists assignee text,
    add column if not exists labels jsonb not null default '[]'::jsonb,
    add column if not exists duplicate_of uuid references bug_reports(id) on delete set null,
    add column if not exists github_issue_url text,
    add column if not exists resolved_at timestamptz,
    add column if not exists updated_at timestamptz not null default now();

create index if not exists bug_reports_status_created_at_idx on bug_reports (status, created_at desc);
create index if not exists bug_reports_priority_created_at_idx on bug_reports (priority, created_at desc);
create index if not exists bug_reports_assignee_created_at_idx on bug_reports (assignee, created_at desc);
create index if not exists bug_reports_duplicate_of_idx on bug_reports (duplicate_of);
