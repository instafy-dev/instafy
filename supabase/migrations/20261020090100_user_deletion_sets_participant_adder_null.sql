-- The last "who did it" column that kept a person from being deleted (see
-- 20261020090000): who added a chat participant. On its own because live
-- requests lock conversation_participants (supabase/MIGRATIONS.md).
do $$
declare
  target record;
  constraint_name text;
begin
  for target in
    select * from (values
      ('conversation_participants', 'added_by')
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
