-- Durable, controller-owned wakeups. A completed job can request at most one
-- continuation; the dispatch message's stable id also fences crash recovery.
set local lock_timeout = '5s';
create table public.conversation_goal_continuations (
    source_job_id uuid primary key references public.agent_jobs(id) on delete cascade,
    conversation_id uuid not null,
    goal_revision uuid not null,
    owner_user_id uuid not null,
    status text not null default 'pending'
        check (status in ('pending', 'claimed', 'dispatched', 'canceled', 'blocked')),
    next_attempt_at timestamptz not null default now(),
    locked_until timestamptz,
    claim_token uuid,
    attempts integer not null default 0 check (attempts >= 0),
    request jsonb,
    run_id uuid,
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index conversation_goal_continuations_due
    on public.conversation_goal_continuations(next_attempt_at)
    where status in ('pending', 'claimed');
alter table public.conversation_goal_continuations enable row level security;
revoke all on public.conversation_goal_continuations from anon, authenticated;
grant all on public.conversation_goal_continuations to service_role;
