set local lock_timeout = '5s';

-- A reply nobody can see in the conversation never notifies. The Studio keeps
-- these messages out of the transcript, and none may leave a conversation.reply
-- in the inbox or on a lock screen:
-- - any message with presentation.hidden = true, at the top level or under
--   details: the same JSON boolean the controller and the Studio test
--   (activity::is_visible_reply, shouldHideByPresentationMetadata);
-- - a multi-agent plan helper's own assistant messages
--   (multiAgentPlan.role = worker): its answer folds into the plan, and the
--   lead's reply is the one that notifies. A helper's question to the person
--   (an action_request carrying a userInputRequestId) is shown in the
--   transcript and still notifies.
-- Everything else is unchanged from 20260906120000_durable_notifications.sql.
create or replace function public.notification_conversation_reply()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare message_type text; message_kind text; plan_role text; recipients uuid[]; automation_owner uuid;
begin
  if lower(btrim(new.role)) not in ('assistant','user') or btrim(new.content)='' then return new; end if;
  message_type := lower(btrim(coalesce(new.metadata->>'messageType',new.metadata->>'message_type','')));
  message_kind := lower(btrim(coalesce(new.metadata->>'kind','')));
  if lower(btrim(new.role))='assistant' and message_kind='update' then return new; end if;
  if message_kind in ('runtime_alert','run_cancellation','runtime_switch','agent_job_thread') then return new; end if;
  if message_type in ('command_execution','mcp_tool_call','todo_list','web_search','file_change','token_usage','reasoning',
    'runtime_alert','run_cancellation','runtime_switch','agent_job_thread') then return new; end if;
  if message_type='status' and lower(btrim(coalesce(new.metadata#>>'{details,kind}','')))<>'agent_message' then return new; end if;
  if new.metadata #> '{presentation,hidden}' = 'true'::jsonb
    or new.metadata #> '{details,presentation,hidden}' = 'true'::jsonb then return new; end if;
  if lower(btrim(new.role))='assistant' then
    plan_role := lower(btrim(coalesce(case when jsonb_typeof(new.metadata->'multiAgentPlan')='object'
      then new.metadata#>>'{multiAgentPlan,role}' else new.metadata#>>'{multi_agent_plan,role}' end,'')));
    -- The question test is the Studio's isUUID: hyphenated, RFC version and variant.
    if plan_role='worker' and not (message_type='action_request'
      and jsonb_typeof(new.metadata#>'{details,userInputRequestId}')='string'
      and btrim(new.metadata#>>'{details,userInputRequestId}',E' \t\r\n')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then return new; end if;
  end if;
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
