-- Executed only by scripts/test-durable-notifications.py in its disposable cluster.
create function notification_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'notification test failed: %',label; end if; end; $$;
insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-000000000001','customer@example.invalid'),
  ('00000000-0000-0000-0000-000000000002','teammate@example.invalid'),
  ('00000000-0000-0000-0000-000000000003','operator@example.invalid');
insert into projects(id,owner_user_id) values
  ('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001');
insert into project_memberships(project_id,user_id,role) values
  ('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000002','builder');
insert into conversations(id,project_id,created_by,visibility) values
  ('00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001','private');
insert into conversation_participants(conversation_id,user_id) values
  ('00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000002');
insert into web_push_subscriptions(id,user_id,endpoint,p256dh,auth) values
  ('00000000-0000-0000-0000-000000000040','00000000-0000-0000-0000-000000000001','https://push.example.invalid/opaque','fixture','fixture');
insert into bug_reports(id,user_id,message) values
  ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000001','private original report');

-- A report, a customer message, system workflow metadata, and internal notes do not notify.
insert into bug_report_messages(id,bug_report_id,author_type,body) values
  ('00000000-0000-0000-0000-000000000050','00000000-0000-0000-0000-000000000010','customer','private customer content'),
  ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000010','system','workflow status');
update bug_reports set status='in_progress',metadata='{"internalNote":"private diagnostics secret"}' where id='00000000-0000-0000-0000-000000000010';
select notification_test_assert((select count(*)=0 from notification_events),'customer/system/internal updates never notify');

-- Rolled-back support mutation leaves no event, recipient, job, or source message.
begin;
insert into bug_report_messages(id,bug_report_id,author_type,body) values
  ('00000000-0000-0000-0000-000000000052','00000000-0000-0000-0000-000000000010','support','rollback private content');
select notification_test_assert((select count(*)=1 from notification_events),'source trigger inserted event inside transaction');
select notification_test_assert((select count(*)=1 from notification_delivery_jobs),'source trigger inserted outbox inside transaction');
rollback;
select notification_test_assert((select count(*)=0 from notification_events),'rollback removed event');
select notification_test_assert((select count(*)=0 from notification_recipients),'rollback removed recipients');
select notification_test_assert((select count(*)=0 from notification_delivery_jobs),'rollback removed outbox');

-- Visible support reply only to owner, stable deep-link identity, no content payload.
insert into bug_report_messages(id,bug_report_id,author_type,body) values
  ('00000000-0000-0000-0000-000000000053','00000000-0000-0000-0000-000000000010','support','private support answer with logs');
select notification_test_assert((select count(*)=1 from notification_events where event_name='support.reply' and resource_id='00000000-0000-0000-0000-000000000010' and payload='{}'),'support event safe canonical resource');
select notification_test_assert((select count(*)=1 from notification_recipients where user_id='00000000-0000-0000-0000-000000000001'),'report owner sole recipient');
select notification_test_assert((select bool_and(not notification_recipient_authorized(id,'00000000-0000-0000-0000-000000000002')) from notification_events),'other account cannot discover support event');
select notification_test_assert((select count(*)=1 from notification_lease_jobs(10,60)),'background delivery job claims once');
select notification_test_assert((select count(*)=0 from notification_lease_jobs(10,60)),'active lease cannot claim twice');

-- A foreground toast's actual onShow acknowledgement suppresses delayed push,
-- while the durable notification remains unread until the user opens it.
update notification_recipients set seen_at=clock_timestamp();
select notification_test_assert((select bool_and(read_at is null) from notification_recipients),'seen presentation does not mark durable notification read');
select notification_test_assert((select bool_and(not notification_delivery_authorized(id)) from notification_delivery_jobs),'shown foreground presentation suppresses pending external delivery');

-- Click/read state synchronizes monotonically without changing the report cursor.
update notification_recipients set read_at='2026-09-06 12:00:00+00';
update notification_recipients set read_at=null,seen_at=null;
select notification_test_assert((select bool_and(read_at='2026-09-06 12:00:00+00' and seen_at>=read_at) from notification_recipients),'cross-device old read never regresses');
select notification_test_assert((select customer_last_seen_support_at is null from bug_reports where id='00000000-0000-0000-0000-000000000010'),'support unread cursor separate from notification state');
select notification_test_assert((select bool_and(not notification_delivery_authorized(id)) from notification_delivery_jobs),'reading before delivery suppresses external presentation');
update notification_recipients set archived_at='2026-09-06 12:01:00+00';
update notification_recipients set archived_at=null,read_at='2020-01-01';
select notification_test_assert((select bool_and(archived_at is not null and read_at>=archived_at) from notification_recipients),'archive timestamp and read timestamp never regress');

