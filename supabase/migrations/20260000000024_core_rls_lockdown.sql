-- Harden Supabase table access for browser clients.
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.
-- Core org/project tables -----------------------------------------------------
alter table if exists organizations enable row level security;

drop policy if exists "organizations service role" on organizations;
create policy "organizations service role" on organizations
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "organizations read" on organizations;
create policy "organizations read" on organizations
  for select using (auth.uid() is not null and public.has_org_access(id));

alter table if exists org_memberships enable row level security;

drop policy if exists "org memberships service role" on org_memberships;
create policy "org memberships service role" on org_memberships
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "org memberships self read" on org_memberships;
create policy "org memberships self read" on org_memberships
  for select using (auth.uid() = user_id);

alter table if exists projects enable row level security;

drop policy if exists "projects service role" on projects;
create policy "projects service role" on projects
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "projects read" on projects;
create policy "projects read" on projects
  for select using (auth.uid() is not null and public.has_project_access(id));

alter table if exists project_environments enable row level security;

drop policy if exists "project environments service role" on project_environments;
create policy "project environments service role" on project_environments
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "project environments read" on project_environments;
create policy "project environments read" on project_environments
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists project_memberships enable row level security;

drop policy if exists "project memberships service role" on project_memberships;
create policy "project memberships service role" on project_memberships
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "project memberships self read" on project_memberships;
create policy "project memberships self read" on project_memberships
  for select using (auth.uid() = user_id);

-- User-scoped data ------------------------------------------------------------
alter table if exists profiles enable row level security;

drop policy if exists "profiles service role" on profiles;
create policy "profiles service role" on profiles
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "profiles self" on profiles;
create policy "profiles self" on profiles
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table if exists sites enable row level security;

drop policy if exists "sites service role" on sites;
create policy "sites service role" on sites
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "sites self" on sites;
create policy "sites self" on sites
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table if exists user_agents enable row level security;

drop policy if exists "user agents service role" on user_agents;
create policy "user agents service role" on user_agents
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "user agents self" on user_agents;
create policy "user agents self" on user_agents
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table if exists user_credentials enable row level security;

drop policy if exists "user credentials service role" on user_credentials;
create policy "user credentials service role" on user_credentials
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "user credentials self" on user_credentials;
create policy "user credentials self" on user_credentials
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table if exists user_agent_project_settings enable row level security;

drop policy if exists "user agent project settings service role" on user_agent_project_settings;
create policy "user agent project settings service role" on user_agent_project_settings
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "user agent project settings self" on user_agent_project_settings;
create policy "user agent project settings self" on user_agent_project_settings
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table if exists web_push_subscriptions enable row level security;

drop policy if exists "web push subscriptions service role" on web_push_subscriptions;
create policy "web push subscriptions service role" on web_push_subscriptions
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "web push subscriptions self" on web_push_subscriptions;
create policy "web push subscriptions self" on web_push_subscriptions
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table if exists native_push_tokens enable row level security;

drop policy if exists "native push tokens service role" on native_push_tokens;
create policy "native push tokens service role" on native_push_tokens
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "native push tokens self" on native_push_tokens;
create policy "native push tokens self" on native_push_tokens
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Project-scoped runtime + conversations -------------------------------------
alter table if exists conversations enable row level security;

drop policy if exists "conversations service role" on conversations;
create policy "conversations service role" on conversations
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "conversations project read" on conversations;
create policy "conversations project read" on conversations
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists conversation_participants enable row level security;

drop policy if exists "conversation participants service role" on conversation_participants;
create policy "conversation participants service role" on conversation_participants
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "conversation participants self read" on conversation_participants;
create policy "conversation participants self read" on conversation_participants
  for select using (auth.uid() = user_id);

alter table if exists prompts enable row level security;

drop policy if exists "prompts service role" on prompts;
create policy "prompts service role" on prompts
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "prompts read" on prompts;
create policy "prompts read" on prompts
  for select using (
    auth.uid() is not null
    and (
      (project_id is not null and public.has_project_access(project_id))
      or user_id = auth.uid()
    )
  );

alter table if exists runs enable row level security;

