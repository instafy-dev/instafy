-- Controller-owned research policy and one atomic pool for an entire task.
set local lock_timeout = '5s';
create table public.project_research_settings (
    project_id uuid primary key references public.projects(id) on delete cascade,
    max_page_loads integer not null default 12 check (max_page_loads between 1 and 200),
    max_page_loads_per_site integer not null default 4 check (max_page_loads_per_site between 1 and max_page_loads),
    updated_by uuid,
    updated_at timestamptz not null default now()
);
create table public.agent_research_budgets (
    id uuid primary key,
    project_id uuid not null references public.projects(id) on delete cascade,
    settings jsonb not null,
    state jsonb not null default '{}',
    created_at timestamptz not null default now()
);
create index agent_research_budgets_project_idx on public.agent_research_budgets(project_id);
create table public.agent_job_research_budgets (
    job_id uuid primary key references public.agent_jobs(id) on delete cascade,
    budget_id uuid not null references public.agent_research_budgets(id) on delete cascade
);
create index agent_job_research_budgets_budget_idx on public.agent_job_research_budgets(budget_id);
alter table public.project_research_settings enable row level security;
alter table public.agent_research_budgets enable row level security;
alter table public.agent_job_research_budgets enable row level security;
revoke all on public.project_research_settings, public.agent_research_budgets, public.agent_job_research_budgets from anon, authenticated;
grant all on public.project_research_settings, public.agent_research_budgets, public.agent_job_research_budgets to service_role;
