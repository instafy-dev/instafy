-- The ended jobs the goal recovery sweep looked at and left unsettled: a job
-- whose goal it may not settle stays a candidate, and so does one that failed
-- to settle. The sweep takes the jobs it has never looked at first, and then
-- the ones it looked at longest ago, so the jobs it leaves cannot keep it from
-- the others.
set local lock_timeout = '5s';
create table public.conversation_goal_recovery_checks (
    job_id uuid primary key references public.agent_jobs(id) on delete cascade,
    checked_at timestamptz not null default now()
);
alter table public.conversation_goal_recovery_checks enable row level security;
revoke all on public.conversation_goal_recovery_checks from anon, authenticated;
grant all on public.conversation_goal_recovery_checks to service_role;
