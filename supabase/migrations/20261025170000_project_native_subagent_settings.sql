set local lock_timeout = '5s';

-- Native helper capacity is per parent job and excludes the parent. The shared
-- controller-tracked worker limit remains max_concurrent_agents.
alter table public.project_multi_agent_settings
    add column max_native_subagents integer not null default 3
    check (max_native_subagents between 1 and 64);
