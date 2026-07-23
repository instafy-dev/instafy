-- Runtime providers configuration
create table if not exists runtime_providers (
  id text primary key,
  display_name text not null,
  kind text not null,
  owner_org_id uuid,
  allowed_org_ids uuid[] not null default '{}',
  endpoint text,
  auth_token text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_runtime_providers_updated_at on runtime_providers;
create trigger set_runtime_providers_updated_at
  before update on runtime_providers
  for each row
  execute function set_timestamp();

insert into runtime_providers (id, display_name, kind)
values ('runtime', 'Local Docker', 'docker')
on conflict (id) do nothing;