-- Exactly one resolution per transition, even multiple cycles in one transaction.
begin;
update bug_reports set status='resolved',resolved_at=now() where id='00000000-0000-0000-0000-000000000010';
select notification_test_assert((select customer_last_notified_resolution_at=resolved_at from bug_reports where id='00000000-0000-0000-0000-000000000010'),'durable resolution reserves legacy presentation in source transaction');
rollback;
select notification_test_assert((select status='in_progress' and customer_last_notified_resolution_at is null and notification_resolution_sequence=0 from bug_reports where id='00000000-0000-0000-0000-000000000010'),'resolution rollback also rolls back legacy reservation and sequence');
select notification_test_assert((select count(*)=0 from notification_events where event_name='support.resolved'),'resolution rollback emits no durable event');

begin;
update bug_reports set status='resolved',resolved_at=now() where id='00000000-0000-0000-0000-000000000010';
update bug_reports set status='resolved' where id='00000000-0000-0000-0000-000000000010';
update bug_reports set status='open',resolved_at=null where id='00000000-0000-0000-0000-000000000010';
update bug_reports set status='resolved',resolved_at=now() where id='00000000-0000-0000-0000-000000000010';
commit;
select notification_test_assert((select count(*)=2 from notification_events where event_name='support.resolved'),'re-resolution has new durable identity without duplicate updates');
select notification_test_assert((select count(distinct producer_key)=2 from notification_events where event_name='support.resolved'),'resolution sequence independent from identical now timestamps');
select notification_test_assert((select customer_last_notified_resolution_at=resolved_at and customer_last_seen_support_at is null from bug_reports where id='00000000-0000-0000-0000-000000000010'),'durable presentation ownership leaves support timeline unread');
select notification_test_assert((select bool_and(r.seen_at is null and r.read_at is null and r.archived_at is null) from notification_recipients r join notification_events e on e.id=r.event_id where e.event_name='support.resolved'),'legacy reservation does not suppress durable center or push');
select notification_test_assert((select bool_and(notification_delivery_authorized(j.id)) from notification_delivery_jobs j join notification_events e on e.id=j.event_id where e.event_name='support.resolved'),'durable resolution delivery remains eligible');
-- Execute the unchanged legacy-controller predicate, not a new endpoint-only
-- workaround: even an older binary cannot claim a second resolution toast.
with claimed as (
  update bug_reports set customer_last_notified_resolution_at=resolved_at
  where user_id='00000000-0000-0000-0000-000000000001' and status='resolved'
    and resolved_at is not null
    and (customer_last_seen_support_at is null or resolved_at>customer_last_seen_support_at)
    and (customer_last_notified_resolution_at is null or resolved_at>customer_last_notified_resolution_at)
  returning id
)
select notification_test_assert((select count(*)=0 from claimed),'old controller claim cannot duplicate durable resolution alert');

-- Disabled external transport leaves in-app event and recipient available.
insert into notification_preferences(user_id,category,channel,enabled) values
  ('00000000-0000-0000-0000-000000000001','support','web_push',false);
insert into bug_report_messages(id,bug_report_id,author_type,body) values
  ('00000000-0000-0000-0000-000000000054','00000000-0000-0000-0000-000000000010','support','another private reply');
select notification_test_assert((select count(*)=1 from notification_recipients r join notification_events e on e.id=r.event_id where e.producer_key='support.reply:00000000-0000-0000-0000-000000000054'),'push preference never removes in-app item');
select notification_test_assert((select count(*)=0 from notification_delivery_jobs j join notification_events e on e.id=j.event_id where e.producer_key='support.reply:00000000-0000-0000-0000-000000000054'),'disabled channel produces no endpoint job');
select notification_test_assert((select bool_and(not notification_delivery_authorized(id)) from notification_delivery_jobs),'changed preferences revalidated for existing jobs');
update notification_preferences set enabled=true;
insert into notification_settings(user_id) values('00000000-0000-0000-0000-000000000001');
select notification_test_assert((select hide_previews from notification_settings),'lock-screen previews hidden by default');

-- Assistant and human replies preserve conversation recipients; no sender echo.
insert into conversation_messages(id,conversation_id,project_id,role,content,created_by,metadata) values
  ('00000000-0000-0000-0000-000000000060','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000020','assistant','private reply',null,'{}'),
  ('00000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000020','user','private human reply','00000000-0000-0000-0000-000000000001','{}'),
  ('00000000-0000-0000-0000-000000000062','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000020','assistant','private reasoning',null,'{"messageType":"reasoning"}');
