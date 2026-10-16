-- Executed only by scripts/test-durable-notifications.py in its disposable cluster.
-- A deleted space (projects.status = 'deleted') is hidden from direct Supabase
-- reads: as the signed-in role, through the row-level security policies, its
-- owner, a member and a team member read the space and its chat rows while it
-- is live and nothing once it is deleted, while another live space of the team
-- stays readable and the service role still reads the deleted one. Everything
-- here runs in one transaction that is rolled back.
begin;
create function deleted_space_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'deleted space test failed: %',label; end if; end; $$;

-- 01 owns both spaces and the team, 02 is a builder of both spaces, 03 is a
-- builder of the team and 04 is in neither. Space 11 is deleted below and
-- space 12 stays live. Each space has one public conversation (31 and 32).
insert into auth.users(id,email) values
  ('70000000-0000-0000-0000-000000000001','deleted-space-owner@example.invalid'),
  ('70000000-0000-0000-0000-000000000002','deleted-space-member@example.invalid'),
  ('70000000-0000-0000-0000-000000000003','deleted-space-team@example.invalid'),
  ('70000000-0000-0000-0000-000000000004','deleted-space-outsider@example.invalid');
insert into organizations(id,slug,name) values
  ('70000000-0000-0000-0000-000000000021','deleted-space-fixture','Deleted space');
insert into org_memberships(org_id,user_id,role) values
  ('70000000-0000-0000-0000-000000000021','70000000-0000-0000-0000-000000000001','owner'),
  ('70000000-0000-0000-0000-000000000021','70000000-0000-0000-0000-000000000003','builder');
insert into projects(id,org_id,owner_user_id) values
  ('70000000-0000-0000-0000-000000000011','70000000-0000-0000-0000-000000000021','70000000-0000-0000-0000-000000000001'),
  ('70000000-0000-0000-0000-000000000012','70000000-0000-0000-0000-000000000021','70000000-0000-0000-0000-000000000001');
insert into project_memberships(project_id,user_id,role) values
  ('70000000-0000-0000-0000-000000000011','70000000-0000-0000-0000-000000000002','builder'),
  ('70000000-0000-0000-0000-000000000012','70000000-0000-0000-0000-000000000002','builder');
insert into conversations(id,project_id,created_by,visibility) values
  ('70000000-0000-0000-0000-000000000031','70000000-0000-0000-0000-000000000011','70000000-0000-0000-0000-000000000001','public'),
  ('70000000-0000-0000-0000-000000000032','70000000-0000-0000-0000-000000000012','70000000-0000-0000-0000-000000000001','public');
insert into user_agents(id,user_id,handle,avatar_seed) values
  ('70000000-0000-0000-0000-000000000041','70000000-0000-0000-0000-000000000001','deleted-space-fixture','fixture'),
  ('70000000-0000-0000-0000-000000000042','70000000-0000-0000-0000-000000000002','deleted-space-fixture','fixture'),
  ('70000000-0000-0000-0000-000000000043','70000000-0000-0000-0000-000000000003','deleted-space-fixture','fixture');

-- One row of each project-wide table, and for each of 01, 02 and 03 one row of
-- each table that only its owner reads.
create function deleted_space_test_seed(space uuid, conversation uuid) returns void language sql as $$
  insert into project_environments(project_id,environment) values (space,'preview');
  insert into conversation_messages(id,conversation_id,project_id,role,content,created_by)
    values (gen_random_uuid(),conversation,space,'user','fixture','70000000-0000-0000-0000-000000000001');
  insert into prompts(id,project_id,user_id,conversation_id,prompt_text)
    values (gen_random_uuid(),space,'70000000-0000-0000-0000-000000000001',conversation,'fixture');
  insert into runs(project_id,conversation_id,run_type) values (space,conversation,'prompt');
  insert into build_runs(project_id,repo_owner,repo_name,workflow,branch)
    values (space,'fixture','fixture','fixture','main');
  insert into agent_jobs(project_id,conversation_id) values (space,conversation);
  insert into automations(project_id,user_id,name,schedule_kind,interval_hours,conversation_id)
    select space, a.user_id, 'fixture', 'hourly', 1, conversation from user_agents a
    where a.handle = 'deleted-space-fixture';
  insert into agent_context_cards(user_id,project_id,agent_id,scope_kind,scope_id,context)
    select a.user_id, space, a.id, 'conversation', conversation::text, 'fixture' from user_agents a
    where a.handle = 'deleted-space-fixture';
  insert into conversation_send_queue(project_id,conversation_id,user_id,request)
    select space, conversation, a.user_id, '{}' from user_agents a
    where a.handle = 'deleted-space-fixture';
  insert into conversation_message_stashes(project_id,conversation_id,owner_user_id,client_stash_id,payload)
    select space, conversation, a.user_id, 'fixture',
      '{"text":"fixture","editorState":null,"composerEnvelope":{}}' from user_agents a
    where a.handle = 'deleted-space-fixture';
