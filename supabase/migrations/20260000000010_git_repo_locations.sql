create table if not exists git_repo_locations (
  project_id uuid primary key references projects(id) on delete cascade,
  shard_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists git_repo_locations_shard_url_idx
  on git_repo_locations(shard_url);

drop trigger if exists set_git_repo_locations_updated_at on git_repo_locations;
create trigger set_git_repo_locations_updated_at
  before update on git_repo_locations
  for each row
  execute function set_timestamp();
