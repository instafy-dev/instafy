-- Validate the additive replacement from migration 51 before atomically
-- removing the old, narrower constraint. PostgreSQL can validate a NOT VALID
-- check constraint without holding the ACCESS EXCLUSIVE lock needed for the
-- final metadata-only swap.
set lock_timeout = '5s';

alter table runtime_leases
  validate constraint runtime_leases_status_check_with_cleanup_pending;

-- A DO block is one database statement/transaction even when a migration
-- runner submits statements individually. If either DDL command fails, the
-- original constraint remains and the validated replacement is safe to retry.
do $migration$
begin
  execute 'alter table runtime_leases drop constraint runtime_leases_status_check';
  execute 'alter table runtime_leases rename constraint runtime_leases_status_check_with_cleanup_pending to runtime_leases_status_check';
end
$migration$;

reset lock_timeout;
