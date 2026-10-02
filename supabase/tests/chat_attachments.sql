-- The private chat-attachments bucket and its storage.objects policies. As the
-- signed-in and anonymous roles, it checks who may upload, read and delete an
-- attachment, that names are restricted to one spelling per space, and that
-- nobody may update one.
-- Executed by the controller test chat_attachment_sql_fixture_passes_on_storage
-- against Supabase Storage's own migrated schema, and by
-- scripts/test-durable-notifications.py in its disposable cluster after
-- storage_stub.sql. Both run it inside a transaction they roll back, so this
-- file never begins or ends a transaction itself.
-- Each request below is made the way Storage makes it: the role, the user's
-- claims and storage.allow_delete_query are set for the transaction, and an
-- upload records the user in owner_id and, for a uuid, in the deprecated owner.
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

-- 01 owns both spaces. In the first space, 02 is a viewer and 04 a builder, and
-- in its team 05 is a builder and 06 a viewer. 03 is in neither.
insert into auth.users(id,email) values
  ('60000000-0000-0000-0000-000000000001','space-owner@example.invalid'),
  ('60000000-0000-0000-0000-000000000002','space-viewer@example.invalid'),
  ('60000000-0000-0000-0000-000000000003','outsider@example.invalid'),
  ('60000000-0000-0000-0000-000000000004','space-builder@example.invalid'),
  ('60000000-0000-0000-0000-000000000005','team-builder@example.invalid'),
  ('60000000-0000-0000-0000-000000000006','team-viewer@example.invalid');
insert into organizations(id,slug,name) values
  ('60000000-0000-0000-0000-000000000021','chat-attachments-fixture','Chat attachments');
insert into projects(id,org_id,owner_user_id) values
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000021','60000000-0000-0000-0000-000000000001');
insert into projects(id,owner_user_id) values
  ('60000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000001');
insert into project_memberships(project_id,user_id,role) values
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000002','viewer'),
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000004','builder');
insert into org_memberships(org_id,user_id,role) values
  ('60000000-0000-0000-0000-000000000021','60000000-0000-0000-0000-000000000005','builder'),
  ('60000000-0000-0000-0000-000000000021','60000000-0000-0000-0000-000000000006','viewer');
-- An attachment the owner stored while the second space was live, before it was deleted.
insert into storage.objects(bucket_id,name,owner,owner_id) values
  ('chat-attachments','60000000-0000-0000-0000-000000000012/6a000000-0000-4000-8000-000000000001.png',
   '60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001');
update projects set status = 'deleted' where id = '60000000-0000-0000-0000-000000000012';
-- Another bucket's object, to show the policies stay inside chat-attachments.
insert into storage.buckets(id,name,public) values ('chat-attachments-test-other','chat-attachments-test-other',false);
insert into storage.objects(bucket_id,name,owner,owner_id) values
  ('chat-attachments-test-other','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000009.png',
   '60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001');

-- An upload as the role and user already set.
create function chat_attachment_test_upload(object_name text) returns void language sql as $$
  insert into storage.objects(bucket_id,name,owner,owner_id)
    values ('chat-attachments', object_name, auth.uid(), auth.uid()::text);
$$;
-- An upload the policies must refuse.
create function chat_attachment_test_refused(object_name text, label text) returns void language plpgsql as $$
begin
  begin
    perform chat_attachment_test_upload(object_name);
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
grant execute on function chat_attachment_test_assert(boolean,text), chat_attachment_test_upload(text),
  chat_attachment_test_refused(text,text), chat_attachment_test_deleted(text) to anon, authenticated;

-- Hosted Supabase grants these to the browser roles and scopes rows with RLS.
do $$ begin
  if not has_schema_privilege('authenticated','auth','usage') then
    grant usage on schema auth to anon, authenticated;
  end if;
end $$;
-- Storage sets this for every request; without it Storage's own trigger refuses
-- any delete before the policies are consulted.
set local storage.allow_delete_query = 'true';

set local role authenticated;
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}';

-- The owner uploads an image and a text file and reads them back.
select chat_attachment_test_upload('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png');
select chat_attachment_test_upload('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000003.md');
select chat_attachment_test_assert((select count(*) = 2 from storage.objects
  where bucket_id = 'chat-attachments' and name like '60000000-0000-0000-0000-000000000011/%'),
  'the owner uploads and reads attachments of a live space');

-- Names outside '<projectId>/<uuid>.<png|jpg|webp|gif|txt|md>' are refused.
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000004.exe', 'an executable extension');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000004.svg', 'an SVG');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000004.PNG', 'an upper-case extension');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6A000000-0000-4000-8000-000000000004.png', 'an upper-case name');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/screenshot.png', 'a free-form name');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/../6a000000-0000-4000-8000-000000000004.png', 'a traversal');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/x/6a000000-0000-4000-8000-000000000004.png', 'an extra segment');
select chat_attachment_test_refused('6a000000-0000-4000-8000-000000000004.png', 'a name without a space');
select chat_attachment_test_refused('6000-0000-0000-0000-0000-0000-0000-00000011/6a000000-0000-4000-8000-000000000004.png', 'a malformed space id');
-- 36 characters that parse to the first space's id: only the one-spelling check
-- refuses it, which keeps every object of a space under '<projectId>/'.
select chat_attachment_test_refused('6000-0000-0000-0000-0000000000000011/6a000000-0000-4000-8000-000000000004.png', 'another spelling of the space id');
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
    insert into storage.objects(bucket_id,name,owner,owner_id) values
      ('chat-attachments','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png',
       auth.uid(),auth.uid()::text)
      on conflict (bucket_id,name) do update set name = excluded.name;
    raise exception 'chat attachment test failed: an upsert was accepted';
  exception when insufficient_privilege then null; end;
