-- The private chat-attachments bucket and its storage.objects policies. As the
-- signed-in and anonymous roles, it checks who may upload, read, list and
-- delete an attachment: reads follow the conversation's own rule
-- (has_conversation_access), uploads and deletes also need a writer of the
-- space. Names are restricted to one spelling per space and conversation, and
-- nobody may update an object.
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

-- 01 owns every space. In the first space (11), 02 is a viewer and 04 and 07
-- are builders, and in its team 05 is a builder and 06 a viewer. 03 is in
-- neither. Conversation 31 of space 11 is public. Conversation 32 of space 11
-- is private: 01 created it, and 02, 04 and 03 take part in it. Conversation
-- 33 belongs to space 12, which is deleted below, and 35 to space 13.
insert into auth.users(id,email) values
  ('60000000-0000-0000-0000-000000000001','space-owner@example.invalid'),
  ('60000000-0000-0000-0000-000000000002','space-viewer@example.invalid'),
  ('60000000-0000-0000-0000-000000000003','outsider@example.invalid'),
  ('60000000-0000-0000-0000-000000000004','space-builder@example.invalid'),
  ('60000000-0000-0000-0000-000000000005','team-builder@example.invalid'),
  ('60000000-0000-0000-0000-000000000006','team-viewer@example.invalid'),
  ('60000000-0000-0000-0000-000000000007','other-space-builder@example.invalid');
insert into organizations(id,slug,name) values
  ('60000000-0000-0000-0000-000000000021','chat-attachments-fixture','Chat attachments');
insert into projects(id,org_id,owner_user_id) values
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000021','60000000-0000-0000-0000-000000000001');
insert into projects(id,owner_user_id) values
  ('60000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000001'),
  ('60000000-0000-0000-0000-000000000013','60000000-0000-0000-0000-000000000001');
insert into project_memberships(project_id,user_id,role) values
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000002','viewer'),
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000004','builder'),
  ('60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000007','builder');
insert into org_memberships(org_id,user_id,role) values
  ('60000000-0000-0000-0000-000000000021','60000000-0000-0000-0000-000000000005','builder'),
  ('60000000-0000-0000-0000-000000000021','60000000-0000-0000-0000-000000000006','viewer');
insert into conversations(id,project_id,created_by,visibility) values
  ('60000000-0000-0000-0000-000000000031','60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000001','public'),
  ('60000000-0000-0000-0000-000000000032','60000000-0000-0000-0000-000000000011','60000000-0000-0000-0000-000000000001','private'),
  ('60000000-0000-0000-0000-000000000033','60000000-0000-0000-0000-000000000012','60000000-0000-0000-0000-000000000001','public'),
  ('60000000-0000-0000-0000-000000000035','60000000-0000-0000-0000-000000000013','60000000-0000-0000-0000-000000000001','public');
-- 03 is a participant without access to the space, as after leaving it.
insert into conversation_participants(conversation_id,user_id) values
  ('60000000-0000-0000-0000-000000000032','60000000-0000-0000-0000-000000000002'),
  ('60000000-0000-0000-0000-000000000032','60000000-0000-0000-0000-000000000004'),
  ('60000000-0000-0000-0000-000000000032','60000000-0000-0000-0000-000000000003');

-- '<space>/<conversation>/<file>' for the fixture's ids: space and
-- conversation by their last two digits, the file by its last two characters
-- and extension.
create function chat_attachment_test_name(space text, conversation text, file text) returns text
language sql immutable as $$
  select '60000000-0000-0000-0000-0000000000' || space || '/60000000-0000-0000-0000-0000000000'
    || conversation || '/6a000000-0000-4000-8000-0000000000' || file;
$$;
-- An attachment the owner stored while the second space was live, before it was deleted.
insert into storage.objects(bucket_id,name,owner,owner_id) values
  ('chat-attachments',chat_attachment_test_name('12','33','01.png'),
   '60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001');
update projects set status = 'deleted' where id = '60000000-0000-0000-0000-000000000012';
-- Another bucket's object, to show the policies stay inside chat-attachments.
insert into storage.buckets(id,name,public) values ('chat-attachments-test-other','chat-attachments-test-other',false);
insert into storage.objects(bucket_id,name,owner,owner_id) values
  ('chat-attachments-test-other',chat_attachment_test_name('11','31','09.png'),
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
-- The chat attachments the current role and user read in a conversation.
create function chat_attachment_test_visible(space text, conversation text) returns bigint
language sql as $$
  select count(*) from storage.objects where bucket_id = 'chat-attachments'
    and name like chat_attachment_test_name(space, conversation, '') || '%';
$$;
-- The folders a list of '<space>/' shows the current role and user, through
-- Storage's own list function where it exists (the stub has none, and then the
-- objects they read stand in for it).
create function chat_attachment_test_listed(space text) returns text[] language plpgsql as $$
declare
  prefix text := split_part(chat_attachment_test_name(space, '00', ''), '/', 1) || '/';
  listed text[];
