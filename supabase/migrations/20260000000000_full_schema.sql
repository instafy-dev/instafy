-- Consolidated Supabase schema for local development and CI.
-- Includes all prior migrations to avoid ordering/sync issues.

-- Extensions & helpers ------------------------------------------------------
create extension if not exists citext;
create extension if not exists pgcrypto;

create or replace function set_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace function public.current_request_role()
returns text
language sql
stable
as $$
  select coalesce(current_setting('request.jwt.claim.role', true), '');
$$;

-- Core org/project tables ----------------------------------------------------
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  name text not null,
  billing_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_organizations_updated_at on organizations;
create trigger set_organizations_updated_at
  before update on organizations
  for each row
  execute function set_timestamp();

create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_org_id uuid references organizations(id) on delete set null,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_profiles_updated_at on profiles;
create trigger set_profiles_updated_at
  before update on profiles
  for each row
  execute function set_timestamp();

create table if not exists org_memberships (
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'builder' check (role in ('owner','admin','builder','viewer')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index if not exists org_memberships_user_idx on org_memberships(user_id);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  sandbox_session_id uuid,
  project_type text not null default 'customer' check (project_type in ('sandbox','customer')),
  status text not null default 'active' check (status in ('active','expiring','disabled','deleted')),
  expires_at timestamptz,
  repo_owner text,
  repo_name text,
  installation_id bigint,
  working_branch text not null default 'main',
  credit_limit int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists projects_repo_unique on projects(repo_owner, repo_name);
create index if not exists projects_cleanup_idx on projects(project_type, status, expires_at);

drop trigger if exists set_projects_updated_at on projects;
create trigger set_projects_updated_at
  before update on projects
  for each row
  execute function set_timestamp();

create table if not exists project_environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment text not null check (environment in ('preview','production')),
  url text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_environments_unique
  on project_environments(project_id, environment);

drop trigger if exists set_project_environments_updated_at on project_environments;
create trigger set_project_environments_updated_at
  before update on project_environments
  for each row
  execute function set_timestamp();

-- Access helpers -------------------------------------------------------------
create or replace function public.has_project_access(target_project_id uuid)
returns boolean
language plpgsql
stable
security definer
as $$
declare
  requester uuid := auth.uid();
  requester_role text := public.current_request_role();
  project_record projects%ROWTYPE;
begin
  if target_project_id is null then
    return false;
  end if;

  select * into project_record
  from projects
  where id = target_project_id;

  if project_record.id is null then
    return false;
  end if;

  if requester_role = 'service_role' then
    return true;
  end if;

  -- Allow access while org membership is not enforced.
  if project_record.org_id is null then
    return true;
  end if;

  if requester is null then
    return false;
  end if;

  if project_record.owner_user_id = requester then
    return true;
  end if;

  return exists (
    select 1
    from org_memberships m
    where m.org_id = project_record.org_id
      and m.user_id = requester
  );
end;
$$;

create or replace function public.has_org_access(target_org_id uuid)
returns boolean
language plpgsql
stable
security definer
as $$
declare
  requester uuid := auth.uid();
  requester_role text := public.current_request_role();
begin
  if target_org_id is null then
    return false;
  end if;
  if requester_role = 'service_role' then
    return true;
  end if;
  if requester is null then
    return false;
  end if;
  return exists (
    select 1
    from org_memberships m
    where m.org_id = target_org_id
      and m.user_id = requester
  );
end;
$$;

grant execute on function public.has_org_access(uuid) to authenticated, anon, service_role;

-- Sites ----------------------------------------------------------------------
create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  org_id uuid,
  project_id uuid references projects(id) on delete cascade,
  metadata jsonb,
  content jsonb,
  deployment jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sites_project_id_key unique (project_id)
);

create index if not exists sites_user_id_idx on sites(user_id);
create index if not exists sites_project_id_idx on sites(project_id);

drop trigger if exists set_sites_updated_at on sites;
create trigger set_sites_updated_at
  before update on sites
  for each row
  execute function set_timestamp();

-- Conversations & prompts ----------------------------------------------------
create table if not exists conversations (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  session_id uuid,
  created_by uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_project_idx on conversations(project_id);

create table if not exists prompts (
  id uuid primary key,
  project_id uuid references projects(id) on delete cascade,
  session_id uuid,
  user_id uuid references auth.users(id) on delete set null,
  intent text not null default 'feature',
  prompt_text text not null default '',
  plan_seed jsonb,
  metadata jsonb not null default '{}'::jsonb,
  conversation_id uuid references conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prompts_conversation_idx on prompts(conversation_id);

drop trigger if exists set_prompts_updated_at on prompts;
create trigger set_prompts_updated_at
  before update on prompts
  for each row
  execute function set_timestamp();

-- Runs & build runs ----------------------------------------------------------
create or replace function set_runs_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  session_id uuid,
  prompt_id uuid references prompts(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  run_type text not null check (run_type in ('prompt','build','editor')),
  status text not null default 'queued'
    check (status in ('queued','in_progress','awaiting_approval','success','failed','canceled','merged')),
  progress double precision not null default 0,
  progress_stage text,
  preview_url text,
  last_message text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists runs_project_idx on runs(project_id);
create index if not exists runs_session_idx on runs(session_id);
create index if not exists runs_prompt_idx on runs(prompt_id);
create index if not exists runs_type_status_idx on runs(run_type, status);
create index if not exists runs_conversation_idx on runs(conversation_id);

drop trigger if exists runs_updated_at_trigger on runs;
create trigger runs_updated_at_trigger
before update on runs
for each row
execute function set_runs_updated_at();

create table if not exists build_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  session_id uuid,
  repo_owner text not null,
  repo_name text not null,
  workflow text not null,
  branch text not null,
  status text not null default 'queued' check (status in ('queued','in_progress','failed','success','canceled')),
  dispatched_at timestamptz not null default now(),
  metadata jsonb,
  error_message text
);

create index if not exists build_runs_project_idx on build_runs(project_id);
create index if not exists build_runs_repo_idx on build_runs(repo_owner, repo_name);

-- Conversation messages ------------------------------------------------------
create table if not exists conversation_messages (
  id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  session_id uuid,
  prompt_id uuid references prompts(id) on delete set null,
  run_id uuid references runs(id) on delete set null,
  role text not null,
  content text not null,
  metadata jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists conversation_messages_conversation_idx on conversation_messages(conversation_id);
create index if not exists conversation_messages_project_idx on conversation_messages(project_id);

-- Agent jobs -----------------------------------------------------------------
create table if not exists agent_jobs (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    run_id uuid references runs(id) on delete set null,
    prompt_id uuid references prompts(id) on delete set null,
    session_id uuid,
    conversation_id uuid references conversations(id) on delete set null,
    intent text,
    status text not null default 'queued',
    outcome text,
    summary text,
    error_message text,
    payload jsonb not null default '{}'::jsonb,
    priority integer not null default 100,
    lease_attempts integer not null default 0,
    leased_at timestamptz,
    lease_expires_at timestamptz,
    leased_by_runtime_id uuid,
    heartbeat_at timestamptz,
    artifacts jsonb not null default '[]'::jsonb,
    completed_at timestamptz,
    proxy_metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists agent_jobs_conversation_idx on agent_jobs(conversation_id);
create index if not exists agent_jobs_project_status_idx
    on agent_jobs(project_id, status, priority, created_at);
create index if not exists agent_jobs_status_idx
    on agent_jobs(status, priority, created_at);

drop trigger if exists set_agent_jobs_updated_at on agent_jobs;
create trigger set_agent_jobs_updated_at
  before update on agent_jobs
  for each row
  execute function set_timestamp();

-- Runtime metadata & leases --------------------------------------------------
create table if not exists runtimes (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects(id) on delete cascade,
    provider text not null default 'runtime',
    status text not null,
    endpoint_url text,
    task_ref text,
    capabilities jsonb not null default '{}'::jsonb,
    idle_ttl_seconds integer not null default 3600,
    last_seen_at timestamptz,
    display_name text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists runtimes_project_provider_idx
    on runtimes(project_id, provider);
create index if not exists runtimes_status_idx
    on runtimes(status, updated_at);

drop trigger if exists set_runtimes_updated_at on runtimes;
create trigger set_runtimes_updated_at
  before update on runtimes
  for each row
  execute function set_timestamp();

create table if not exists runtime_events (
    id bigserial primary key,
    runtime_id uuid not null references runtimes(id) on delete cascade,
    project_id uuid not null references projects(id) on delete cascade,
    kind text not null,
    data jsonb not null,
    created_at timestamptz not null default now()
);

create index if not exists runtime_events_runtime_idx
    on runtime_events(runtime_id, kind, created_at desc);

create table if not exists runtime_leases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  runtime_id uuid references runtimes(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','launching','active','cleanup_pending','released','failed')),
  requested_at timestamptz not null default now(),
  launched_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz not null default now(),
  allocator_metadata jsonb,
  metadata jsonb,
  scope text not null default 'exclusive'
    check (scope in ('exclusive', 'shared', 'tenant')),
  parent_lease_id uuid references runtime_leases(id) on delete set null
);

create index if not exists runtime_leases_project_idx on runtime_leases(project_id);
create index if not exists runtime_leases_runtime_idx on runtime_leases(runtime_id);
create index if not exists runtime_leases_scope_idx on runtime_leases(scope);
create index if not exists runtime_leases_parent_idx on runtime_leases(parent_lease_id);

drop trigger if exists set_runtime_leases_updated_at on runtime_leases;
create trigger set_runtime_leases_updated_at
  before update on runtime_leases
  for each row
  execute function set_timestamp();

alter table runtimes
  add column if not exists active_lease_id uuid references runtime_leases(id);

create index if not exists runtimes_active_lease_idx on runtimes(active_lease_id);

-- Runtime tunnel grants ------------------------------------------------------
create table if not exists runtime_tunnel_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  runtime_id uuid references runtimes(id) on delete set null,
  runtime_lease_id uuid references runtime_leases(id) on delete set null,
  provider text not null default 'self_hosted'
    check (provider in ('self_hosted')),
  tunnel_id text not null,
  hostname text not null,
  url text not null,
  status text not null default 'issuing'
    check (status in ('issuing','active','revoking','revoked','failed','expired')),
  expires_at timestamptz not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists runtime_tunnel_grants_tunnel_unique
  on runtime_tunnel_grants(tunnel_id);
create index if not exists runtime_tunnel_grants_project_idx
  on runtime_tunnel_grants(project_id, status);
create index if not exists runtime_tunnel_grants_runtime_idx
  on runtime_tunnel_grants(runtime_id);
create index if not exists runtime_tunnel_grants_lease_idx
  on runtime_tunnel_grants(runtime_lease_id);

drop trigger if exists set_runtime_tunnel_grants_updated_at on runtime_tunnel_grants;
create trigger set_runtime_tunnel_grants_updated_at
  before update on runtime_tunnel_grants
  for each row
  execute function set_timestamp();

alter table runtime_tunnel_grants enable row level security;

drop policy if exists "runtime tunnel grants service role" on runtime_tunnel_grants;
create policy "runtime tunnel grants service role" on runtime_tunnel_grants
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "runtime tunnel grants project read" on runtime_tunnel_grants;
create policy "runtime tunnel grants project read" on runtime_tunnel_grants
  for select using (public.has_project_access(project_id));

-- Workspace origins & presence ----------------------------------------------
create table if not exists workspace_origins (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  mode text not null check (mode in ('desktop','efs','hosted')),
  endpoint text not null,
  protocols text[] not null default array[]::text[],
  region text,
  device_id text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspace_origins_project_idx
  on workspace_origins(project_id);
create index if not exists workspace_origins_mode_idx
  on workspace_origins(mode);

drop trigger if exists set_workspace_origins_updated_at on workspace_origins;
create trigger set_workspace_origins_updated_at
  before update on workspace_origins
  for each row
  execute function set_timestamp();

create table if not exists workspace_leases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  runtime_id uuid,
  status text not null default 'active'
    check (status in ('active','released','expired','revoked')),
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspace_leases_project_idx
  on workspace_leases(project_id);
create index if not exists workspace_leases_status_idx
  on workspace_leases(project_id, status);

drop trigger if exists set_workspace_leases_updated_at on workspace_leases;
create trigger set_workspace_leases_updated_at
  before update on workspace_leases
  for each row
  execute function set_timestamp();

create table if not exists origin_presence (
  origin_id uuid primary key references workspace_origins(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  status text not null default 'online'
    check (status in ('online','offline','degraded')),
  last_heartbeat timestamptz not null default now(),
  latency_ms integer,
  region text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists origin_presence_project_idx
  on origin_presence(project_id);

drop trigger if exists set_origin_presence_updated_at on origin_presence;
create trigger set_origin_presence_updated_at
  before update on origin_presence
  for each row
  execute function set_timestamp();

create table if not exists workspace_commit_receipts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  origin_id uuid not null references workspace_origins(id) on delete cascade,
  lease_id uuid references workspace_leases(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  rev text not null,
  bytes_written bigint,
  file_count integer,
  duration_ms integer,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workspace_commit_receipts_project_idx
  on workspace_commit_receipts(project_id, created_at desc);
create index if not exists workspace_commit_receipts_origin_idx
  on workspace_commit_receipts(origin_id, created_at desc);

create table if not exists origin_access_grants (
  id uuid primary key default gen_random_uuid(),
  jti uuid,
  project_id uuid not null references projects(id) on delete cascade,
  origin_id uuid not null references workspace_origins(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  lease_id uuid references workspace_leases(id) on delete set null,
  scopes text[] not null default array[]::text[],
  token_type text not null default 'webdav'
    check (token_type in ('webdav','http','smb')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  issued_ip inet,
  metadata jsonb
);

create unique index if not exists origin_access_grants_jti_unique
  on origin_access_grants(jti)
  where jti is not null;
create index if not exists origin_access_grants_project_idx
  on origin_access_grants(project_id, expires_at);
create index if not exists origin_access_grants_origin_idx
  on origin_access_grants(origin_id, expires_at);

alter table workspace_origins enable row level security;
alter table workspace_leases enable row level security;
alter table origin_presence enable row level security;
alter table workspace_commit_receipts enable row level security;
alter table origin_access_grants enable row level security;

drop policy if exists "workspace origins service role full access" on workspace_origins;
create policy "workspace origins service role full access" on workspace_origins
  for all using (public.current_request_role() = 'service_role')
  with check (true);
drop policy if exists "workspace origins project read" on workspace_origins;
create policy "workspace origins project read" on workspace_origins
  for select using (public.has_project_access(project_id));

drop policy if exists "workspace leases service role full access" on workspace_leases;
create policy "workspace leases service role full access" on workspace_leases
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "origin presence service role full access" on origin_presence;
create policy "origin presence service role full access" on origin_presence
  for all using (public.current_request_role() = 'service_role')
  with check (true);
drop policy if exists "origin presence project read" on origin_presence;
create policy "origin presence project read" on origin_presence
  for select using (public.has_project_access(project_id));

drop policy if exists "workspace commit receipts service role" on workspace_commit_receipts;
create policy "workspace commit receipts service role" on workspace_commit_receipts
  for all using (public.current_request_role() = 'service_role')
  with check (true);
drop policy if exists "workspace commit receipts project read" on workspace_commit_receipts;
create policy "workspace commit receipts project read" on workspace_commit_receipts
  for select using (public.has_project_access(project_id));

drop policy if exists "origin access grants service role only" on origin_access_grants;
create policy "origin access grants service role only" on origin_access_grants
  for all using (public.current_request_role() = 'service_role')
  with check (true);

-- Origin instances ----------------------------------------------------------
create table if not exists origin_instances (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  runtime_id uuid references runtimes(id) on delete set null,
  lease_id uuid references runtime_leases(id) on delete set null,
  origin_id uuid references workspace_origins(id) on delete set null,
  required boolean not null default false,
  mode text check (mode in ('desktop','efs','hosted')),
  status text not null default 'requested'
    check (status in ('requested','pending','online','offline','degraded','failed','released')),
  endpoint text,
  protocols text[] not null default array[]::text[],
  metadata jsonb,
  token_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists origin_instances_project_idx
  on origin_instances(project_id);
create index if not exists origin_instances_runtime_idx
  on origin_instances(runtime_id);
create index if not exists origin_instances_lease_idx
  on origin_instances(lease_id);
create unique index if not exists origin_instances_lease_unique
  on origin_instances(lease_id)
  where lease_id is not null;
create index if not exists origin_instances_status_idx
  on origin_instances(project_id, status);

drop trigger if exists set_origin_instances_updated_at on origin_instances;
create trigger set_origin_instances_updated_at
  before update on origin_instances
  for each row
  execute function set_timestamp();

alter table origin_instances enable row level security;

drop policy if exists "origin instances service role" on origin_instances;
create policy "origin instances service role" on origin_instances
  for all using (public.current_request_role() = 'service_role')
  with check (true);
drop policy if exists "origin instances project read" on origin_instances;
create policy "origin instances project read" on origin_instances
  for select using (public.has_project_access(project_id));

-- Org credits & subscriptions -----------------------------------------------
drop table if exists project_subscriptions cascade;
drop table if exists credit_ledger cascade;
drop table if exists project_credit_balances cascade;
drop function if exists credit_ledger_before_insert();

create table if not exists org_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  processor text not null check (processor in ('stripe','dev')),
  external_id text not null,
  status text not null check (status in ('trialing','active','past_due','canceled','none')),
  currency text not null default 'USD',
  credit_limit int not null default 0,
  billing_cycle text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists org_credit_balances (
  org_id uuid primary key references organizations(id) on delete cascade,
  balance int not null default 0,
  credit_limit int not null default 0,
  on_hold int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists org_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  delta int not null,
  reason text not null,
  balance_after int not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  created_by uuid
);

create or replace function org_credit_ledger_before_insert()
returns trigger as $$
declare
  current_balance int;
begin
  insert into org_credit_balances(org_id)
    values (new.org_id)
    on conflict (org_id) do nothing;

  select balance into current_balance
    from org_credit_balances
    where org_id = new.org_id
    for update;

  current_balance := coalesce(current_balance, 0) + new.delta;

  if current_balance < 0 then
    raise exception 'Insufficient credits for org %', new.org_id;
  end if;

  update org_credit_balances
    set balance = current_balance,
        updated_at = now()
    where org_id = new.org_id;

  new.balance_after := current_balance;
  return new;
end;
$$ language plpgsql;

drop trigger if exists org_credit_ledger_balance_guard on org_credit_ledger;
create trigger org_credit_ledger_balance_guard
  before insert on org_credit_ledger
  for each row
  execute function org_credit_ledger_before_insert();

comment on table org_credit_balances is 'Current credit balance per organization. Ledger entries update this table automatically.';
comment on table org_credit_ledger is 'Immutable record of org-wide credit debits/refills (optionally tagged with a project).';

alter table org_subscriptions enable row level security;
alter table org_credit_balances enable row level security;
alter table org_credit_ledger enable row level security;

drop policy if exists "org subscriptions service role" on org_subscriptions;
create policy "org subscriptions service role" on org_subscriptions
  using (public.current_request_role() = 'service_role')
  with check (true);
drop policy if exists "org subscriptions read" on org_subscriptions;
create policy "org subscriptions read" on org_subscriptions
  for select using (public.has_org_access(org_id));

drop policy if exists "org credit balances service role" on org_credit_balances;
create policy "org credit balances service role" on org_credit_balances
  using (public.current_request_role() = 'service_role')
  with check (true);
drop policy if exists "org credit balances read" on org_credit_balances;
create policy "org credit balances read" on org_credit_balances
  for select using (public.has_org_access(org_id));

drop policy if exists "org credit ledger service role" on org_credit_ledger;
create policy "org credit ledger service role" on org_credit_ledger
  using (public.current_request_role() = 'service_role')
  with check (true);
drop policy if exists "org credit ledger read" on org_credit_ledger;
create policy "org credit ledger read" on org_credit_ledger
  for select using (
    public.has_org_access(org_id)
    or (project_id is not null and public.has_project_access(project_id))
  );