end $$;
select chat_attachment_test_assert((select count(*) = 2 from storage.objects
  where bucket_id = 'chat-attachments'
    and name in ('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png',
                 '60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000003.md')),
  'update and upsert leave attachments unchanged');

-- Storage names the uploader in owner_id; the deprecated owner is not needed.
insert into storage.objects(bucket_id,name,owner_id) values
  ('chat-attachments','60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-00000000000b.txt',auth.uid()::text);
select chat_attachment_test_assert(chat_attachment_test_deleted('%000b.txt') = 1,
  'owner_id alone identifies the uploader');

-- A session without a user is refused even for a live space's name.
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{"role":"authenticated"}';
select chat_attachment_test_assert(
  not public.can_access_chat_attachment('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png')
  and not public.can_write_chat_attachment('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png'),
  'a session without a user neither reads nor writes');
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments'), 'a session without a user reads no attachment');

-- A viewer of the space reads but neither uploads nor deletes: the controller
-- refuses them any chat write too.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000002","role":"authenticated"}';
select chat_attachment_test_assert((select count(*) = 2 from storage.objects
  where bucket_id = 'chat-attachments'), 'a space viewer reads the space''s attachments');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000006.txt', 'a space viewer upload');
select chat_attachment_test_assert(chat_attachment_test_deleted('%') = 0, 'a space viewer deletes no attachment');

-- A builder of the space uploads and deletes their own upload, never another
-- member's.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000004';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000004","role":"authenticated"}';
select chat_attachment_test_upload('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000006.txt');
select chat_attachment_test_upload('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-00000000000a.gif');
select chat_attachment_test_assert((select count(*) = 4 from storage.objects
  where bucket_id = 'chat-attachments'), 'a space builder uploads and reads');
select chat_attachment_test_assert(chat_attachment_test_deleted('%.png') = 0
    and chat_attachment_test_deleted('%.md') = 0,
  'a space builder cannot delete another member''s attachment');
select chat_attachment_test_assert(chat_attachment_test_deleted('%.txt') = 1,
  'a space builder deletes their own attachment');

-- Once made a viewer, the same member can no longer delete what they uploaded.
reset role;
update project_memberships set role = 'viewer'
  where project_id = '60000000-0000-0000-0000-000000000011' and user_id = '60000000-0000-0000-0000-000000000004';
set local role authenticated;
select chat_attachment_test_assert(chat_attachment_test_deleted('%.gif') = 0,
  'a builder made a viewer cannot delete their earlier upload');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-00000000000c.png', 'an upload by a builder made a viewer');

-- Team roles count as they do in the controller: a team builder uploads, a team
-- viewer only reads.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000005';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000005","role":"authenticated"}';
select chat_attachment_test_upload('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000007.webp');
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000006';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000006","role":"authenticated"}';
select chat_attachment_test_assert((select count(*) = 4 from storage.objects
  where bucket_id = 'chat-attachments'), 'a team viewer reads the space''s attachments');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-00000000000d.png', 'a team viewer upload');

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

-- The owner deletes their own text file.
set local role authenticated;
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}';
select chat_attachment_test_assert(chat_attachment_test_deleted('%.md') = 1, 'the owner deletes their own attachment');
reset role;

-- Only the fixture's spaces: a shared local stack may hold other attachments.
select chat_attachment_test_assert((select array_agg(name order by name) from storage.objects
    where bucket_id = 'chat-attachments' and (name like '60000000-0000-0000-0000-000000000011/%'
      or name like '60000000-0000-0000-0000-000000000012/%'))
  = array['60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000002.png',
          '60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000007.webp',
          '60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-00000000000a.gif',
          '60000000-0000-0000-0000-000000000012/6a000000-0000-4000-8000-000000000001.png'],
  'exactly the accepted uploads that nobody deleted remain');
select chat_attachment_test_assert(not has_function_privilege('anon',
  'public.can_access_chat_attachment(text)', 'execute')
  and not has_function_privilege('anon', 'public.can_write_chat_attachment(text)', 'execute'),
  'anon cannot call the access functions');
select chat_attachment_test_assert(has_function_privilege('authenticated',
  'public.can_access_chat_attachment(text)', 'execute')
  and has_function_privilege('authenticated', 'public.can_write_chat_attachment(text)', 'execute'),
  'signed-in users call the access functions');
select chat_attachment_test_assert(not has_function_privilege('authenticated',
  'public.chat_attachment_space(text)', 'execute')
  and not has_function_privilege('anon', 'public.chat_attachment_space(text)', 'execute'),
  'only the access functions read attachment names');
