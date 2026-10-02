-- Executed by scripts/test-durable-notifications.py in its disposable cluster, after
-- storage_stub.sql adds the Storage tables and 20261002140000_chat_attachments.sql is
-- rerun to provision the private chat-attachments bucket and its policies. As the
-- signed-in and anonymous roles, through the storage.objects row-level security
-- policies, it checks who may upload, read and delete an attachment, that names are
-- restricted, and that nobody may update one. Everything here runs in one
-- transaction that is rolled back.
begin;
create function chat_attachment_test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'chat attachment test failed: %',label; end if; end; $$;

select chat_attachment_test_assert((select not public and file_size_limit = 20971520
    and allowed_mime_types @> array['image/png','image/jpeg','image/webp','image/gif','text/plain','text/markdown']
    and cardinality(allowed_mime_types) = 6
  from storage.buckets where id = 'chat-attachments'),
  'the bucket is private, capped at 20 MiB and limited to images and text');
select chat_attachment_test_assert((select array_agg(cmd::text order by cmd::text)
    = array['DELETE','INSERT','SELECT']
  from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'chat attachments %'),
  'chat attachments have upload, read and delete policies and no update policy');

insert into auth.users(id,email) values
  ('60000000-0000-0000-0000-000000000001','space-owner@example.invalid'),
  ('60000000-0000-0000-0000-000000000002','space-viewer@example.invalid'),
  ('60000000-0000-0000-0000-000000000003','outsider@example.invalid');
insert into projects(id,owner_user_id) values
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000001'),
  ('60000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000001');
insert into project_memberships(project_id,user_id,role) values
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000002','viewer');
-- An attachment the owner stored while the second space was live, before it was deleted.
insert into storage.objects(bucket_id,name,owner) values
  ('chat-attachments','60000000-0000-0000-0000-000000000012/6a000000-0000-4000-8000-000000000001.png',
   '60000000-0000-0000-0000-000000000001');
update projects set status = 'deleted' where id = '60000000-0000-0000-0000-000000000012';
-- Another bucket's object, to show the policies stay inside chat-attachments.
insert into storage.buckets(id,name,public) values ('chat-attachments-test-other','chat-attachments-test-other',false);
insert into storage.objects(bucket_id,name,owner) values
  ('chat-attachments-test-other','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000009.png',
   '60000000-0000-0000-0000-000000000001');

-- An upload the policies must refuse, as the role and user already set. Storage
-- records the signed-in user as the owner, so the fixtures do the same.
create function chat_attachment_test_refused(object_name text, label text) returns void language plpgsql as $$
begin
  begin
    insert into storage.objects(bucket_id,name,owner) values ('chat-attachments', object_name, auth.uid());
  exception when insufficient_privilege then return; end;
  raise exception 'chat attachment test failed: % was accepted', label;
end; $$;
-- How many chat attachments a delete as the current role and user removes.
create function chat_attachment_test_deleted(pattern text) returns bigint language plpgsql as $$
declare removed bigint;
begin
  delete from storage.objects where bucket_id = 'chat-attachments' and name like pattern;
  get diagnostics removed = row_count;
  return removed;
end; $$;
grant execute on function chat_attachment_test_assert(boolean,text), chat_attachment_test_refused(text,text),
  chat_attachment_test_deleted(text) to anon, authenticated;

-- Hosted Supabase grants these to the browser roles and scopes rows with RLS.
do $$ begin
  if not has_schema_privilege('authenticated','auth','usage') then
    grant usage on schema auth to anon, authenticated;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}';

-- The owner uploads an image and a text file and reads them back.
insert into storage.objects(bucket_id,name,owner) values
  ('chat-attachments','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png',auth.uid()),
  ('chat-attachments','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000003.md',auth.uid());
select chat_attachment_test_assert((select count(*) = 2 from storage.objects
  where bucket_id = 'chat-attachments' and name like '60000000-0000-0000-0000-000000000011/%'),
  'a member uploads and reads attachments of a live space');

