-- User-scoped AI agent profiles (bots) that can be mapped to BYOC credentials.

create table if not exists user_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Optional: credential powering this agent. Can be null if disconnected/revoked.
  credential_id uuid references user_credentials(id) on delete set null,
  provider text not null default 'openai',
  handle text not null,
  display_name text,
  avatar_seed text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_agents_user_idx on user_agents(user_id);
create index if not exists user_agents_credential_idx on user_agents(credential_id);

-- Enforce unique handles per user (case-insensitive) for active agents.
create unique index if not exists user_agents_unique_handle_per_user
  on user_agents(user_id, lower(handle))
  where deleted_at is null;

drop trigger if exists set_user_agents_updated_at on user_agents;
create trigger set_user_agents_updated_at
  before update on user_agents
  for each row
  execute function set_timestamp();