$$;
select deleted_space_test_seed('70000000-0000-0000-0000-000000000011','70000000-0000-0000-0000-000000000031');
select deleted_space_test_seed('70000000-0000-0000-0000-000000000012','70000000-0000-0000-0000-000000000032');

-- The rows of a space that the current role and user read, table by table, and
-- the same line for a given count of project-wide and of own rows.
create function deleted_space_test_visible(space uuid) returns text language sql as $$
  select format('projects=%s environments=%s conversations=%s messages=%s prompts=%s runs=%s '
      || 'build_runs=%s jobs=%s automations=%s context_cards=%s send_queue=%s stashes=%s',
    (select count(*) from projects where id = space),
    (select count(*) from project_environments where project_id = space),
    (select count(*) from conversations where project_id = space),
    (select count(*) from conversation_messages where project_id = space),
    (select count(*) from prompts where project_id = space),
    (select count(*) from runs where project_id = space),
    (select count(*) from build_runs where project_id = space),
    (select count(*) from agent_jobs where project_id = space),
    (select count(*) from automations where project_id = space),
    (select count(*) from agent_context_cards where project_id = space),
    (select count(*) from conversation_send_queue where project_id = space),
    (select count(*) from conversation_message_stashes where project_id = space));
$$;
create function deleted_space_test_rows(shared integer, own integer) returns text language sql as $$
  select format('projects=%s environments=%s conversations=%s messages=%s prompts=%s runs=%s '
      || 'build_runs=%s jobs=%s automations=%s context_cards=%s send_queue=%s stashes=%s',
    shared, shared, shared, shared, shared, shared, shared, shared, own, own, own, own);
$$;
-- Signs in as a user for the rest of the transaction, the way a request does.
create function deleted_space_test_sign_in(reader uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', reader::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', reader, 'role', 'authenticated')::text, true);
end; $$;
-- Signs in as a user and checks what they read of a space.
create function deleted_space_test_reads(reader uuid, space uuid, expected text, label text)
returns void language plpgsql as $$
declare actual text;
begin
  perform deleted_space_test_sign_in(reader);
  actual := deleted_space_test_visible(space);
  if actual is distinct from expected then
    raise exception 'deleted space test failed: % (read %, expected %)', label, actual, expected;
  end if;
end; $$;
grant execute on function deleted_space_test_assert(boolean,text), deleted_space_test_visible(uuid),
  deleted_space_test_rows(integer,integer), deleted_space_test_sign_in(uuid),
  deleted_space_test_reads(uuid,uuid,text,text) to authenticated, service_role;

-- Hosted Supabase grants these to the browser and service roles and scopes rows
-- with RLS; mirror that here so the reads below go through the policies exactly
-- as a signed-in client's would.
do $$ begin
  if not has_schema_privilege('authenticated','auth','usage') then
    grant usage on schema auth to authenticated, service_role;
  end if;
end $$;
grant select on projects, project_environments, conversations, conversation_messages, prompts, runs,
  build_runs, agent_jobs, automations, agent_context_cards, conversation_send_queue,
  conversation_message_stashes to authenticated, service_role;

set local role authenticated;

-- While the space is live, its owner, a member and a team member read every
-- project-wide row and their own rows; someone outside it reads nothing.
select deleted_space_test_reads('70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000011',
  deleted_space_test_rows(1,1),'the owner reads a live space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000011',
  deleted_space_test_rows(1,1),'a member reads a live space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000003','70000000-0000-0000-0000-000000000011',
  deleted_space_test_rows(1,1),'a team member reads a live space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000004','70000000-0000-0000-0000-000000000011',
  deleted_space_test_rows(0,0),'someone outside the space reads none of it');

