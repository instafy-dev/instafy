-- Bug reports can contain user email addresses, logs, and raw screenshot bytes.
-- Keep direct client roles out; controller/service-role database access bypasses RLS.

-- Enabling RLS takes an ACCESS EXCLUSIVE lock. Fail quickly behind live traffic
-- so operators can safely retry instead of creating a production lock convoy.
set local lock_timeout = '5s';

alter table if exists public.bug_reports enable row level security;
alter table if exists public.bug_report_attachments enable row level security;

revoke all privileges on table public.bug_reports from anon, authenticated;
revoke all privileges on table public.bug_report_attachments from anon, authenticated;
