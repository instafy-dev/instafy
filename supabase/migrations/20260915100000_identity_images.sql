-- Shared team/space pictures are public display assets, not workspace files.
alter table public.projects add column if not exists avatar_url text
  check (avatar_url is null or (length(avatar_url) <= 2048 and avatar_url ~ '^https?://'));

-- Match controller identity permissions, including inherited team access.
create or replace function public.can_manage_identity_image(object_name text)
returns boolean language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
  target_id uuid;
  kind text := split_part(object_name, '/', 1);
begin
  if requester is null or object_name !~ '^(orgs|spaces)/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$' then
    return false;
  end if;
  begin target_id := split_part(object_name, '/', 2)::uuid;
  exception when invalid_text_representation then return false; end;
  if kind = 'orgs' then
    return exists (select 1 from public.org_memberships
      where org_id = target_id and user_id = requester and role in ('owner', 'admin'));
  end if;
  return exists (select 1 from public.projects p where p.id = target_id and (
    p.owner_user_id = requester
    or exists (select 1 from public.project_memberships pm where pm.project_id = p.id
      and pm.user_id = requester and pm.role in ('owner', 'admin', 'builder'))
    or exists (select 1 from public.org_memberships om where om.org_id = p.org_id
      and om.user_id = requester and om.role in ('owner', 'admin', 'builder'))
  ));
end;
$$;
revoke all on function public.can_manage_identity_image(text) from public;
grant execute on function public.can_manage_identity_image(text) to authenticated;

-- Controller-only installations may omit Supabase Storage. After adding Storage,
-- rerun this migration to provision the bucket/policies; existing data is retained.
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage unavailable: rerun identity_images migration after installing Storage to enable picture uploads';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('identity-images', 'identity-images', true, 2097152,
      array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  drop policy if exists "identity images upload" on storage.objects;
  create policy "identity images upload" on storage.objects for insert to authenticated
    with check (bucket_id = 'identity-images' and public.can_manage_identity_image(name));
  drop policy if exists "identity images remove" on storage.objects;
  create policy "identity images remove" on storage.objects for delete to authenticated
    using (bucket_id = 'identity-images' and public.can_manage_identity_image(name));
  drop policy if exists "identity images read" on storage.objects;
  create policy "identity images read" on storage.objects for select to authenticated
    using (bucket_id = 'identity-images');
end;
$$;
