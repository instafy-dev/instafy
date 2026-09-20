-- Bot profiles are user-owned, including before a new bot has an agent ID.
-- Keep each owner's immutable uploads in a separate directory; saved agent
-- metadata references the public URL and still uses controller ownership checks.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage unavailable: rerun agent_identity_images after installing Storage and identity_images';
    return;
  end if;

  drop policy if exists "agent identity images upload" on storage.objects;
  create policy "agent identity images upload" on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'identity-images'
      and name ~ '^agents/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$'
      and split_part(name, '/', 2) = (select auth.uid())::text
    );
  drop policy if exists "agent identity images remove" on storage.objects;
  create policy "agent identity images remove" on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'identity-images'
      and name ~ '^agents/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$'
      and split_part(name, '/', 2) = (select auth.uid())::text
    );
end;
$$;
