-- Executed only by scripts/test-durable-notifications.py in its disposable cluster.
-- A person who invited someone, created and revoked an invite link and added a
-- participant can still be deleted: the records stay and forget who acted.
begin;
create function user_deletion_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'user deletion test failed: %', label; end if; end; $$;

insert into auth.users(id,email) values
  ('71000000-0000-0000-0000-000000000001','user-deletion-inviter@example.invalid'),
  ('71000000-0000-0000-0000-000000000002','user-deletion-invitee@example.invalid');
insert into organizations(id,slug,name) values
  ('71000000-0000-0000-0000-000000000021','user-deletion-fixture','User deletion');
insert into org_memberships(org_id,user_id,role) values
  ('71000000-0000-0000-0000-000000000021','71000000-0000-0000-0000-000000000001','owner');
insert into org_memberships(org_id,user_id,role,invited_by) values
  ('71000000-0000-0000-0000-000000000021','71000000-0000-0000-0000-000000000002','builder','71000000-0000-0000-0000-000000000001');
insert into org_invite_links(id,org_id,created_by,revoked_by,status) values
  ('71000000-0000-0000-0000-000000000031','71000000-0000-0000-0000-000000000021',
   '71000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000001','revoked');
insert into org_invitations(id,org_id,email,invited_by) values
  ('71000000-0000-0000-0000-000000000041','71000000-0000-0000-0000-000000000021','someone@example.invalid','71000000-0000-0000-0000-000000000001');

delete from auth.users where id = '71000000-0000-0000-0000-000000000001';

select user_deletion_test_assert(
  (select created_by is null and revoked_by is null from org_invite_links where id = '71000000-0000-0000-0000-000000000031'),
  'the invite link stays and forgets its creator');
select user_deletion_test_assert(
  (select invited_by is null from org_invitations where id = '71000000-0000-0000-0000-000000000041'),
  'the invitation stays and forgets who sent it');
select user_deletion_test_assert(
  (select invited_by is null from org_memberships where user_id = '71000000-0000-0000-0000-000000000002'),
  'the invitee keeps their membership');
rollback;
