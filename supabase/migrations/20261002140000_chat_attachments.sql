-- Chat attachments (images and text files sent with a message) are private
-- per-space objects in Supabase Storage, never files in the space's git history.
-- Objects are named '<projectId>/<uuid>.<ext>'. Members of a live space upload
-- and read them with their own session, and an uploader may delete their own
-- while they can still read them. Nobody may update one: objects are immutable.
-- The controller signs short-lived downloads for runtimes and purges a space's
-- prefix when the space is deleted, both with the service role.
create or replace function public.can_access_chat_attachment(object_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  first_segment text := split_part(object_name, '/', 1);
  target_id uuid;
begin
  if auth.uid() is null
    or object_name is null
    or object_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp|gif|txt|md)$' then
    return false;
  end if;
  begin target_id := first_segment::uuid;
  exception when invalid_text_representation then return false; end;
  -- One spelling per space, so the purge of '<projectId>/' finds every object.
  if target_id::text <> first_segment then
    return false;
  end if;
  return exists (select 1 from public.projects p
      where p.id = target_id and p.status <> 'deleted')
    and public.has_project_access(target_id);
end;
$$;
revoke all on function public.can_access_chat_attachment(text) from public, anon;
grant execute on function public.can_access_chat_attachment(text) to authenticated;

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
    with check (bucket_id = 'chat-attachments' and public.can_access_chat_attachment(name));
  drop policy if exists "chat attachments read" on storage.objects;
  create policy "chat attachments read" on storage.objects for select to authenticated
    using (bucket_id = 'chat-attachments' and public.can_access_chat_attachment(name));
  -- Storage records the uploader in owner. There is no update policy, so an
  -- upload never replaces an existing object (upsert is refused).
  drop policy if exists "chat attachments remove own" on storage.objects;
  create policy "chat attachments remove own" on storage.objects for delete to authenticated
    using (bucket_id = 'chat-attachments' and owner = auth.uid()
      and public.can_access_chat_attachment(name));
end;
$$;
