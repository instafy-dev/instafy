-- Chat attachments (images and text files sent with a message) are private
-- per-space objects in Supabase Storage, never files in the space's git history.
-- Objects are named '<projectId>/<uuid>.<ext>'. Every member of a live space
-- reads them with their own session. Only members who may write to the space,
-- the same ones the controller lets send a message, upload them, and they may
-- delete their own while they can still write. Nobody may update one in place.
-- The controller signs short-lived downloads for runtimes and purges a space's
-- prefix when the space or its team is deleted, both with the service role.

-- The policy statements lock storage.objects. Fail fast and retry rather than
-- queue every Storage request behind a long transaction.
set local lock_timeout = '5s';

-- The space of a well-formed attachment name, or null. One spelling per space,
-- so the purge of '<projectId>/' finds every object.
create or replace function public.chat_attachment_space(object_name text)
returns uuid language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  first_segment text := split_part(object_name, '/', 1);
  space_id uuid;
begin
  if object_name is null
    or object_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp|gif|txt|md)$' then
    return null;
  end if;
  begin space_id := first_segment::uuid;
  exception when invalid_text_representation then return null; end;
  if space_id::text <> first_segment then
    return null;
  end if;
  return space_id;
end;
$$;
revoke all on function public.chat_attachment_space(text) from public, anon, authenticated;

-- Reading: any member of the live space (has_project_access).
create or replace function public.can_access_chat_attachment(object_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  space_id uuid := public.chat_attachment_space(object_name);
begin
  if auth.uid() is null or space_id is null then
    return false;
  end if;
  return exists (select 1 from public.projects p
      where p.id = space_id and p.status <> 'deleted')
    and public.has_project_access(space_id);
end;
$$;
revoke all on function public.can_access_chat_attachment(text) from public, anon;
grant execute on function public.can_access_chat_attachment(text) to authenticated;

-- Uploading, and deleting one's own: the members who may write to the live
-- space, as the controller decides for chat (ensure_project_write_access). That
-- is its owner, or an owner, admin or builder of the space or of its team.
create or replace function public.can_write_chat_attachment(object_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
  space_id uuid := public.chat_attachment_space(object_name);
begin
  if requester is null or space_id is null then
    return false;
  end if;
  return exists (select 1 from public.projects p
    where p.id = space_id and p.status <> 'deleted' and (
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
