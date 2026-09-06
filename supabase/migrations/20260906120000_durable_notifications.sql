-- Controller-owned notification ledger. Source triggers make every event, recipient,
-- and endpoint outbox insertion atomic with the product mutation, including writers
-- outside the HTTP controller. Historical messages are deliberately not backfilled.
set local lock_timeout = '5s';

create table if not exists public.notification_event_types (
  event_name text not null,
  version integer not null check (version > 0),
  category text not null check (category in ('support','conversations','runs','automations')),
  resource_type text not null check (resource_type in ('support_report','conversation','run','automation')),
  primary key (event_name, version),
  unique (event_name, version, category, resource_type)
);
insert into public.notification_event_types values
  ('support.reply',1,'support','support_report'),
  ('support.resolved',1,'support','support_report'),
  ('conversation.reply',1,'conversations','conversation'),
  ('run.failed',1,'runs','run'),
  ('automation.completed',1,'automations','automation'),
  ('automation.failed',1,'automations','automation')
on conflict do nothing;

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  version integer not null default 1,
  category text not null,
  resource_type text not null,
  resource_id uuid not null,
  project_id uuid references public.projects(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  -- All v1 presentation is static, selected by the versioned registry. Never copy
  -- source content, titles, diagnostics, paths, prompts, or provider errors here.
  payload jsonb not null default '{}'::jsonb check (payload = '{}'::jsonb),
  producer_key text not null unique check (length(producer_key) between 1 and 200),
  foreign key (event_name,version,category,resource_type)
    references public.notification_event_types(event_name,version,category,resource_type),
  check ((category = 'support' and project_id is null and conversation_id is null)
      or (category <> 'support' and project_id is not null))
);
create table if not exists public.notification_recipients (
  event_id uuid not null references public.notification_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  read_at timestamptz,
  archived_at timestamptz,
  primary key (event_id,user_id)
);
create index if not exists notification_recipients_user_inbox_idx
  on public.notification_recipients(user_id,created_at desc,event_id desc) where archived_at is null;
create index if not exists notification_recipients_user_unread_idx
  on public.notification_recipients(user_id,created_at desc) where read_at is null and archived_at is null;

