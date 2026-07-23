-- Scoped context cards for lightweight cross-agent context discovery.
--
-- One card summarizes one agent's context for one memory scope. The scope is
-- structured as (scope_kind, scope_id) so the controller can translate it to
-- today's conversation-backed provider state without exposing provider ids.

create table if not exists agent_context_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  agent_id uuid not null references user_agents(id) on delete cascade,
  scope_kind text not null check (scope_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  scope_id text not null check (length(scope_id) > 0 and length(scope_id) <= 200),
  title text check (title is null or length(title) <= 160),
  context text not null check (length(context) > 0 and length(context) <= 4000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, agent_id, scope_kind, scope_id)
);

create index if not exists agent_context_cards_project_idx
  on agent_context_cards(project_id, updated_at desc);
create index if not exists agent_context_cards_agent_scope_idx
  on agent_context_cards(agent_id, scope_kind, scope_id);
create index if not exists agent_context_cards_user_project_idx
  on agent_context_cards(user_id, project_id, updated_at desc);

drop trigger if exists set_agent_context_cards_updated_at on agent_context_cards;
create trigger set_agent_context_cards_updated_at
  before update on agent_context_cards
  for each row
  execute function set_timestamp();

alter table if exists agent_context_cards enable row level security;

drop policy if exists "agent context cards service role" on agent_context_cards;
create policy "agent context cards service role" on agent_context_cards
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "agent context cards project read" on agent_context_cards;
create policy "agent context cards project read" on agent_context_cards
  for select using (auth.uid() is not null and public.has_project_access(project_id));

drop policy if exists "agent context cards self" on agent_context_cards;
create policy "agent context cards self" on agent_context_cards
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
