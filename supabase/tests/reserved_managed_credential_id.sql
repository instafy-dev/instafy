-- Executed only by scripts/test-durable-notifications.py in its disposable cluster.
-- The managed credential id is reserved for the platform lane: no user_credentials
-- row may take it, while ordinary credential rows keep working. The check ships
-- NOT VALID; validating it is left to a later migration. Everything here runs in
-- one transaction that is rolled back.
begin;
create function reserved_credential_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'reserved credential test failed: %',label; end if; end; $$;
insert into auth.users(id,email) values
  ('40000000-0000-0000-0000-000000000001','credential-owner@example.invalid');
-- Hosted Supabase grants these to the signed-in role and scopes rows with RLS;
-- mirror that here so the checks below run through the "user credentials self"
-- policy exactly as a signed-in client would.
do $$ begin
  if not has_schema_privilege('authenticated','auth','usage') then
    grant usage on schema auth to authenticated;
  end if;
end $$;
grant select, insert, update on public.user_credentials to authenticated;

select reserved_credential_test_assert((select convalidated=false from pg_constraint
  where conname='user_credentials_id_not_reserved' and conrelid='public.user_credentials'::regclass),
  'the reserved id check exists and is not validated');

set local role authenticated;
set local request.jwt.claim.sub = '40000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"40000000-0000-0000-0000-000000000001","role":"authenticated"}';

-- The signed-in owner still inserts ordinary credentials, with an explicit id or the default.
insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64,is_default) values
  ('40000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture',true);
insert into user_credentials(user_id,kind,nonce_b64,ciphertext_b64) values
  ('40000000-0000-0000-0000-000000000001','codex_auth_json','fixture','fixture');
select reserved_credential_test_assert((select count(*)=2 from user_credentials
  where user_id='40000000-0000-0000-0000-000000000001'),'ordinary credential inserts work');
update user_credentials set label='renamed' where id='40000000-0000-0000-0000-000000000010';
select reserved_credential_test_assert((select label='renamed' from user_credentials
  where id='40000000-0000-0000-0000-000000000010'),'ordinary credential updates work');

-- The reserved id is refused by the check itself (not by row level security),
-- on insert, on upsert and when an existing row is renumbered.
do $$ begin
  begin
    insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64,is_default) values
      ('4d414e41-4745-4441-8949-4e5354414659','40000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture',false);
    raise exception 'reserved id insert accepted';
  exception when check_violation then null; end;
  begin
    insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64) values
      ('4d414e41-4745-4441-8949-4e5354414659','40000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture')
      on conflict (id) do update set label=excluded.label;
    raise exception 'reserved id upsert accepted';
  exception when check_violation then null; end;
  begin
    update user_credentials set id='4d414e41-4745-4441-8949-4e5354414659'
      where id='40000000-0000-0000-0000-000000000010';
    raise exception 'reserved id update accepted';
  exception when check_violation then null; end;
end $$;
reset role;

-- Server-side tooling cannot take the id either.
do $$ begin
  begin
    insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64) values
      ('4d414e41-4745-4441-8949-4e5354414659','40000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture');
    raise exception 'reserved id insert accepted for the table owner';
  exception when check_violation then null; end;
end $$;
select reserved_credential_test_assert((select count(*)=0 from user_credentials
  where id='4d414e41-4745-4441-8949-4e5354414659'),'no row holds the reserved id');
select reserved_credential_test_assert((select count(*)=2 from user_credentials
  where user_id='40000000-0000-0000-0000-000000000001'),'refused writes left ordinary rows intact');

-- For reference when the check is validated later: a row stored before the
-- check existed, as the default and pinned to an agent. With the NOT VALID
-- check in place no update of it is accepted (revoking included), VALIDATE
-- fails, and deleting the row (which clears agent references to it) is what
-- lets the check validate. All of it is rolled back below.
alter table user_credentials drop constraint user_credentials_id_not_reserved;
update user_credentials set is_default=false where id='40000000-0000-0000-0000-000000000010';
insert into user_credentials(id,user_id,kind,nonce_b64,ciphertext_b64,is_default) values
  ('4d414e41-4745-4441-8949-4e5354414659','40000000-0000-0000-0000-000000000001','openai_api_key','fixture','fixture',true);
insert into user_agents(id,user_id,credential_id,provider,handle,avatar_seed) values
  ('40000000-0000-0000-0000-000000000020','40000000-0000-0000-0000-000000000001',
   '4d414e41-4745-4441-8949-4e5354414659','openai','stored','stored');
alter table user_credentials add constraint user_credentials_id_not_reserved
  check (id <> '4d414e41-4745-4441-8949-4e5354414659'::uuid) not valid;
do $$ begin
  begin
    update user_credentials set revoked_at=now(), is_default=false
      where id='4d414e41-4745-4441-8949-4e5354414659';
    raise exception 'stored reserved row revoked';
  exception when check_violation then null; end;
  begin
    update user_credentials set is_default=false
      where user_id='40000000-0000-0000-0000-000000000001' and is_default;
    raise exception 'stored reserved row default cleared';
  exception when check_violation then null; end;
  begin
    alter table user_credentials validate constraint user_credentials_id_not_reserved;
    raise exception 'check validated over a stored reserved row';
  exception when check_violation then null; end;
end $$;
delete from user_credentials where id='4d414e41-4745-4441-8949-4e5354414659';
select reserved_credential_test_assert((select credential_id is null from user_agents
  where id='40000000-0000-0000-0000-000000000020'),'deleting the stored row clears agent references');
alter table user_credentials validate constraint user_credentials_id_not_reserved;
select reserved_credential_test_assert((select convalidated from pg_constraint
  where conname='user_credentials_id_not_reserved' and conrelid='public.user_credentials'::regclass),
  'the check validates once the stored row is deleted');
rollback;
