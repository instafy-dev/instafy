-- Migration 51: an allocator timeout is ambiguous: compute may exist even when the provider
-- response was lost. Keep that exact lease non-registerable and non-reusable
-- until the provider acknowledges its idempotent release.
-- Add the replacement constraint before removing the live one. A failed or
-- interrupted deploy must never leave production without a status constraint.
-- Fail instead of queueing an ACCESS EXCLUSIVE lock behind a long transaction
-- and blocking new runtime writes while it waits.
set lock_timeout = '5s';

alter table runtime_leases
  add constraint runtime_leases_status_check_with_cleanup_pending
  check (
    status in (
      'pending',
      'launching',
      'active',
      'cleanup_pending',
      'released',
      'failed'
    )
  ) not valid;

reset lock_timeout;
