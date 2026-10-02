-- Opt-in quiet review execution. No schedules are created by this migration.
alter table public.automations add column mode text not null default 'prompt'
  check (mode in ('prompt', 'space_review'));
alter table public.automations add constraint space_review_private_quiet
  check (mode <> 'space_review' or (result_visibility='private' and silent_when_nothing_to_report));
create unique index automations_one_space_review_per_owner
  on public.automations(user_id,project_id) where mode='space_review';

-- Browser RLS permits reads only; controller code alone sets this marker.
-- Persist it independently of the schedule so deleting a schedule cannot
-- turn internal transcripts into ordinary chats.
alter table public.conversations add column internal_purpose text
  check (internal_purpose is null or internal_purpose='space_review');
create or replace function public.is_internal_conversation(target_conversation uuid)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select exists(select 1 from public.conversations c
    left join public.conversations root on root.id=coalesce(c.root_conversation_id,c.id)
    where c.id=target_conversation and (c.internal_purpose='space_review' or root.internal_purpose='space_review'));
$$;

create or replace function public.notification_conversation_authorized(target_conversation uuid, target_user uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists(select 1 from public.conversations c where c.id=target_conversation
    and not public.is_internal_conversation(c.id)
    and public.notification_project_authorized(c.project_id,target_user)
    and (c.visibility<>'private' or c.created_by=target_user
      or exists(select 1 from public.conversation_participants cp
        where cp.conversation_id=c.id and cp.user_id=target_user)));
$$;

create or replace function public.notification_emit(
  event_type text, resource uuid, project uuid, conversation uuid,
  idempotency_key text, happened_at timestamptz, recipient_ids uuid[])
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare event_uuid uuid; event_category text;
begin
  -- Review execution is audit data, not a delivered conversation.
  if public.is_internal_conversation(conversation) then return null; end if;
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