create table if not exists public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('support','conversations','runs','automations')),
  channel text not null check (channel in ('web_push','apns','local')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key(user_id,category,channel)
);
create table if not exists public.notification_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  hide_previews boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.notification_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  user_id uuid not null,
  channel text not null check (channel in ('web_push','apns')),
  -- Polymorphic endpoint identity; current owner/existence is checked at claim
  -- and immediately before transport. No token or endpoint URL is copied here.
  endpoint_id uuid not null,
  status text not null default 'pending' check (status in ('pending','leased','succeeded','failed','cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_code text check (length(last_code) <= 80 and last_code ~ '^[A-Za-z0-9_.:-]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(event_id,user_id) references public.notification_recipients(event_id,user_id) on delete cascade,
  unique(event_id,user_id,channel,endpoint_id),
  check ((status = 'leased') = (lease_token is not null and lease_until is not null))
);
create index if not exists notification_delivery_jobs_due_idx
  on public.notification_delivery_jobs(next_attempt_at,id) where status in ('pending','leased');
create table if not exists public.notification_delivery_attempts (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.notification_delivery_jobs(id) on delete cascade,
  attempt_no integer not null check (attempt_no between 1 and 8),
  status text not null check (status in ('leased','pending','succeeded','retry','failed','cancelled','lease_expired')),
  code text check (length(code) <= 80 and code ~ '^[A-Za-z0-9_.:-]+$'),
  created_at timestamptz not null default now(),
  unique(job_id,attempt_no)
);

create or replace function public.notification_project_authorized(target_project uuid, target_user uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from public.projects p where p.id=target_project and p.status<>'deleted'
    and (p.owner_user_id=target_user
      or exists(select 1 from public.project_memberships pm where pm.project_id=p.id
        and pm.user_id=target_user and lower(pm.role) in ('viewer','builder'))
      or exists(select 1 from public.org_memberships om where om.org_id=p.org_id
        and om.user_id=target_user and lower(om.role) in ('viewer','builder','admin','owner'))));
$$;
create or replace function public.notification_conversation_authorized(target_conversation uuid, target_user uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists(select 1 from public.conversations c where c.id=target_conversation
    and public.notification_project_authorized(c.project_id,target_user)
    and (c.visibility<>'private' or c.created_by=target_user
      or exists(select 1 from public.conversation_participants cp
        where cp.conversation_id=c.id and cp.user_id=target_user)));
$$;
create or replace function public.notification_recipient_authorized(target_event uuid, target_user uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists(select 1 from public.notification_events e
    join public.notification_recipients r on r.event_id=e.id and r.user_id=target_user
    where e.id=target_event and case e.resource_type
      when 'support_report' then exists(select 1 from public.bug_reports b where b.id=e.resource_id and b.user_id=target_user)
      when 'automation' then exists(select 1 from public.automations a where a.id=e.resource_id and a.user_id=target_user
        and public.notification_project_authorized(a.project_id,target_user)
        and (e.conversation_id is null or public.notification_conversation_authorized(e.conversation_id,target_user)))
      when 'conversation' then public.notification_conversation_authorized(e.resource_id,target_user)
      when 'run' then exists(select 1 from public.runs run where run.id=e.resource_id
        and public.notification_project_authorized(e.project_id,target_user)
        and (e.conversation_id is null or public.notification_conversation_authorized(e.conversation_id,target_user)))
      else false end);
$$;
create or replace function public.notification_delivery_authorized(target_job uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists(select 1 from public.notification_delivery_jobs j
    join public.notification_events e on e.id=j.event_id
    join public.notification_recipients r on r.event_id=j.event_id and r.user_id=j.user_id
    where j.id=target_job and public.notification_recipient_authorized(j.event_id,j.user_id)
      and r.seen_at is null and r.read_at is null and r.archived_at is null
      and coalesce((select pref.enabled from public.notification_preferences pref
        where pref.user_id=j.user_id and pref.category=e.category and pref.channel=j.channel),true)
      and case j.channel
        when 'web_push' then exists(select 1 from public.web_push_subscriptions w where w.id=j.endpoint_id and w.user_id=j.user_id)
        when 'apns' then exists(select 1 from public.native_push_tokens n where n.id=j.endpoint_id and n.user_id=j.user_id and n.platform='ios')
        else false end);
$$;

-- Timestamps only advance; reading and archiving also mark the item seen.
create or replace function public.notification_monotonic_recipient()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.event_id := old.event_id;
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  new.archived_at := greatest(old.archived_at,new.archived_at);
  new.read_at := greatest(old.read_at,new.read_at,new.archived_at);
  new.seen_at := greatest(old.seen_at,new.seen_at,new.read_at);
  return new;
end;
$$;
drop trigger if exists notification_monotonic_recipient on public.notification_recipients;
create trigger notification_monotonic_recipient before update on public.notification_recipients
  for each row execute function public.notification_monotonic_recipient();

-- This helper only accepts registered types and constructs the safe payload itself.
-- An ON CONFLICT retry must not add recipients or endpoints to an already emitted
-- event (for example after membership or device ownership changes).
create or replace function public.notification_emit(
  event_type text, resource uuid, project uuid, conversation uuid,
  idempotency_key text, happened_at timestamptz, recipient_ids uuid[])
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare event_uuid uuid; event_category text;
begin
  insert into public.notification_events(event_name,version,category,resource_type,resource_id,
    project_id,conversation_id,occurred_at,producer_key)
    select t.event_name,t.version,t.category,t.resource_type,resource,project,conversation,
      coalesce(happened_at,now()),idempotency_key from public.notification_event_types t
      where t.event_name=event_type and t.version=1
    on conflict(producer_key) do nothing returning id,category into event_uuid,event_category;
  if event_uuid is null then
    select id into event_uuid from public.notification_events where producer_key=idempotency_key
      and event_name=event_type and version=1 and resource_id=resource
      and project_id is not distinct from project and conversation_id is not distinct from conversation;
    if event_uuid is null then raise exception 'unknown notification type or conflicting producer key'; end if;
    return event_uuid;
  end if;
  insert into public.notification_recipients(event_id,user_id)
    select distinct event_uuid,u.id from unnest(recipient_ids) r(id) join auth.users u on u.id=r.id;
  delete from public.notification_recipients r where r.event_id=event_uuid
    and not public.notification_recipient_authorized(event_uuid,r.user_id);
  insert into public.notification_delivery_jobs(event_id,user_id,channel,endpoint_id)
    select event_uuid,r.user_id,ep.channel,ep.id from public.notification_recipients r
    join lateral (
      select 'web_push'::text channel,w.id from public.web_push_subscriptions w where w.user_id=r.user_id
      union all select 'apns',n.id from public.native_push_tokens n where n.user_id=r.user_id and n.platform='ios'
    ) ep on true
    where r.event_id=event_uuid and coalesce((select p.enabled from public.notification_preferences p
      where p.user_id=r.user_id and p.category=event_category and p.channel=ep.channel),true)
    on conflict do nothing;
  return event_uuid;
end;
$$;

create or replace function public.notification_conversation_recipients(conversation uuid, sender uuid default null)
returns uuid[] language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct candidate.id),'{}'::uuid[]) from (
    select c.created_by id from public.conversations c where c.id=conversation
    union select cp.user_id from public.conversation_participants cp where cp.conversation_id=conversation
  ) candidate where candidate.id is not null and candidate.id is distinct from sender
    and public.notification_conversation_authorized(conversation,candidate.id);
$$;

-- Mentions are canonical user identities, never display-name/content matching.
-- Direct service writes receive the same bounded shape checks as controller
-- callers. A mention cannot grant project access or private-chat membership.
create or replace function public.notification_message_recipients(
  conversation uuid, sender uuid, message_metadata jsonb)
returns uuid[] language plpgsql stable set search_path = public, pg_temp as $$
declare recipients uuid[]; mentions jsonb; mention jsonb; mentioned_user uuid;
begin
  recipients := public.notification_conversation_recipients(conversation,sender);
  mentions := message_metadata->'mentionedUserIds';
  if jsonb_typeof(mentions) is distinct from 'array' then return recipients; end if;
  if jsonb_array_length(mentions)>32 then return recipients; end if;
  for mention in select value from jsonb_array_elements(mentions) loop
    if jsonb_typeof(mention)='string'
      and (mention#>>'{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      mentioned_user := (mention#>>'{}')::uuid;
      if mentioned_user is distinct from sender
        and public.notification_conversation_authorized(conversation,mentioned_user) then
        recipients := array_append(recipients,mentioned_user);
      end if;
    end if;
  end loop;
  return array(select distinct id from unnest(recipients) candidate(id));
end;
$$;

-- A counter survives reopen/re-resolve even when both mutations share now().
-- Existing resolution history is intentionally not emitted on migration/replay.
alter table public.bug_reports add column if not exists notification_resolution_sequence bigint not null default 0;
create or replace function public.notification_support_resolution_sequence()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.notification_resolution_sequence := old.notification_resolution_sequence +
    case when old.status in ('open','in_progress') and new.status='resolved' then 1 else 0 end;
  if old.status in ('open','in_progress') and new.status='resolved' and new.user_id is not null then
    -- The durable event owns presentation, including while cached clients or
    -- older controllers still call the legacy in-app claim endpoint. Reserve
    -- its cursor in the same transaction as the AFTER event/outbox insertion;
    -- do not mark the support timeline or notification recipient seen/read.
    new.customer_last_notified_resolution_at := greatest(
      old.customer_last_notified_resolution_at,
      new.customer_last_notified_resolution_at,
      coalesce(new.resolved_at,now()));
  end if;
  return new;
end;
$$;
drop trigger if exists notification_support_resolution_sequence on public.bug_reports;
create trigger notification_support_resolution_sequence before update on public.bug_reports
  for each row execute function public.notification_support_resolution_sequence();
create or replace function public.notification_support_resolved()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status in ('open','in_progress') and new.status='resolved' and new.user_id is not null then
    perform public.notification_emit('support.resolved',new.id,null,null,
      'support.resolved:'||new.id||':'||new.notification_resolution_sequence,
      coalesce(new.resolved_at,now()),array[new.user_id]);
  end if;
  return new;
end;
$$;
drop trigger if exists notification_support_resolved on public.bug_reports;
create trigger notification_support_resolved after update on public.bug_reports
  for each row execute function public.notification_support_resolved();
comment on column public.bug_reports.customer_last_notified_resolution_at is
  'Legacy in-app resolution claim cursor; durable resolution events reserve it atomically without marking support or notification state seen/read.';
create or replace function public.notification_support_reply()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare owner_id uuid;
begin
  -- This table contains customer-visible messages exclusively. System status
  -- entries, customer followups, and internal notes never produce support.reply.
  if new.author_type='support' then
    select user_id into owner_id from public.bug_reports where id=new.bug_report_id;
    if owner_id is not null then
      perform public.notification_emit('support.reply',new.bug_report_id,null,null,
        'support.reply:'||new.id,new.created_at,array[owner_id]);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists notification_support_reply on public.bug_report_messages;
create trigger notification_support_reply after insert on public.bug_report_messages
  for each row execute function public.notification_support_reply();

create or replace function public.notification_conversation_reply()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare message_type text; message_kind text; recipients uuid[]; automation_owner uuid;
begin
  if lower(btrim(new.role)) not in ('assistant','user') or btrim(new.content)='' then return new; end if;
  message_type := lower(btrim(coalesce(new.metadata->>'messageType',new.metadata->>'message_type','')));
  message_kind := lower(btrim(coalesce(new.metadata->>'kind','')));
  if lower(btrim(new.role))='assistant' and message_kind='update' then return new; end if;
  if message_kind in ('runtime_alert','run_cancellation','runtime_switch','agent_job_thread') then return new; end if;
  if message_type in ('command_execution','mcp_tool_call','todo_list','web_search','file_change','token_usage','reasoning',
    'runtime_alert','run_cancellation','runtime_switch','agent_job_thread') then return new; end if;
  if message_type='status' and lower(btrim(coalesce(new.metadata#>>'{details,kind}','')))<>'agent_message' then return new; end if;
  if lower(btrim(new.role))='user' then
    recipients := public.notification_message_recipients(new.conversation_id,new.created_by,new.metadata);
  else
    recipients := public.notification_conversation_recipients(new.conversation_id,new.created_by);
    select a.user_id into automation_owner from public.automations a
      where a.conversation_id=new.conversation_id and a.project_id=new.project_id order by a.created_at limit 1;
    if found then
      -- The owner gets the terminal automation event. Other actual participants
      -- still get visible replies; automation control failures remain owner-only.
      recipients := array_remove(recipients,automation_owner);
      if cardinality(recipients)=0 then return new; end if;
    elsif exists(select 1 from public.runs r where r.id=new.run_id and r.status='failed') then
      -- A normal failed run already notifies every participant at this destination.
      return new;
    end if;
  end if;
  perform public.notification_emit('conversation.reply',new.conversation_id,new.project_id,new.conversation_id,
    'conversation.reply:'||new.id,new.created_at,recipients);
  return new;
end;
$$;
drop trigger if exists notification_conversation_reply on public.conversation_messages;
create trigger notification_conversation_reply after insert on public.conversation_messages
  for each row execute function public.notification_conversation_reply();

create or replace function public.notification_decline_sentinel(content text)
returns boolean language plpgsql immutable as $$
declare value text := btrim(content,E' \t\r\n'); remainder text; first_line text;
begin
  if value is null then return false; end if;
  if value='NO_RESPONSE' then return true; end if;
  if left(value,3)='```' then
    value := substring(value from 4);
    if right(value,3)='```' then value := left(value,length(value)-3); end if;
    value := btrim(value,E' \t\r\n');
    if value='NO_RESPONSE' then return true; end if;
    first_line := split_part(value,E'\n',1);
    remainder := substring(value from length(first_line)+2);
    return btrim(first_line,E' \t\r') ~ '^[A-Za-z0-9_-]+$' and btrim(remainder,E' \t\r\n')='NO_RESPONSE';
  end if;
  return btrim(btrim(value,'`'),E' \t\r\n')='NO_RESPONSE';
end;
$$;

-- Deferred until transaction end: completion updates the run before writing its
-- final message/decline bookkeeping. Read the final job state, never a speculative
-- intermediate response, and fail the source transaction if outbox creation fails.
create or replace function public.notification_run_terminal()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare automation_row record; recipients uuid[]; event_type text; is_silent boolean;
begin
  if new.status not in ('success','failed') or old.status=new.status or new.project_id is null then return new; end if;
  -- Ignore a terminal intermediate update undone later in this transaction.
  if not exists(select 1 from public.runs r where r.id=new.id and r.status=new.status) then return new; end if;
  select a.* into automation_row from public.automations a
    where a.conversation_id=new.conversation_id and a.project_id=new.project_id order by a.created_at limit 1;
  if found then
    if new.status='success' then
      select exists(select 1 from public.agent_jobs j where j.run_id=new.id and j.parent_job_id is null
        and j.outcome='succeeded' and j.error_message is null
        and j.payload#>>'{metadata,groupParticipation,enforcedBy}'='runtime-controller'
        and ((j.payload#>>'{metadata,groupParticipation,decision}'='agent_evaluation' and public.notification_decline_sentinel(j.summary))
          or (j.payload#>>'{metadata,groupParticipation,decision}'='silent'
            and j.payload#>>'{metadata,groupParticipation,reason}'='agent_declined'
            and (j.summary is null or btrim(j.summary)='' or public.notification_decline_sentinel(j.summary))))) into is_silent;
      -- agent.complete only swallows an authenticated decline when no visible
      -- assistant answer has already arrived. Its final summary can still be
      -- NO_RESPONSE after visible streaming output; that is not a quiet run.
      if is_silent and not exists(select 1 from public.conversation_messages m
        where m.run_id=new.id and m.project_id=new.project_id and m.role='assistant'
          and m.created_by is null and nullif(btrim(m.content),'') is not null
          and (lower(coalesce(m.metadata->>'messageType',m.metadata->>'message_type',''))
            not in ('command_execution','mcp_tool_call','web_search','file_change','status','runtime_alert',
                    'run_cancellation','runtime_switch','agent_job_thread','token_usage','reasoning')
            or (lower(coalesce(m.metadata->>'messageType',m.metadata->>'message_type',''))='status'
              and lower(coalesce(m.metadata#>>'{details,kind}',''))='agent_message'))
          and lower(coalesce(m.metadata->>'kind','')) not in ('runtime_alert','run_cancellation','runtime_switch','agent_job_thread'))
        then return new; end if;
    end if;
    event_type := case when new.status='success' then 'automation.completed' else 'automation.failed' end;
    perform public.notification_emit(event_type,automation_row.id,new.project_id,new.conversation_id,
      event_type||':run:'||new.id,now(),array[automation_row.user_id]);
  elsif new.status='failed' then
    if new.conversation_id is not null then
      recipients := public.notification_conversation_recipients(new.conversation_id);
    else
      select array_remove(array[p.user_id,project.owner_user_id],null) into recipients
        from public.projects project left join public.prompts p on p.id=new.prompt_id where project.id=new.project_id;
    end if;
    perform public.notification_emit('run.failed',new.id,new.project_id,new.conversation_id,
      'run.failed:'||new.id,now(),recipients);
  end if;
  return new;
end;
$$;
drop trigger if exists notification_run_terminal on public.runs;
create constraint trigger notification_run_terminal after update on public.runs
  deferrable initially deferred for each row execute function public.notification_run_terminal();

create or replace function public.notification_automation_launch_failed()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.last_run_at is distinct from old.last_run_at and new.last_run_at is not null
    and nullif(btrim(new.last_error),'') is not null then
    perform public.notification_emit('automation.failed',new.id,new.project_id,new.conversation_id,
      'automation.failed:launch:'||new.id||':'||extract(epoch from new.last_run_at)::text,
      new.last_run_at,array[new.user_id]);
  end if;
  return new;
end;
$$;
drop trigger if exists notification_automation_launch_failed on public.automations;
create trigger notification_automation_launch_failed after update on public.automations
  for each row execute function public.notification_automation_launch_failed();

-- Bounded concurrent claims. Expired leases count as attempts; a controller crash
-- cannot create an infinite retry loop. Every claim is fenced with a fresh token.
create or replace function public.notification_lease_jobs(batch_size integer default 25, lease_seconds integer default 60)
returns setof public.notification_delivery_jobs language plpgsql set search_path = public, pg_temp as $$
declare candidate public.notification_delivery_jobs; claimed public.notification_delivery_jobs;
begin
  for candidate in select j.* from public.notification_delivery_jobs j
    where (j.status='pending' and j.next_attempt_at<=now()) or (j.status='leased' and j.lease_until<=now())
    order by j.next_attempt_at,j.id for update skip locked limit greatest(1,least(batch_size,100))
  loop
    if candidate.status='leased' then
      update public.notification_delivery_attempts set status='lease_expired',code='lease_expired'
        where job_id=candidate.id and attempt_no=candidate.attempt_count and status='leased';
    end if;
    if not public.notification_delivery_authorized(candidate.id) then
      update public.notification_delivery_jobs set status='cancelled',last_code='authorization_or_preference_changed',
        lease_token=null,lease_until=null,updated_at=now() where id=candidate.id;
    elsif candidate.attempt_count>=8 or candidate.created_at<now()-interval '7 days' then
      update public.notification_delivery_jobs set status='failed',last_code='delivery_expired',
        lease_token=null,lease_until=null,updated_at=now() where id=candidate.id;
    else
      update public.notification_delivery_jobs set status='leased',attempt_count=attempt_count+1,
        lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>greatest(10,least(lease_seconds,120))),
        updated_at=now() where id=candidate.id returning * into claimed;
      insert into public.notification_delivery_attempts(job_id,attempt_no,status)
        values(claimed.id,claimed.attempt_count,'leased');
      return next claimed;
    end if;
  end loop;
end;
$$;

-- Browser roles never access endpoint registrations or notification state directly.
-- Controller routes authenticate a real user, validate input, then use these tables.
-- Closing the older self-write endpoint policies prevents bypassing SSRF validation.
do $$
declare table_name text; function_row record;
begin
  foreach table_name in array array['notification_event_types','notification_events','notification_recipients',
    'notification_preferences','notification_settings','notification_delivery_jobs','notification_delivery_attempts',
    'web_push_subscriptions','native_push_tokens'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated',table_name);
    execute format('grant all on table public.%I to service_role',table_name);
  end loop;
  for function_row in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'notification_%' loop
    execute format('revoke all on function %s from public, anon, authenticated',function_row.signature);
    execute format('grant execute on function %s to service_role',function_row.signature);
  end loop;
end;
$$;
revoke all on sequence public.notification_delivery_attempts_id_seq from public,anon,authenticated;
grant usage,select on sequence public.notification_delivery_attempts_id_seq to service_role;
