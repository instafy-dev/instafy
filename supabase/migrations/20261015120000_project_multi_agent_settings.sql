-- Capacity policy is controller-owned; workspace writes and runtime tokens cannot change it.
create table public.project_multi_agent_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  max_agents_per_plan integer not null default 64 check (max_agents_per_plan between 1 and 256),
  max_concurrent_agents integer not null default 8 check (max_concurrent_agents between 1 and 64),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.project_multi_agent_settings enable row level security;
revoke all on public.project_multi_agent_settings from anon, authenticated;
grant all on public.project_multi_agent_settings to service_role;

create index agent_jobs_active_team_workers_idx
  on public.agent_jobs(project_id, lease_expires_at)
  where status = 'leased'
    and coalesce(agent_role, payload #>> '{metadata,multiAgentPlan,role}') = 'worker';
