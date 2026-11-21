-- Credential rows are written only by the controller. As the signed-in owner,
-- through PostgREST's roles, it checks that a credential can be read but not
-- inserted, changed (its endpoint metadata, its revocation) or deleted: first
-- with the privileges as migrated, then with the writes granted back, so the
-- select-only "user credentials self" policy refuses them on its own.
-- Executed by the controller test user_credential_sql_fixture_refuses_client_writes
-- and by scripts/test-durable-notifications.py in its disposable cluster. Both
-- run it inside a transaction they roll back, so this file never begins or
-- ends a transaction itself.
create function user_credential_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'user credential test failed: %',label; end if; end; $$;

insert into auth.users(id,email) values
  ('60000000-0000-0000-0000-000000000001','credential-reader@example.invalid');
insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64,metadata) values
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000001',
   'openai_api_key','fixture','fixture','{"provider":"openai"}');

select user_credential_test_assert(
  has_table_privilege('authenticated','public.user_credentials','SELECT')
  and not has_table_privilege('authenticated','public.user_credentials',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  and not has_table_privilege('anon','public.user_credentials',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'the browser roles hold no privilege but the signed-in role''s read');
-- The grants themselves too, on the table and its columns: has_table_privilege
-- sees no column grant, and asking it about MAINTAIN fails on PostgreSQL 15.
select user_credential_test_assert((
  select coalesce(array_agg(g.entry order by g.entry), '{}') = array['authenticated:SELECT']
  from (
    select case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end
             || ':' || a.privilege_type as entry
    from pg_class c, aclexplode(c.relacl) a
    where c.oid = 'public.user_credentials'::regclass
      and a.grantee in ('anon'::regrole, 'authenticated'::regrole, 0)
    union all
    select case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end
             || ':' || a.privilege_type || '(' || att.attname || ')'
    from pg_attribute att, aclexplode(att.attacl) a
    where att.attrelid = 'public.user_credentials'::regclass
      and a.grantee in ('anon'::regrole, 'authenticated'::regrole, 0)
  ) g),
  'the table and its columns grant the browser roles only the signed-in read');
-- Nor through a role they belong to, which those entries leave out:
-- has_any_column_privilege follows inherited membership, and sees a
-- column's grants as well as the table's.
select user_credential_test_assert(
  not has_any_column_privilege('authenticated','public.user_credentials',
    'INSERT,UPDATE,REFERENCES')
  and not has_any_column_privilege('anon','public.user_credentials',
    'SELECT,INSERT,UPDATE,REFERENCES'),
  'no role the browser roles belong to grants them a column');
select user_credential_test_assert((select array_agg(cmd::text order by cmd::text) = array['SELECT']
  from pg_policies where schemaname='public' and tablename='user_credentials'
    and policyname='user credentials self'),
  'the owner policy only reads');

do $$ begin
  if not has_schema_privilege('authenticated','auth','usage') then
    grant usage on schema auth to authenticated;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}';

select user_credential_test_assert((select count(*)=1 from user_credentials
  where id='60000000-0000-0000-0000-000000000011'),'the owner reads their credential');

do $$ begin
  begin
    insert into user_credentials(user_id,kind,nonce_b64,ciphertext_b64) values
      ('60000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture');
    raise exception 'browser insert accepted';
  exception when insufficient_privilege then null; end;
  begin
    update user_credentials
      set metadata='{"provider":"openai","upstream_endpoint":"http://169.254.169.254/"}'
      where id='60000000-0000-0000-0000-000000000011';
    raise exception 'browser update accepted';
  exception when insufficient_privilege then null; end;
  begin
    delete from user_credentials where id='60000000-0000-0000-0000-000000000011';
    raise exception 'browser delete accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- With the writes granted back, the policy alone still refuses them: an
-- insert fails its check and an update or delete finds no row it may change.
grant insert, update, delete on public.user_credentials to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$ begin
  begin
    insert into user_credentials(user_id,kind,nonce_b64,ciphertext_b64) values
      ('60000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture');
    raise exception 'browser insert accepted by the policy';
  exception when insufficient_privilege then null; end;
end $$;
update user_credentials
  set metadata='{"provider":"openai","upstream_endpoint":"http://169.254.169.254/"}',
      revoked_at=null
  where id='60000000-0000-0000-0000-000000000011';
delete from user_credentials where id='60000000-0000-0000-0000-000000000011';
reset role;

select user_credential_test_assert((select metadata='{"provider":"openai"}'::jsonb
  from user_credentials where id='60000000-0000-0000-0000-000000000011'),
  'the credential row is unchanged and still there');
select user_credential_test_assert((select count(*)=1 from user_credentials
  where user_id='60000000-0000-0000-0000-000000000001'),'no row was added');
