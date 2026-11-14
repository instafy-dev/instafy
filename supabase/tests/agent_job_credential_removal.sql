-- A job queued or leased on a person's own AI connection never becomes a
-- platform job: deleting the connection's row, directly or by deleting the
-- person, fails it (agent_jobs_fail_on_credential_removal). Executed by the
-- controller test agent_job_credential_removal_sql_fixture_passes and by
-- scripts/test-durable-notifications.py in its disposable cluster. Both run it
-- inside a transaction they roll back, so this file never begins or ends a
-- transaction itself.
create function pg_temp.credential_removal_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'credential removal test failed: %', label; end if; end; $$;

insert into auth.users(id,email) values
  ('72000000-0000-0000-0000-000000000001','credential-removal-owner@example.invalid'),
  ('72000000-0000-0000-0000-000000000002','credential-removal-leaver@example.invalid');
insert into organizations(id,slug,name) values
  ('72000000-0000-0000-0000-000000000021','credential-removal-fixture','Credential removal');
insert into projects(id,org_id,owner_user_id) values
  ('72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000021',
   '72000000-0000-0000-0000-000000000001');
insert into conversations(id,project_id,created_by,visibility) values
  ('72000000-0000-0000-0000-000000000041','72000000-0000-0000-0000-000000000031',
   '72000000-0000-0000-0000-000000000001','public');
insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64) values
  -- A: deleted directly. B: kept. C: the leaver's, deleted with them.
  ('72000000-0000-0000-0000-00000000000a','72000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture'),
  ('72000000-0000-0000-0000-00000000000b','72000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture'),
  ('72000000-0000-0000-0000-00000000000c','72000000-0000-0000-0000-000000000002','codex_auth_json','fixture','fixture');
insert into runs(id,project_id,conversation_id,run_type) values
  ('72000000-0000-0000-0000-000000000051','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041','prompt'),
  ('72000000-0000-0000-0000-000000000052','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041','prompt');