select notification_test_assert((select count(*)=2 from notification_events where event_name='conversation.reply'),'assistant and human replies, telemetry excluded');
select notification_test_assert((select count(*)=1 from notification_recipients r join notification_events e on e.id=r.event_id where producer_key='conversation.reply:00000000-0000-0000-0000-000000000061' and r.user_id='00000000-0000-0000-0000-000000000002'),'human sender excluded');
delete from project_memberships where user_id='00000000-0000-0000-0000-000000000002';
select notification_test_assert((select bool_and(not notification_recipient_authorized(e.id,r.user_id)) from notification_events e join notification_recipients r on r.event_id=e.id where r.user_id='00000000-0000-0000-0000-000000000002'),'project revocation invalidates stale participants');
delete from conversation_participants where user_id='00000000-0000-0000-0000-000000000002';
insert into project_memberships(project_id,user_id,role) values('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000002','builder');
select notification_test_assert((select bool_and(not notification_recipient_authorized(e.id,r.user_id)) from notification_events e join notification_recipients r on r.event_id=e.id where r.user_id='00000000-0000-0000-0000-000000000002'),'private participation revocation independent from project membership');

-- Endpoint reassignment or removal must not retarget an old account's job.
update web_push_subscriptions set user_id='00000000-0000-0000-0000-000000000002';
select notification_test_assert((select bool_and(not notification_delivery_authorized(id)) from notification_delivery_jobs),'endpoint account switching fences old jobs');
update web_push_subscriptions set user_id='00000000-0000-0000-0000-000000000001';

-- Run producer is transactional and drops transient terminal states.
insert into runs(id,project_id,conversation_id,run_type) values
  ('00000000-0000-0000-0000-000000000070','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000030','prompt');
begin;
update runs set status='failed' where id='00000000-0000-0000-0000-000000000070';
rollback;
select notification_test_assert((select count(*)=0 from notification_events where event_name='run.failed'),'run rollback emits nothing');
begin;
update runs set status='failed' where id='00000000-0000-0000-0000-000000000070';
update runs set status='in_progress' where id='00000000-0000-0000-0000-000000000070';
commit;
select notification_test_assert((select count(*)=0 from notification_events where event_name='run.failed'),'intermediate failure undone in same transaction emits nothing');
update runs set status='failed' where id='00000000-0000-0000-0000-000000000070';
update runs set status='failed' where id='00000000-0000-0000-0000-000000000070';
select notification_test_assert((select count(*)=1 from notification_events where event_name='run.failed'),'one terminal run failure');

-- Automation completion joins the actual automation record, never user metadata.
insert into conversations(id,project_id,created_by,visibility,thread_kind) values
  ('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001','private','automation');
insert into automations(id,project_id,user_id,name,schedule_kind,interval_hours,conversation_id) values
  ('00000000-0000-0000-0000-000000000080','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001','private automation name','hourly',1,'00000000-0000-0000-0000-000000000031');
insert into runs(id,project_id,conversation_id,run_type) values
  ('00000000-0000-0000-0000-000000000071','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000031','prompt'),
  ('00000000-0000-0000-0000-000000000072','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000031','prompt'),
  ('00000000-0000-0000-0000-000000000073','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000031','prompt');
update runs set status='success' where id='00000000-0000-0000-0000-000000000071';
insert into conversation_messages(id,conversation_id,project_id,run_id,role,content) values
  ('00000000-0000-0000-0000-000000000063','00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000071','assistant','automation private result');
select notification_test_assert((select count(*)=1 from notification_events where event_name='automation.completed'),'automation completion emitted');
select notification_test_assert((select count(*)=0 from notification_events where event_name='conversation.reply' and conversation_id='00000000-0000-0000-0000-000000000031'),'automation does not duplicate reply notification');
begin;
update runs set status='success' where id='00000000-0000-0000-0000-000000000072';
insert into agent_jobs(id,project_id,run_id,status,outcome,summary,payload) values
  ('00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000072','completed','succeeded','NO_RESPONSE','{"metadata":{"groupParticipation":{"decision":"agent_evaluation","enforcedBy":"runtime-controller"}}}');
commit;
select notification_test_assert((select count(*)=1 from notification_events where event_name='automation.completed'),'successful authenticated quiet automation emits no completion');
update runs set status='failed' where id='00000000-0000-0000-0000-000000000073';
update automations set last_run_at=now(),last_error='private provider failure' where id='00000000-0000-0000-0000-000000000080';
select notification_test_assert((select count(*)=2 from notification_events where event_name='automation.failed'),'automation failure and launch failure emitted');
select notification_test_assert((select bool_and(payload='{}') from notification_events),'payload never contains source text');

-- Schema constrains privacy and access even if a future controller caller errs.
do $$ begin
  begin
    update notification_events set payload='{"secret":"oops"}';
    raise exception 'unsafe payload accepted';
  exception when check_violation then null; end;
  begin
    set local role authenticated;
    perform count(*) from notification_events;
    raise exception 'browser read accepted';
  exception when insufficient_privilege then reset role; end;
  begin
    set local role authenticated;
    insert into web_push_subscriptions(user_id,endpoint,p256dh,auth) values
      ('00000000-0000-0000-0000-000000000001','http://127.0.0.1','x','y');
    raise exception 'browser endpoint bypass accepted';
  exception when insufficient_privilege then reset role; end;