begin
  if to_regprocedure('storage.search(text,text,integer,integer,integer,text,text,text)') is null then
    select array_agg(distinct split_part(name, '/', 2) order by split_part(name, '/', 2)) into listed
      from storage.objects where bucket_id = 'chat-attachments' and name like prefix || '%';
  else
    execute 'select array_agg(name order by name) from storage.search($1, $2, 100, 2, 0, '''', ''name'', ''asc'')'
      into listed using prefix, 'chat-attachments';
  end if;
  return coalesce(listed, array[]::text[]);
end; $$;
grant execute on function chat_attachment_test_assert(boolean,text), chat_attachment_test_name(text,text,text),
  chat_attachment_test_upload(text), chat_attachment_test_refused(text,text),
  chat_attachment_test_deleted(text), chat_attachment_test_visible(text,text),
  chat_attachment_test_listed(text) to anon, authenticated;

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

-- The owner uploads an image to the public conversation and a text file to the
-- private one they created, and reads both back.
select chat_attachment_test_upload(chat_attachment_test_name('11','31','02.png'));
select chat_attachment_test_upload(chat_attachment_test_name('11','32','03.md'));
select chat_attachment_test_assert(chat_attachment_test_visible('11','31') = 1
    and chat_attachment_test_visible('11','32') = 1,
  'the owner uploads and reads attachments of a live space''s conversations');
select chat_attachment_test_assert(chat_attachment_test_listed('11')
    = array['60000000-0000-0000-0000-000000000031','60000000-0000-0000-0000-000000000032'],
  'a list of the space shows the owner both conversations');

-- Names outside '<projectId>/<conversationId>/<uuid>.<png|jpg|webp|gif|txt|md>',
-- each id in its canonical spelling, are refused.
select chat_attachment_test_refused(chat_attachment_test_name('11','31','04.exe'), 'an executable extension');
select chat_attachment_test_refused(chat_attachment_test_name('11','31','04.svg'), 'an SVG');
select chat_attachment_test_refused(chat_attachment_test_name('11','31','04.PNG'), 'an upper-case extension');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/60000000-0000-0000-0000-000000000031/6A000000-0000-4000-8000-000000000004.png', 'an upper-case file name');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/60000000-0000-0000-0000-00000000003A/6a000000-0000-4000-8000-000000000004.png', 'an upper-case conversation id');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/60000000-0000-0000-0000-000000000031/screenshot.png', 'a free-form name');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/60000000-0000-0000-0000-000000000031/../6a000000-0000-4000-8000-000000000004.png', 'a traversal');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/60000000-0000-0000-0000-000000000031/x/6a000000-0000-4000-8000-000000000004.png', 'an extra segment');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6a000000-0000-4000-8000-000000000004.png', 'a name without a conversation');
select chat_attachment_test_refused('6a000000-0000-4000-8000-000000000004.png', 'a name without a space');
select chat_attachment_test_refused('6000-0000-0000-0000-0000-0000-0000-00000011/60000000-0000-0000-0000-000000000031/6a000000-0000-4000-8000-000000000004.png', 'a malformed space id');
-- 36 characters that parse to the existing ids: only the canonical spelling is
-- accepted, which keeps every object of a space under '<projectId>/' and of a
-- conversation under '<projectId>/<conversationId>/'.
select chat_attachment_test_refused('6000-0000-0000-0000-0000000000000011/60000000-0000-0000-0000-000000000031/6a000000-0000-4000-8000-000000000004.png', 'another spelling of the space id');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/6000-0000-0000-0000-0000000000000031/6a000000-0000-4000-8000-000000000004.png', 'another spelling of the conversation id');
select chat_attachment_test_refused('60000000-0000-0000-0000-000000000011/60000000-0000-0000-0000-000000000031/6a00-0000-0000-4000-8000000000000004.png', 'another spelling of the file id');
select chat_attachment_test_refused(chat_attachment_test_name('99','31','04.png'), 'a space that does not exist');
select chat_attachment_test_refused(chat_attachment_test_name('11','39','04.png'), 'a conversation that does not exist');
-- The owner owns both spaces, but a conversation belongs to exactly one.
select chat_attachment_test_refused(chat_attachment_test_name('11','35','04.png'), 'another space''s conversation');
select chat_attachment_test_refused(chat_attachment_test_name('13','31','04.png'), 'a conversation under another space');
-- A deleted space takes uploads, reads and deletes away from everyone, its owner
-- included; the controller purges its objects with the service role.
select chat_attachment_test_refused(chat_attachment_test_name('12','33','04.png'), 'an upload to a deleted space');
select chat_attachment_test_assert(chat_attachment_test_visible('12','33') = 0, 'a deleted space''s attachment is unreadable');
select chat_attachment_test_assert(chat_attachment_test_deleted(chat_attachment_test_name('12','33','') || '%') = 0,
  'the uploader cannot delete an attachment of a deleted space');
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments-test-other'), 'the read policy covers only chat-attachments');

-- Objects are immutable: no update or upsert, even by the uploader.
update storage.objects set name = chat_attachment_test_name('11','31','05.png')
  where name = chat_attachment_test_name('11','31','02.png');
do $$ begin
  begin
    insert into storage.objects(bucket_id,name,owner,owner_id) values
      ('chat-attachments',chat_attachment_test_name('11','31','02.png'),auth.uid(),auth.uid()::text)
      on conflict (bucket_id,name) do update set name = excluded.name;
    raise exception 'chat attachment test failed: an upsert was accepted';
  exception when insufficient_privilege then null; end;
end $$;
select chat_attachment_test_assert((select count(*) = 2 from storage.objects
  where bucket_id = 'chat-attachments' and name in (chat_attachment_test_name('11','31','02.png'),
    chat_attachment_test_name('11','32','03.md'))),
  'update and upsert leave attachments unchanged');

-- Storage names the uploader in owner_id; the deprecated owner is not needed.
insert into storage.objects(bucket_id,name,owner_id) values
  ('chat-attachments',chat_attachment_test_name('11','31','0b.txt'),auth.uid()::text);
select chat_attachment_test_assert(chat_attachment_test_deleted('%000b.txt') = 1,
  'owner_id alone identifies the uploader');

-- A session without a user is refused even for a live conversation's name.
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{"role":"authenticated"}';
select chat_attachment_test_assert(
  not public.can_access_chat_attachment(chat_attachment_test_name('11','31','02.png'))
  and not public.can_write_chat_attachment(chat_attachment_test_name('11','31','02.png')),
  'a session without a user neither reads nor writes');
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments'), 'a session without a user reads no attachment');

-- A viewer who takes part in the private conversation reads both
-- conversations, but neither uploads nor deletes: the controller refuses them
-- any chat write too.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000002","role":"authenticated"}';
select chat_attachment_test_assert(chat_attachment_test_visible('11','31') = 1
    and chat_attachment_test_visible('11','32') = 1,
  'a viewer reads a public conversation and a private one they take part in');
select chat_attachment_test_refused(chat_attachment_test_name('11','31','06.txt'), 'a viewer upload to a public conversation');
select chat_attachment_test_refused(chat_attachment_test_name('11','32','06.txt'), 'a viewer upload to their private conversation');
select chat_attachment_test_assert(chat_attachment_test_deleted('%') = 0, 'a viewer deletes no attachment');

-- A builder who takes part in the private conversation uploads to both, and
-- deletes their own upload, never another member's.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000004';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000004","role":"authenticated"}';
select chat_attachment_test_upload(chat_attachment_test_name('11','32','06.txt'));
select chat_attachment_test_upload(chat_attachment_test_name('11','32','0e.txt'));
select chat_attachment_test_upload(chat_attachment_test_name('11','31','0a.gif'));
select chat_attachment_test_assert(chat_attachment_test_visible('11','31') = 2
    and chat_attachment_test_visible('11','32') = 3,
  'a participating builder uploads to and reads both conversations');
select chat_attachment_test_assert(chat_attachment_test_deleted('%.png') = 0
    and chat_attachment_test_deleted('%.md') = 0,
  'a builder cannot delete another member''s attachment');
select chat_attachment_test_assert(chat_attachment_test_deleted('%0006.txt') = 1,
  'a builder deletes their own attachment');

-- Once they leave the private conversation, the same builder no longer reads
-- or lists its attachments, nor deletes or adds to them, their own included.
reset role;
delete from conversation_participants
  where conversation_id = '60000000-0000-0000-0000-000000000032' and user_id = '60000000-0000-0000-0000-000000000004';
set local role authenticated;
select chat_attachment_test_assert(chat_attachment_test_visible('11','32') = 0
    and chat_attachment_test_visible('11','31') = 2,
  'a builder who left a private conversation reads only the public one');
select chat_attachment_test_assert(chat_attachment_test_listed('11') = array['60000000-0000-0000-0000-000000000031'],
  'a builder who left a private conversation does not list it');
select chat_attachment_test_assert(chat_attachment_test_deleted('%000e.txt') = 0,
  'a builder who left a private conversation cannot delete their upload to it');
select chat_attachment_test_refused(chat_attachment_test_name('11','32','0c.png'), 'an upload to a private conversation the builder left');

-- Once made a viewer, the same member can no longer delete what they uploaded
-- to the public conversation, nor add to it.
reset role;
update project_memberships set role = 'viewer'
  where project_id = '60000000-0000-0000-0000-000000000011' and user_id = '60000000-0000-0000-0000-000000000004';
set local role authenticated;
select chat_attachment_test_assert(chat_attachment_test_deleted('%.gif') = 0,
  'a builder made a viewer cannot delete their earlier upload');
select chat_attachment_test_refused(chat_attachment_test_name('11','31','0c.png'), 'an upload by a builder made a viewer');

-- A builder of the space who never took part in the private conversation reads,
-- lists and uploads only in the public one.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000007';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000007","role":"authenticated"}';
select chat_attachment_test_assert(chat_attachment_test_visible('11','32') = 0
    and chat_attachment_test_visible('11','31') = 2,
  'a space builder outside a private conversation reads none of its attachments');
select chat_attachment_test_assert(chat_attachment_test_listed('11') = array['60000000-0000-0000-0000-000000000031'],
  'a space builder outside a private conversation does not list it');
select chat_attachment_test_assert(not public.can_access_chat_attachment(chat_attachment_test_name('11','32','03.md')),
  'a space builder outside a private conversation cannot read a known name in it');
select chat_attachment_test_refused(chat_attachment_test_name('11','32','0d.png'), 'an upload to a private conversation by a non-participant');
select chat_attachment_test_assert(chat_attachment_test_deleted('%') = 0, 'a builder deletes nothing they did not upload');

-- Team roles count as they do in the controller: a team builder uploads to a
-- public conversation, a team viewer only reads it, and neither reaches the
-- private conversation they are not part of.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000005';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000005","role":"authenticated"}';
select chat_attachment_test_upload(chat_attachment_test_name('11','31','07.webp'));
select chat_attachment_test_refused(chat_attachment_test_name('11','32','07.png'), 'a team builder upload to a private conversation they are not part of');
select chat_attachment_test_assert(chat_attachment_test_visible('11','32') = 0, 'a team builder outside a private conversation reads none of it');
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000006';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000006","role":"authenticated"}';
select chat_attachment_test_assert(chat_attachment_test_visible('11','31') = 3
    and chat_attachment_test_visible('11','32') = 0,
  'a team viewer reads the public conversation''s attachments only');
select chat_attachment_test_refused(chat_attachment_test_name('11','31','0d.png'), 'a team viewer upload');

-- A signed-in non-member neither reads, uploads nor deletes, even as a
-- participant of the private conversation: its rule needs the space too.
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000003","role":"authenticated"}';
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments'), 'a non-member reads no attachment');
select chat_attachment_test_assert(chat_attachment_test_listed('11') = array[]::text[], 'a non-member lists nothing');
select chat_attachment_test_refused(chat_attachment_test_name('11','31','08.png'), 'a non-member upload');
select chat_attachment_test_refused(chat_attachment_test_name('11','32','08.png'), 'a non-member participant upload');
select chat_attachment_test_assert(chat_attachment_test_deleted('%') = 0, 'a non-member deletes no attachment');
reset role;

-- Anonymous requests have no policy at all.
set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{"role":"anon"}';
select chat_attachment_test_assert((select count(*) = 0 from storage.objects
  where bucket_id = 'chat-attachments'), 'anon reads no attachment');
select chat_attachment_test_refused(chat_attachment_test_name('11','31','08.png'), 'an anonymous upload');
select chat_attachment_test_assert(chat_attachment_test_deleted('%') = 0, 'anon deletes no attachment');
reset role;

-- The owner, the private conversation's creator, still reads it all and
-- deletes their own text file.
set local role authenticated;
set local request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"60000000-0000-0000-0000-000000000001","role":"authenticated"}';
select chat_attachment_test_assert(chat_attachment_test_visible('11','32') = 2,
  'the creator of a private conversation reads every attachment in it');
select chat_attachment_test_assert(chat_attachment_test_deleted('%.md') = 1, 'the owner deletes their own attachment');
reset role;

-- Only the fixture's spaces: a shared local stack may hold other attachments.
select chat_attachment_test_assert((select array_agg(name order by name) from storage.objects
    where bucket_id = 'chat-attachments' and (name like '60000000-0000-0000-0000-000000000011/%'
      or name like '60000000-0000-0000-0000-000000000012/%'))
  = array[chat_attachment_test_name('11','31','02.png'), chat_attachment_test_name('11','31','07.webp'),
          chat_attachment_test_name('11','31','0a.gif'), chat_attachment_test_name('11','32','0e.txt'),
          chat_attachment_test_name('12','33','01.png')],
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
  'public.chat_attachment_scope(text)', 'execute')
  and not has_function_privilege('anon', 'public.chat_attachment_scope(text)', 'execute'),
  'only the access functions read attachment names');