insert into agent_jobs(id,project_id,conversation_id,run_id,credential_id,intent,status,
                       leased_at,lease_expires_at,lease_attempts,leased_by_runtime_id,completed_at) values
  -- On A: queued, leased, finished, and a terminal command.
  ('72000000-0000-0000-0000-000000000061','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   '72000000-0000-0000-0000-000000000051','72000000-0000-0000-0000-00000000000a','feature','queued',null,null,0,null,null),
  ('72000000-0000-0000-0000-000000000062','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   '72000000-0000-0000-0000-000000000052','72000000-0000-0000-0000-00000000000a','feature','leased',
   now(),now()+interval '2 minutes',1,null,null),
  ('72000000-0000-0000-0000-000000000063','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   null,'72000000-0000-0000-0000-00000000000a','feature','completed',null,null,1,null,now()-interval '1 hour'),
  ('72000000-0000-0000-0000-000000000064','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   null,'72000000-0000-0000-0000-00000000000a','terminal_command','queued',null,null,0,null,null),
  -- On B, kept; a platform job; the leaver's job on C.
  ('72000000-0000-0000-0000-000000000065','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   null,'72000000-0000-0000-0000-00000000000b','feature','queued',null,null,0,null,null),
  ('72000000-0000-0000-0000-000000000066','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   null,null,'feature','queued',null,null,0,null,null),
  ('72000000-0000-0000-0000-000000000067','72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   null,'72000000-0000-0000-0000-00000000000c','feature','queued',null,null,0,null,null);

-- The leased job holds a live turn with an input it has not acknowledged.
insert into runtimes(id,project_id,status) values
  ('72000000-0000-0000-0000-000000000071','72000000-0000-0000-0000-000000000031','ready');
update agent_jobs set leased_by_runtime_id='72000000-0000-0000-0000-000000000071',
    active_input_ready_runtime_id='72000000-0000-0000-0000-000000000071',
    active_input_ready_expires_at=now()+interval '1 minute',
    active_input_ready_turn_id='turn-1'
  where id='72000000-0000-0000-0000-000000000062';
insert into agent_job_inputs(project_id,conversation_id,job_id,client_send_id,lease_attempt,
                             target_turn_id,sequence,request) values
  ('72000000-0000-0000-0000-000000000031','72000000-0000-0000-0000-000000000041',
   '72000000-0000-0000-0000-000000000062','send-1',1,'turn-1',1,'{}');

select pg_temp.credential_removal_assert(
  not has_function_privilege('authenticated','public.fail_agent_job_on_credential_removal()','EXECUTE')
  and not has_function_privilege('anon','public.fail_agent_job_on_credential_removal()','EXECUTE'),
  'the browser roles cannot call the trigger function');

-- Deleting a credential row, as server-side tooling or the table owner can.
delete from user_credentials where id='72000000-0000-0000-0000-00000000000a';

select pg_temp.credential_removal_assert((select status='failed' and outcome='failed'
    and credential_id is null and credential_removed_at is not null and completed_at is not null
    and error_message like 'credential not found:%'
  from agent_jobs where id='72000000-0000-0000-0000-000000000061'),
  'a queued job on the deleted credential failed');
select pg_temp.credential_removal_assert((select status='failed' and credential_id is null
    and credential_removed_at is not null and lease_expires_at is null and lease_attempts=1
  from agent_jobs where id='72000000-0000-0000-0000-000000000062'),
  'a leased job on the deleted credential failed and its lease ended');
select pg_temp.credential_removal_assert((select j.active_input_ready_runtime_id is null
    and i.status='rejected' and i.rejected_by='controller'
  from agent_jobs j join agent_job_inputs i on i.job_id=j.id
  where j.id='72000000-0000-0000-0000-000000000062'),
  'the failed lease rejects the input its turn never acknowledged');
select pg_temp.credential_removal_assert((select status='completed' and credential_id is null
    and credential_removed_at is null and completed_at < now()
  from agent_jobs where id='72000000-0000-0000-0000-000000000063'),
  'a finished job only forgets the credential');
select pg_temp.credential_removal_assert((select status='queued' and credential_id is null
    and credential_removed_at is null
  from agent_jobs where id='72000000-0000-0000-0000-000000000064'),
  'a terminal command needs no AI and stays queued');
select pg_temp.credential_removal_assert((select status='queued'
    and credential_id='72000000-0000-0000-0000-00000000000b'
  from agent_jobs where id='72000000-0000-0000-0000-000000000065'),
  'a job on another credential is untouched');
select pg_temp.credential_removal_assert((select status='queued' and credential_id is null
    and credential_removed_at is null
  from agent_jobs where id='72000000-0000-0000-0000-000000000066'),
  'a platform job is untouched');
-- The lane a lease would read: no live AI job is left without its credential
-- except the platform job, which never had one.
select pg_temp.credential_removal_assert((select array_agg(id order by id)=array['72000000-0000-0000-0000-000000000066']::uuid[]
  from agent_jobs where project_id='72000000-0000-0000-0000-000000000031'
    and status in ('queued','leased') and credential_id is null
    and lower(btrim(coalesce(intent,'')) collate "C") <> 'terminal_command'),
  'no deleted credential left a platform job behind');

-- Deleting the person deletes their credentials, and fails their job.
delete from auth.users where id='72000000-0000-0000-0000-000000000002';
select pg_temp.credential_removal_assert((select status='failed' and credential_id is null
    and credential_removed_at is not null
  from agent_jobs where id='72000000-0000-0000-0000-000000000067'),
  'deleting a person fails the jobs queued on their credentials');

-- Clearing the column by hand is caught the same way.
update agent_jobs set credential_id=null where id='72000000-0000-0000-0000-000000000065';
select pg_temp.credential_removal_assert((select status='failed' and credential_removed_at is not null
  from agent_jobs where id='72000000-0000-0000-0000-000000000065'),
  'clearing a live job''s credential fails it');

-- An update that ends a job and clears its credential is left as it says.
insert into agent_jobs(id,project_id,credential_id,intent,status) values
  ('72000000-0000-0000-0000-000000000068','72000000-0000-0000-0000-000000000031',
   '72000000-0000-0000-0000-00000000000b','feature','leased');
update agent_jobs set credential_id=null, status='canceled', outcome='canceled'
  where id='72000000-0000-0000-0000-000000000068';
select pg_temp.credential_removal_assert((select status='canceled' and credential_removed_at is null
  from agent_jobs where id='72000000-0000-0000-0000-000000000068'),
  'a job ended in the same statement keeps its own outcome');

-- The controller and the runtime read an intent as a terminal command after
-- folding ASCII case only, so the trigger must too. pg_c_utf8, like the libc
-- collations a database may default to, lowers 'İ' (U+0130) to 'i': under it
-- 'TERMİNAL_COMMAND', an AI turn to the controller, must still fail, and an
-- ASCII 'Terminal_Command' must still stay queued. The trigger function runs
-- on a temporary table with the columns it reads, whose intent uses that
-- collation, since this database's own may not fold 'İ'. A database that is
-- not UTF-8, such as the SQL_ASCII cluster of
-- scripts/test-durable-notifications.py, has no collation that folds it, so
-- the case cannot arise there.
do $$
begin
  if getdatabaseencoding() <> 'UTF8' then
    return;
  end if;
  perform pg_temp.credential_removal_assert(
    lower('TERMİNAL_COMMAND' collate pg_c_utf8) = 'terminal_command',
    'pg_c_utf8 folds İ, so the case below can fail');
  create temporary table credential_removal_folded_intents(
    id int primary key, credential_id uuid, status text, intent text collate pg_c_utf8,
    outcome text, error_message text, completed_at timestamptz,
    lease_expires_at timestamptz, credential_removed_at timestamptz);
  create trigger credential_removal_folded_intents_fail
    before update of credential_id on credential_removal_folded_intents
    for each row execute function public.fail_agent_job_on_credential_removal();
  insert into credential_removal_folded_intents(id,credential_id,status,intent) values
    (1,gen_random_uuid(),'queued','TERMİNAL_COMMAND'),
    (2,gen_random_uuid(),'queued','Terminal_Command');
  update credential_removal_folded_intents set credential_id=null;
  perform pg_temp.credential_removal_assert((select status='failed' and credential_removed_at is not null
    from credential_removal_folded_intents where id=1),
    'an intent only a Unicode case fold reads as a terminal command is an AI turn');
  perform pg_temp.credential_removal_assert((select status='queued' and credential_removed_at is null
    from credential_removal_folded_intents where id=2),
    'a terminal command in any ASCII case stays queued');
end $$;