-- The owner settles the onboarding choice and may change the space's picture,
-- as may the member.
select deleted_space_test_sign_in('70000000-0000-0000-0000-000000000001');
select deleted_space_test_assert(public.settle_getting_started_ai_choice(
    '70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000011'),
  'the owner settles the onboarding choice of a live space');
select deleted_space_test_assert(public.has_settled_getting_started_ai_choice(
    '70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000011'),
  'a live space''s settled onboarding choice reads as settled');
select deleted_space_test_assert(public.can_manage_identity_image(
    'spaces/70000000-0000-0000-0000-000000000011/7a000000-0000-4000-8000-000000000001.png'),
  'the owner may change a live space''s picture');
select deleted_space_test_sign_in('70000000-0000-0000-0000-000000000002');
select deleted_space_test_assert(public.can_manage_identity_image(
    'spaces/70000000-0000-0000-0000-000000000011/7a000000-0000-4000-8000-000000000002.png'),
  'a member may change a live space''s picture');

-- The space is deleted the way the controller deletes it.
reset role;
update projects set status = 'deleted' where id = '70000000-0000-0000-0000-000000000011';
set local role authenticated;

-- Now its owner, the member and the team member read none of it, not even
-- their own rows, while the team's other space stays readable.
select deleted_space_test_reads('70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000011',
  deleted_space_test_rows(0,0),'the owner reads nothing of a deleted space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000011',
  deleted_space_test_rows(0,0),'a member reads nothing of a deleted space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000003','70000000-0000-0000-0000-000000000011',
  deleted_space_test_rows(0,0),'a team member reads nothing of a deleted space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000012',
  deleted_space_test_rows(1,1),'the owner still reads the team''s live space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000012',
  deleted_space_test_rows(1,1),'a member still reads the team''s live space');
select deleted_space_test_reads('70000000-0000-0000-0000-000000000003','70000000-0000-0000-0000-000000000012',
  deleted_space_test_rows(1,1),'a team member still reads the team''s live space');

-- The helpers behind the policies agree, and the functions built on them refuse
-- the deleted space: the onboarding choice reads as unsettled and cannot be
-- settled again, and nobody may change its picture. The team's picture is
-- unaffected.
select deleted_space_test_sign_in('70000000-0000-0000-0000-000000000001');
select deleted_space_test_assert(not public.has_project_access('70000000-0000-0000-0000-000000000011')
    and not public.has_conversation_access('70000000-0000-0000-0000-000000000031')
    and public.has_project_access('70000000-0000-0000-0000-000000000012')
    and public.has_conversation_access('70000000-0000-0000-0000-000000000032'),
  'the access helpers refuse only the deleted space');
select deleted_space_test_assert(not public.has_settled_getting_started_ai_choice(
    '70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000011'),
  'a deleted space''s onboarding choice reads as unsettled');
do $$ begin
  begin
    perform public.settle_getting_started_ai_choice(
      '70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000011');
    raise exception 'deleted space test failed: the onboarding choice of a deleted space was settled';
  exception when insufficient_privilege then null; end;
end $$;
select deleted_space_test_assert(not public.can_manage_identity_image(
    'spaces/70000000-0000-0000-0000-000000000011/7a000000-0000-4000-8000-000000000003.png')
  and public.can_manage_identity_image(
    'spaces/70000000-0000-0000-0000-000000000012/7a000000-0000-4000-8000-000000000004.png')
  and public.can_manage_identity_image(
    'orgs/70000000-0000-0000-0000-000000000021/7a000000-0000-4000-8000-000000000005.png'),
  'only the deleted space''s picture is closed to its owner');
select deleted_space_test_sign_in('70000000-0000-0000-0000-000000000002');
select deleted_space_test_assert(not public.can_manage_identity_image(
    'spaces/70000000-0000-0000-0000-000000000011/7a000000-0000-4000-8000-000000000006.png'),
  'a member may not change a deleted space''s picture');

-- The service role still reads the deleted space, every user's rows included.
set local role service_role;
set local request.jwt.claim.sub = '';
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claims = '{"role":"service_role"}';
select deleted_space_test_assert(deleted_space_test_visible('70000000-0000-0000-0000-000000000011')
    = deleted_space_test_rows(1,3),
  'the service role reads every row of a deleted space');
select deleted_space_test_assert(public.has_project_access('70000000-0000-0000-0000-000000000011')
    and public.has_conversation_access('70000000-0000-0000-0000-000000000031'),
  'the access helpers still admit the service role to a deleted space');
rollback;
