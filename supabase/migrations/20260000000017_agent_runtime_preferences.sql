-- Per-project runtime pinning for user-scoped AI agents + job routing.
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

create table if not exists user_agent_project_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  agent_id uuid not null references user_agents(id) on delete cascade,
  runtime_id uuid references runtimes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, agent_id)
);

create index if not exists user_agent_project_settings_project_idx
  on user_agent_project_settings(project_id);
create index if not exists user_agent_project_settings_runtime_idx
  on user_agent_project_settings(runtime_id);

drop trigger if exists set_user_agent_project_settings_updated_at on user_agent_project_settings;
create trigger set_user_agent_project_settings_updated_at
  before update on user_agent_project_settings
  for each row
  execute function set_timestamp();

alter table if exists agent_jobs
  add column if not exists target_runtime_id uuid references runtimes(id) on delete set null;

create index if not exists agent_jobs_target_runtime_idx on agent_jobs(target_runtime_id);
create index if not exists agent_jobs_project_target_status_idx
  on agent_jobs(project_id, target_runtime_id, status, priority, created_at);