-- Names outside '<projectId>/<uuid>.<png|jpg|webp|gif|txt|md>' are refused.
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000004.exe', 'an executable extension');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000004.svg', 'an SVG');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000004.PNG', 'an upper-case extension');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6A000000-0000-4000-8000-000000000004.png', 'an upper-case name');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/screenshot.png', 'a free-form name');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/../6a000000-0000-4000-8000-000000000004.png', 'a traversal');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/x/6a000000-0000-4000-8000-000000000004.png', 'an extra segment');
select chat_attachment_test_refused('6a000000-0000-4000-8000-000000000004.png', 'a name without a space');
select chat_attachment_test_refused('6000-0000-0000-0000-0000-0000-0000-00000011/6a000000-0000-4000-8000-000000000004.png', 'another spelling of the space id');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000099/6a000000-0000-4000-8000-000000000004.png', 'a space that does not exist');
-- A deleted space takes uploads, reads and deletes away from everyone, its owner
-- included; the controller purges its objects with the service role.
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000012/6a000000-0000-4000-8000-000000000004.png', 'an upload to a deleted space');
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where name like '60000000-0000-0000-0000-000000000012/%'), 'a deleted space''s attachment is unreadable');
select chat_attachment_test_assert(chat_attachment_test_deleted('60000000-0000-0000-0000-000000000012/%') = 0,
  'the uploader cannot delete an attachment of a deleted space');
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments-test-other'), 'the read policy covers only chat-attachments');

-- Objects are immutable: no update or upsert, even by the uploader.
update storage.objects set name = '60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000005.png'
  where name = '60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png';
do $$ begin
  begin
    insert into storage.objects(bucket_id,name,owner) values
      ('chat-attachments','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png',auth.uid())
      on conflict (bucket_id,name) do update set name = excluded.name;
    raise exception 'chat attachment test failed: an upsert was accepted';
  exception when insufficient_privilege then null; end;
end $$;
select chat_attachment_test_assert((select count(*) = 2 from storage.objects
  where bucket_id = 'chat-attachments'
    and name in ('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png',
                 '60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000003.md')),
  'update and upsert leave attachments unchanged');

-- A viewer member reads and uploads too: access is per space. They delete their
-- own upload, never someone else's.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000002","role":"authenticated"}';
select chat_attachment_test_assert((select count(*) = 2 from storage.objects
  where bucket_id = 'chat-attachments'), 'a member reads the space''s attachments');
insert into storage.objects(bucket_id,name,owner) values
  ('chat-attachments','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000006.txt',auth.uid());
select chat_attachment_test_assert(chat_attachment_test_deleted('%.png') = 0
    and chat_attachment_test_deleted('%.md') = 0,
  'a member cannot delete another member''s attachment');
select chat_attachment_test_assert(chat_attachment_test_deleted('%.txt') = 1,
  'a member deletes their own attachment');

-- A signed-in non-member neither reads, uploads nor deletes.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000003","role":"authenticated"}';
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments'), 'a non-member reads no attachment');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000007.png', 'a non-member upload');
select chat_attachment_test_assert(chat_attachment_test_deleted('%') = 0, 'a non-member deletes no attachment');
reset role;

-- Anonymous requests have no policy at all.
set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{"role":"anon"}';
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments'), 'anon reads no attachment');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000008.png', 'an anonymous upload');
select chat_attachment_test_assert(chat_attachment_test_deleted('%') = 0, 'anon deletes no attachment');
reset role;

-- The uploader deletes their own text file.
set local role authenticated;
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}';
select chat_attachment_test_assert(chat_attachment_test_deleted('%.md') = 1, 'the uploader deletes their own attachment');
reset role;

select chat_attachment_test_assert((select array_agg(name order by name) from storage.objects
    where bucket_id = 'chat-attachments')
  = array['60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png',
          '60000000-0000-0000-0000-000000000012/6a000000-0000-4000-8000-000000000001.png'],
  'exactly the accepted uploads that nobody deleted remain');
select chat_attachment_test_assert(not has_function_privilege('anon',
  'public.can_access_chat_attachment(text)', 'execute'), 'anon cannot call the access function');
select chat_attachment_test_assert(has_function_privilege('authenticated',
  'public.can_access_chat_attachment(text)', 'execute'), 'signed-in users call the access function');
rollback;
