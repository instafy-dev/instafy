-- Keep private conversation data private for direct Supabase reads as well as
-- controller reads. Project access alone is not sufficient for a private chat:
-- the requester must be its creator or a current participant.

create or replace function public.has_conversation_access(target_conversation_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
  requester_role text := public.current_request_role();
  conversation_project_id uuid;
  conversation_created_by uuid;
  conversation_visibility text;
begin
  if target_conversation_id is null then
    return false;
  end if;

  select project_id, created_by, visibility
    into conversation_project_id, conversation_created_by, conversation_visibility
  from public.conversations
  where id = target_conversation_id;

  if not found then
    return false;
  end if;

  if requester_role = 'service_role' then
    return true;
  end if;

  if requester is null
     or not public.has_project_access(conversation_project_id) then
    return false;
  end if;

  if conversation_visibility <> 'private' then
    return true;
  end if;

  if conversation_created_by = requester then
    return true;
  end if;

  return exists (
    select 1
    from public.conversation_participants participant
    where participant.conversation_id = target_conversation_id
      and participant.user_id = requester
  );
end;
$$;

revoke all on function public.has_conversation_access(uuid) from public;
grant execute on function public.has_conversation_access(uuid)
  to authenticated, anon, service_role;

-- Fail quickly instead of queueing an ACCESS EXCLUSIVE lock behind long-running
-- production traffic. Every ALTER below is metadata-only; operators can safely
-- retry the migration if a busy database cannot grant the lock promptly.
set local lock_timeout = '5s';

-- Migration 24 and a few earlier migrations created permissive `FOR ALL`
-- service-role policies with `WITH CHECK (true)`. PostgreSQL evaluates only
-- WITH CHECK for INSERT, so those policies accidentally admitted browser-role
-- inserts. Harden every service-role ALL policy that exists at migration time,
-- including policies outside migration 24 and installations with optional
-- tables. Narrow self-write policies remain separate and are not changed.
do $policy_hardening$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and cmd = 'ALL'
      and qual ilike '%current_request_role%'
      and qual ilike '%service_role%'
      and replace(with_check, ' ', '') in ('true', '(true)')
  loop
    execute format(
      'alter policy %I on %I.%I using (public.current_request_role() = ''service_role'') with check (public.current_request_role() = ''service_role'')',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end
$policy_hardening$;

-- Defense in depth: controller-owned tables must not be mutated through the
-- public PostgREST roles even if a future policy is accidentally broadened.
-- Deliberately excluded because they retain documented narrow client writes:
-- profiles, sites, user_agents, user_credentials,
-- user_agent_project_settings, web_push_subscriptions, native_push_tokens, and
-- newsletter_subscribers.
do $controller_owned_privileges$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations',
    'org_memberships',
    'projects',
    'project_environments',
    'project_memberships',
    'conversations',
    'conversation_participants',
    'prompts',
    'runs',
    'build_runs',
    'conversation_messages',
    'agent_jobs',
    'runtimes',
    'runtime_events',
    'runtime_leases',
    'runtime_providers',
    'git_repo_locations',
    'org_invitations',
    'org_invite_links',
    'email_outbox',
    'billing_plans',
    'runtime_tunnel_grants',
    'workspace_origins',
    'workspace_leases',
    'origin_presence',
    'workspace_commit_receipts',
    'origin_access_grants',
    'origin_instances',
    'org_subscriptions',
    'org_credit_balances',
    'org_credit_ledger',
    'org_resource_limits',
    'automations',
    'agent_context_cards',
    'conversation_send_queue',
    'bug_reports',
    'bug_report_attachments',
    'ota_releases',
    'ota_channel_assignments',
    'ota_device_states',
    'ota_events',
    'ota_channel_history',
    'desktop_update_device_states',
    'desktop_update_events',
    'desktop_update_promotions',
    'billing_webhook_events',
    'project_user_activity',
    'project_browser_profiles'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format(
        'revoke insert, update, delete, truncate, references, trigger on table public.%I from anon, authenticated',
        table_name
      );
    end if;
  end loop;
end
$controller_owned_privileges$;

-- Runtime logs are operational telemetry. The table is very large in
-- production, so add only a nullable column (no default/rewrite). Deliberately
-- do not add a foreign key or an index here: without the child index, a
-- referential action would scan millions of events whenever a conversation is
-- deleted, while building the index in this transaction would itself scan and
-- lock the hot table. The controller validates the conversation/project pair
-- before inserting; retaining a deleted conversation UUID also acts as a
-- privacy tombstone because member log reads require the conversation to exist.
alter table if exists public.runtime_events
  add column if not exists conversation_id uuid;

-- Raw runtime telemetry is no longer a browser-readable database surface.
-- The controller applies project/private-conversation authorization and a
-- strict data allowlist on every row, including historical rows.
drop policy if exists "runtime events project read" on public.runtime_events;
revoke all privileges on table public.runtime_events from anon, authenticated;

-- A private conversation owns its prompt/run/job payloads. The previous
-- ON DELETE SET NULL actions silently reclassified those rows as project-wide
-- data after a conversation deletion. Swap the three FKs to CASCADE without
-- scanning existing rows: DROP/ADD is metadata-only and NOT VALID still checks
-- all new writes while installing the referential-action triggers immediately.
-- Constraint validation is intentionally left to a measured later operation.
do $private_conversation_lifecycle$
declare
  target record;
  constraint_row record;
  relation_oid oid;
  conversation_attnum smallint;
  has_cascade boolean;
begin
  for target in
    select *
    from (values
      ('prompts', 'prompts_conversation_id_fkey'),
      ('runs', 'runs_conversation_id_fkey'),
      ('agent_jobs', 'agent_jobs_conversation_id_fkey')
    ) as targets(table_name, constraint_name)
  loop
    relation_oid := to_regclass(format('public.%I', target.table_name));
    if relation_oid is null then
      continue;
    end if;

    conversation_attnum := null;
    select attribute.attnum
      into conversation_attnum
    from pg_attribute attribute
    where attribute.attrelid = relation_oid
      and attribute.attname = 'conversation_id'
      and not attribute.attisdropped;
    if conversation_attnum is null then
      continue;
    end if;

    has_cascade := false;
    for constraint_row in
      select constraint_def.conname, constraint_def.confdeltype
      from pg_constraint constraint_def
      where constraint_def.conrelid = relation_oid
        and constraint_def.confrelid = 'public.conversations'::regclass
        and constraint_def.contype = 'f'
        and constraint_def.conkey = array[conversation_attnum]::smallint[]
    loop
      if constraint_row.confdeltype = 'c' then
        has_cascade := true;
      else
        execute format(
          'alter table public.%I drop constraint %I',
          target.table_name,
          constraint_row.conname
        );
      end if;
    end loop;

    if not has_cascade then
      execute format(
        'alter table public.%I add constraint %I foreign key (conversation_id) references public.conversations(id) on delete cascade not valid',
        target.table_name,
        target.constraint_name
      );
    end if;
  end loop;
end
$private_conversation_lifecycle$;

alter table if exists public.conversations enable row level security;

drop policy if exists "conversations project read" on public.conversations;
create policy "conversations project read" on public.conversations
  for select using (public.has_conversation_access(id));

alter table if exists public.conversation_messages enable row level security;

drop policy if exists "conversation messages project read" on public.conversation_messages;
create policy "conversation messages project read" on public.conversation_messages
  for select using (
    public.has_project_access(project_id)
    and public.has_conversation_access(conversation_id)
  );

alter table if exists public.runs enable row level security;

drop policy if exists "runs project read" on public.runs;
create policy "runs project read" on public.runs
  for select using (
    auth.uid() is not null
    and public.has_project_access(project_id)
    and (
      conversation_id is null
      or public.has_conversation_access(conversation_id)
    )
  );

-- Prompts and agent jobs both carry a first-class conversation_id, so their
-- existing authenticated read policies can apply the same rule cleanly.
alter table if exists public.prompts enable row level security;

drop policy if exists "prompts read" on public.prompts;
create policy "prompts read" on public.prompts
  for select using (
    auth.uid() is not null
    and (
      (
        conversation_id is null
        and (
          (project_id is not null and public.has_project_access(project_id))
          or user_id = auth.uid()
        )
      )
      or (
        conversation_id is not null
        and (project_id is null or public.has_project_access(project_id))
        and public.has_conversation_access(conversation_id)
      )
    )
  );

alter table if exists public.agent_jobs enable row level security;

drop policy if exists "agent jobs project read" on public.agent_jobs;
create policy "agent jobs project read" on public.agent_jobs
  for select using (
    auth.uid() is not null
    and public.has_project_access(project_id)
    and (
      conversation_id is null
      or public.has_conversation_access(conversation_id)
    )
  );

-- Queued sends include the complete prompt request. They were introduced
-- without RLS, which made private drafts readable through PostgREST. The
-- controller continues to use service-role access; signed-in clients may only
-- inspect their own queue entries for conversations they can currently see.
alter table if exists public.conversation_send_queue enable row level security;

drop policy if exists "conversation send queue service role"
  on public.conversation_send_queue;
create policy "conversation send queue service role"
  on public.conversation_send_queue
  for all
  using (public.current_request_role() = 'service_role')
  with check (public.current_request_role() = 'service_role');

drop policy if exists "conversation send queue own read"
  on public.conversation_send_queue;
create policy "conversation send queue own read"
  on public.conversation_send_queue
  for select using (
    auth.uid() is not null
    and user_id = auth.uid()
    and public.has_project_access(project_id)
    and public.has_conversation_access(conversation_id)
  );

-- An automation prompt belongs to its creator and its private conversation.
-- Project-wide read access exposed one member's scheduled prompts to every
-- other member. Direct writes also bypassed controller permission checks, so
-- authenticated clients retain owner-only reads while all mutations go
-- through the service-role controller.
drop policy if exists "automations project read" on public.automations;
drop policy if exists "automations service role" on public.automations;
create policy "automations service role" on public.automations
  for all
  using (public.current_request_role() = 'service_role')
  with check (public.current_request_role() = 'service_role');
drop policy if exists "automations self" on public.automations;
drop policy if exists "automations self read" on public.automations;
create policy "automations self read" on public.automations
  for select using (
    auth.uid() = user_id
    and public.has_project_access(project_id)
    and (
      conversation_id is null
      or public.has_conversation_access(conversation_id)
    )
  );

-- Context cards are personal agent memory. Project-wide SELECT exposed every
-- user's cards (including private-conversation summaries) to all teammates.
-- Direct mutations go through the controller so its project and scoped-token
-- checks cannot be bypassed through PostgREST.
drop policy if exists "agent context cards project read"
  on public.agent_context_cards;
drop policy if exists "agent context cards service role"
  on public.agent_context_cards;
create policy "agent context cards service role"
  on public.agent_context_cards
  for all
  using (public.current_request_role() = 'service_role')
  with check (public.current_request_role() = 'service_role');
drop policy if exists "agent context cards self"
  on public.agent_context_cards;
drop policy if exists "agent context cards self read"
  on public.agent_context_cards;
create policy "agent context cards self read"
  on public.agent_context_cards
  for select using (
    auth.uid() = user_id
    and public.has_project_access(project_id)
    and (
      scope_kind <> 'conversation'
      or exists (
        select 1
        from public.conversations conversation
        where conversation.id::text = scope_id
          and conversation.project_id = agent_context_cards.project_id
          and public.has_conversation_access(conversation.id)
      )
    )
  );

-- Deliberately leave has_project_access unchanged. Migration 25 already denies
-- unowned and unshared org-less projects. Session-scoped sandbox access is a
-- controller concern and has no session claim in direct database requests;
-- encoding it here would either over-grant org-less rows or break valid sandbox
-- requests that the controller authorizes through its service-role connection.
