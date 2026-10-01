-- Executed only by scripts/test-durable-notifications.py in its disposable cluster.
-- An agent pins only a credential its owner holds (user_agents_credential_owner),
-- while owners keep pinning, changing and clearing their own credentials.
-- Everything here runs in one transaction that is rolled back.
begin;
create function agent_credential_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'agent credential test failed: %',label; end if; end; $$;
insert into auth.users(id,email) values
  ('50000000-0000-0000-0000-000000000001','agent-owner@example.invalid'),
  ('50000000-0000-0000-0000-000000000002','other-owner@example.invalid');
insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64) values
  ('50000000-0000-0000-0000-000000000011','50000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture'),
  ('50000000-0000-0000-0000-000000000012','50000000-0000-0000-0000-000000000001','codex_auth_json','fixture','fixture'),
  ('50000000-0000-0000-0000-000000000013','50000000-0000-0000-0000-000000000002','openai_api_key','fixture','fixture');
-- Hosted Supabase grants these to the signed-in role and scopes rows with RLS;
-- mirror that here so the checks below run through the "user agents self"
-- policy exactly as a signed-in client would.
do $$ begin
  if not has_schema_privilege('authenticated','auth','usage') then
    grant usage on schema auth to authenticated;
  end if;
end $$;
grant select, insert, update on public.user_credentials, public.user_agents to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '50000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"50000000-0000-0000-0000-000000000001","role":"authenticated"}';

-- The owner pins an own credential, switches to another, clears the pin and
-- edits the agent.
insert into user_agents(id,user_id,credential_id,provider,handle,avatar_seed) values
  ('50000000-0000-0000-0000-000000000021','50000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000011','openai','own','own');
update user_agents set credential_id='50000000-0000-0000-0000-000000000012'
  where id='50000000-0000-0000-0000-000000000021';
update user_agents set credential_id=null where id='50000000-0000-0000-0000-000000000021';
update user_agents set credential_id='50000000-0000-0000-0000-000000000011', display_name='Own'
  where id='50000000-0000-0000-0000-000000000021';
select agent_credential_test_assert((select credential_id='50000000-0000-0000-0000-000000000011'
  and display_name='Own' from user_agents where id='50000000-0000-0000-0000-000000000021'),
  'owners pin, switch and clear their own credentials');

-- Another user's credential is refused on insert and on update.
do $$ begin
  begin
    insert into user_agents(id,user_id,credential_id,provider,handle,avatar_seed) values
      ('50000000-0000-0000-0000-000000000022','50000000-0000-0000-0000-000000000001',
       '50000000-0000-0000-0000-000000000013','openai','other','other');
    raise exception 'agent insert pinned a credential its owner does not hold';
  exception when foreign_key_violation then null; end;
  begin
    update user_agents set credential_id='50000000-0000-0000-0000-000000000013'
      where id='50000000-0000-0000-0000-000000000021';
    raise exception 'agent update pinned a credential its owner does not hold';
  exception when foreign_key_violation then null; end;
end $$;
reset role;

-- Server-side writes follow the same rule, including moving a pinned agent.
do $$ begin
  begin
    update user_agents set credential_id='50000000-0000-0000-0000-000000000013'
      where id='50000000-0000-0000-0000-000000000021';
    raise exception 'owner-role update pinned a credential its owner does not hold';
  exception when foreign_key_violation then null; end;
  begin
    update user_agents set user_id='50000000-0000-0000-0000-000000000002'
      where id='50000000-0000-0000-0000-000000000021';
    raise exception 'agent moved away from the owner of its credential';
  exception when foreign_key_violation then null; end;
end $$;
select agent_credential_test_assert((select credential_id='50000000-0000-0000-0000-000000000011'
  and user_id='50000000-0000-0000-0000-000000000001' from user_agents
  where id='50000000-0000-0000-0000-000000000021'),'refused writes left the agent intact');

-- Deleting a pinned credential still clears the pin.
delete from user_credentials where id='50000000-0000-0000-0000-000000000011';
select agent_credential_test_assert((select credential_id is null from user_agents
  where id='50000000-0000-0000-0000-000000000021'),'deleting a credential clears pins to it');
rollback;