end $$;

-- An outbox failure aborts its original source mutation, not merely the notification.
insert into bug_reports(id,user_id,message) values
  ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','resolution rollback fixture');
alter table notification_delivery_jobs add constraint notification_test_outbox_failure check (false) not valid;
do $$ begin
  begin
    insert into bug_report_messages(id,bug_report_id,author_type,body) values
      ('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000010','support','must roll back');
    raise exception 'source succeeded despite failed outbox';
  exception when check_violation then null; end;
  begin
    update bug_reports set status='resolved',resolved_at=now() where id='00000000-0000-0000-0000-000000000011';
    raise exception 'resolution succeeded despite failed outbox';
  exception when check_violation then null; end;
end $$;
alter table notification_delivery_jobs drop constraint notification_test_outbox_failure;
select notification_test_assert((select count(*)=0 from bug_report_messages where id='00000000-0000-0000-0000-000000000099'),'outbox failure rolls back underlying support reply');
select notification_test_assert((select count(*)=0 from notification_events where producer_key='support.reply:00000000-0000-0000-0000-000000000099'),'outbox failure rolls back event');
select notification_test_assert((select status='open' and customer_last_notified_resolution_at is null and notification_resolution_sequence=0 from bug_reports where id='00000000-0000-0000-0000-000000000011'),'outbox failure rolls back resolution and legacy reservation together');
select notification_test_assert((select count(*)=0 from notification_events where resource_id='00000000-0000-0000-0000-000000000011'),'failed resolution leaves no durable event');

-- Native endpoint identities are audited without copying tokens; Android delivery
-- remains disabled even if a pre-migration Android registration still exists.
insert into native_push_tokens(id,user_id,platform,token) values
  ('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000001','ios','inert-ios-fixture'),
  ('00000000-0000-0000-0000-000000000042','00000000-0000-0000-0000-000000000001','android','inert-android-fixture');
insert into bug_report_messages(id,bug_report_id,author_type,body) values
  ('00000000-0000-0000-0000-000000000055','00000000-0000-0000-0000-000000000010','support','native fixture reply');
select notification_test_assert((select count(*)=1 from notification_delivery_jobs where endpoint_id='00000000-0000-0000-0000-000000000041' and channel='apns'),'iOS enqueued through same outbox');
select notification_test_assert((select count(*)=0 from notification_delivery_jobs where endpoint_id='00000000-0000-0000-0000-000000000042'),'Android old tokens not falsely considered deliverable');
delete from native_push_tokens;
select notification_test_assert((select count(*)=1 from notification_delivery_jobs where endpoint_id='00000000-0000-0000-0000-000000000041'),'expired native endpoint retains delivery audit');
select notification_test_assert((select bool_and(not notification_delivery_authorized(id)) from notification_delivery_jobs where endpoint_id='00000000-0000-0000-0000-000000000041'),'expired native endpoint blocks pending delivery');

-- Actual agent.complete semantics: visible streaming output followed by a bare
-- decline summary remains visible, including the status/details adapter shape.
insert into runs(id,project_id,conversation_id,run_type) values
  ('00000000-0000-0000-0000-000000000074','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000031','prompt');
begin;
insert into conversation_messages(id,conversation_id,project_id,run_id,role,content,metadata) values
  ('00000000-0000-0000-0000-000000000064','00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000074','assistant','visible private output',
   '{"kind":"update","messageType":"status","details":{"kind":"agent_message"}}');
update runs set status='success' where id='00000000-0000-0000-0000-000000000074';
insert into agent_jobs(id,project_id,run_id,status,outcome,summary,payload) values
  ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000074','completed','succeeded','NO_RESPONSE',
   '{"metadata":{"groupParticipation":{"decision":"agent_evaluation","enforcedBy":"runtime-controller"}}}');
commit;
select notification_test_assert((select count(*)=2 from notification_events where event_name='automation.completed'),'visible output followed by decline summary still notifies');

-- A failed run's final assistant result must not produce a second alert; a human
-- follow-up tied to that same run still notifies the other participants.
insert into conversation_messages(id,conversation_id,project_id,run_id,role,content,created_by) values
  ('00000000-0000-0000-0000-000000000065','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000070','assistant','private failure details',null),
  ('00000000-0000-0000-0000-000000000066','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000070','user','human follow-up','00000000-0000-0000-0000-000000000002');
select notification_test_assert((select count(*)=0 from notification_events where producer_key='conversation.reply:00000000-0000-0000-0000-000000000065'),'failed assistant completion has only run.failed alert');
select notification_test_assert((select count(*)=1 from notification_events where producer_key='conversation.reply:00000000-0000-0000-0000-000000000066'),'failed run human follow-up remains a reply notification');
