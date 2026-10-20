-- Deleting a person failed when they had ever invited someone or created an
-- invite link: the "who did it" columns referenced auth.users with no ON
-- DELETE action ("update or delete on table users violates foreign key
-- constraint org_invite_links_created_by_fkey"). Each of these columns only
-- records who acted, so the record stays and forgets the person.
-- conversation_participants.added_by follows in 20261020090100: that table is
-- one live requests lock, so it changes in a migration of its own
-- (supabase/MIGRATIONS.md).
do $$
declare
  target record;
  constraint_name text;
begin
  for target in
    select * from (values
      ('org_memberships', 'invited_by'),
      ('org_invitations', 'invited_by'),
      ('org_invitations', 'accepted_by'),
      ('org_invite_links', 'created_by'),
      ('org_invite_links', 'revoked_by'),
      ('project_memberships', 'invited_by')
    ) as t(table_name, column_name)
  loop
    if to_regclass('public.' || target.table_name) is null then
      continue;
    end if;
    for constraint_name in
      select c.conname
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and c.conrelid = ('public.' || target.table_name)::regclass
        and c.confrelid = 'auth.users'::regclass
        and a.attname = target.column_name
        and array_length(c.conkey, 1) = 1
        and c.confdeltype <> 'n'
    loop
      execute format('alter table public.%I drop constraint %I', target.table_name, constraint_name);
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete set null',
        target.table_name, constraint_name, target.column_name
      );
    end loop;
  end loop;
end;
$$;
