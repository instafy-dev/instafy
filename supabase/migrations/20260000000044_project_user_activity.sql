-- Durable record of genuine user activity per project (activity pings from
-- the app). The in-memory tracker dies with every controller restart, and the
-- idle-stop sweep must never mistake "controller restarted" or "sweep
-- bookkeeping" for "user walked away" — that would stop runtimes under
-- actively-working users.

create table if not exists project_user_activity (
  project_id uuid primary key references projects(id) on delete cascade,
  last_active_at timestamptz not null default now()
);

alter table project_user_activity enable row level security;
revoke all privileges on table project_user_activity from anon, authenticated;