drop policy if exists "runs service role" on runs;
create policy "runs service role" on runs
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "runs project read" on runs;
create policy "runs project read" on runs
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists build_runs enable row level security;

drop policy if exists "build runs service role" on build_runs;
create policy "build runs service role" on build_runs
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "build runs project read" on build_runs;
create policy "build runs project read" on build_runs
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists conversation_messages enable row level security;

drop policy if exists "conversation messages service role" on conversation_messages;
create policy "conversation messages service role" on conversation_messages
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "conversation messages project read" on conversation_messages;
create policy "conversation messages project read" on conversation_messages
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists agent_jobs enable row level security;

drop policy if exists "agent jobs service role" on agent_jobs;
create policy "agent jobs service role" on agent_jobs
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "agent jobs project read" on agent_jobs;
create policy "agent jobs project read" on agent_jobs
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists runtimes enable row level security;

drop policy if exists "runtimes service role" on runtimes;
create policy "runtimes service role" on runtimes
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "runtimes project read" on runtimes;
create policy "runtimes project read" on runtimes
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists runtime_events enable row level security;

drop policy if exists "runtime events service role" on runtime_events;
create policy "runtime events service role" on runtime_events
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "runtime events project read" on runtime_events;
create policy "runtime events project read" on runtime_events
  for select using (auth.uid() is not null and public.has_project_access(project_id));

alter table if exists runtime_leases enable row level security;

drop policy if exists "runtime leases service role" on runtime_leases;
create policy "runtime leases service role" on runtime_leases
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "runtime leases project read" on runtime_leases;
create policy "runtime leases project read" on runtime_leases
  for select using (auth.uid() is not null and public.has_project_access(project_id));

-- Admin-only tables -----------------------------------------------------------
alter table if exists runtime_providers enable row level security;

drop policy if exists "runtime providers service role" on runtime_providers;
create policy "runtime providers service role" on runtime_providers
  for all using (public.current_request_role() = 'service_role')
  with check (true);

alter table if exists git_repo_locations enable row level security;

drop policy if exists "git repo locations service role" on git_repo_locations;
create policy "git repo locations service role" on git_repo_locations
  for all using (public.current_request_role() = 'service_role')
  with check (true);

alter table if exists org_invitations enable row level security;

drop policy if exists "org invitations service role" on org_invitations;
create policy "org invitations service role" on org_invitations
  for all using (public.current_request_role() = 'service_role')
  with check (true);

alter table if exists org_invite_links enable row level security;

drop policy if exists "org invite links service role" on org_invite_links;
create policy "org invite links service role" on org_invite_links
  for all using (public.current_request_role() = 'service_role')
  with check (true);

alter table if exists email_outbox enable row level security;

drop policy if exists "email outbox service role" on email_outbox;
create policy "email outbox service role" on email_outbox
  for all using (public.current_request_role() = 'service_role')
  with check (true);

alter table if exists billing_plans enable row level security;

drop policy if exists "billing plans service role" on billing_plans;
create policy "billing plans service role" on billing_plans
  for all using (public.current_request_role() = 'service_role')
  with check (true);

-- Tighten existing project policies to require auth (avoid anon reads) --------
drop policy if exists "runtime tunnel grants project read" on runtime_tunnel_grants;
create policy "runtime tunnel grants project read" on runtime_tunnel_grants
  for select using (auth.uid() is not null and public.has_project_access(project_id));

drop policy if exists "workspace origins project read" on workspace_origins;
create policy "workspace origins project read" on workspace_origins
  for select using (auth.uid() is not null and public.has_project_access(project_id));

drop policy if exists "origin presence project read" on origin_presence;
create policy "origin presence project read" on origin_presence
  for select using (auth.uid() is not null and public.has_project_access(project_id));

drop policy if exists "workspace commit receipts project read" on workspace_commit_receipts;
create policy "workspace commit receipts project read" on workspace_commit_receipts
  for select using (auth.uid() is not null and public.has_project_access(project_id));

drop policy if exists "origin instances project read" on origin_instances;
create policy "origin instances project read" on origin_instances
  for select using (auth.uid() is not null and public.has_project_access(project_id));
