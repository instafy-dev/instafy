-- Org invite links (shareable join links).

create table if not exists org_invite_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  role text not null default 'builder' check (role in ('owner','admin','builder','viewer')),
  token uuid not null unique default gen_random_uuid(),
  created_by uuid references auth.users(id),
  status text not null default 'active' check (status in ('active','revoked','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  expires_at timestamptz
);

create index if not exists org_invite_links_org_idx on org_invite_links(org_id);
create index if not exists org_invite_links_project_idx on org_invite_links(project_id);

drop trigger if exists set_org_invite_links_updated_at on org_invite_links;
create trigger set_org_invite_links_updated_at
  before update on org_invite_links
  for each row
  execute function set_timestamp();

