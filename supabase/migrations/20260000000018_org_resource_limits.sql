-- Org resource limits (overrideable per org).
-- Defaults remain plan-based in the controller; this table stores optional overrides.

create table if not exists org_resource_limits (
  org_id uuid primary key references organizations(id) on delete cascade,
  max_active_tunnels bigint,
  max_active_hosted_runtimes bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_org_resource_limits_updated_at on org_resource_limits;
create trigger set_org_resource_limits_updated_at
  before update on org_resource_limits
  for each row
  execute function set_timestamp();

alter table org_resource_limits enable row level security;

drop policy if exists "org resource limits service role" on org_resource_limits;
create policy "org resource limits service role" on org_resource_limits
  using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "org resource limits read" on org_resource_limits;
create policy "org resource limits read" on org_resource_limits
  for select using (public.has_org_access(org_id));

