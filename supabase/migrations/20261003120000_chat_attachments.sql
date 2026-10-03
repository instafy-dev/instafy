-- Chat attachments (images and text files sent with a message) are private
-- per-conversation objects in Supabase Storage, never files in the space's git
-- history. Objects are named '<projectId>/<conversationId>/<uuid>.<ext>'. A
-- signed-in user reads them by the rule the conversation's messages follow
-- (has_conversation_access): any member of the space for a public
-- conversation, only its creator and participants for a private one. Those
-- readers who may also write to the space (the members the controller lets
-- send a message) upload, and may delete their own uploads while both still
-- hold. Nobody may update one in place. The controller signs short-lived
-- downloads for runtimes and purges a space's prefix when the space or its team
-- is deleted, both with the service role.

-- The policy statements lock storage.objects. Fail fast and retry rather than
-- queue every Storage request behind a long transaction.
set local lock_timeout = '5s';

-- The space and conversation of a well-formed attachment name, or nulls. Each
-- segment is a uuid in its one canonical spelling (lower case, hyphenated), so
-- the purge of '<projectId>/' finds every object of a space.
create or replace function public.chat_attachment_scope(
  object_name text, out space_id uuid, out conversation_id uuid)
language plpgsql immutable
set search_path = public, pg_temp
as $$
begin
  if object_name is null or object_name !~ ('^'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      || '\.(png|jpg|webp|gif|txt|md)$') then
    return;
  end if;
  space_id := split_part(object_name, '/', 1)::uuid;
  conversation_id := split_part(object_name, '/', 2)::uuid;
end;
$$;
revoke all on function public.chat_attachment_scope(text) from public, anon, authenticated;

-- Reading: whoever may read the conversation's messages, in a live space that
-- the conversation belongs to. The two checks are the ones the messages' own
-- read policy makes ("conversation messages project read").
create or replace function public.can_access_chat_attachment(object_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  target_space uuid;
  target_conversation uuid;
begin
  select scope.space_id, scope.conversation_id into target_space, target_conversation
    from public.chat_attachment_scope(object_name) scope;
  if auth.uid() is null or target_space is null then
    return false;
  end if;
  return exists (select 1 from public.conversations c
      join public.projects p on p.id = c.project_id
      where c.id = target_conversation and p.id = target_space and p.status <> 'deleted')
    and public.has_project_access(target_space)
    and public.has_conversation_access(target_conversation);
end;
$$;
revoke all on function public.can_access_chat_attachment(text) from public, anon;
grant execute on function public.can_access_chat_attachment(text) to authenticated;

-- Uploading, and deleting one's own: a reader of the conversation who may also
-- write to the space, as the controller decides for chat
-- (ensure_project_write_access). That is the space's owner, or an owner, admin
-- or builder of the space or of its team.
create or replace function public.can_write_chat_attachment(object_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
  target_space uuid := (public.chat_attachment_scope(object_name)).space_id;
begin
  if requester is null or target_space is null
    or not public.can_access_chat_attachment(object_name) then
    return false;
  end if;
  return exists (select 1 from public.projects p
    where p.id = target_space and (
      p.owner_user_id = requester
      or exists (select 1 from public.project_memberships pm where pm.project_id = p.id
        and pm.user_id = requester and pm.role in ('owner', 'admin', 'builder'))
      or exists (select 1 from public.org_memberships om where om.org_id = p.org_id
        and om.user_id = requester and om.role in ('owner', 'admin', 'builder'))));
end;
$$;
revoke all on function public.can_write_chat_attachment(text) from public, anon;
grant execute on function public.can_write_chat_attachment(text) to authenticated;

-- Controller-only installations may omit Supabase Storage. After adding Storage,
-- rerun this migration to provision the bucket and policies; it changes no data.
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage unavailable: rerun chat_attachments migration after installing Storage to enable chat attachments';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('chat-attachments', 'chat-attachments', false, 20971520,
      array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain', 'text/markdown'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  drop policy if exists "chat attachments upload" on storage.objects;
  create policy "chat attachments upload" on storage.objects for insert to authenticated
    with check (bucket_id = 'chat-attachments' and public.can_write_chat_attachment(name));
  drop policy if exists "chat attachments read" on storage.objects;
  create policy "chat attachments read" on storage.objects for select to authenticated
    using (bucket_id = 'chat-attachments' and public.can_access_chat_attachment(name));
  -- Storage records the uploader in owner_id, and for a uuid subject also in
  -- the deprecated owner. There is no update policy, so an upload never
  -- replaces an existing object (upsert is refused).
  drop policy if exists "chat attachments remove own" on storage.objects;
  create policy "chat attachments remove own" on storage.objects for delete to authenticated
    using (bucket_id = 'chat-attachments'
      and coalesce(owner_id, owner::text) = auth.uid()::text
      and public.can_write_chat_attachment(name));
end;
$$;
