-- Ensure origin_instances upsert can target lease_id
alter table origin_instances
  drop constraint if exists origin_instances_lease_unique;

drop index if exists origin_instances_lease_unique;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'origin_instances_lease_unique'
  ) then
    alter table origin_instances
      add constraint origin_instances_lease_unique unique (lease_id);
  end if;
end $$;
