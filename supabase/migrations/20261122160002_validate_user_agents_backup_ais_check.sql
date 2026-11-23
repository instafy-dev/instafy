-- Checks the rows that existed before 20261122160000 against the check it
-- added NOT VALID, which keeps an agent's backup AIs an array of at most 8
-- entries (docs/Local-Engine-Turns.md 11.20). Every such row holds the
-- column's default, '[]', so none is refused.
-- Its own file because VALIDATE CONSTRAINT scans user_agents under SHARE
-- UPDATE EXCLUSIVE, which blocks no live read or write (MIGRATIONS.md), and a
-- check locks no other table.
set local lock_timeout = '5s';

alter table public.user_agents
  validate constraint user_agents_backup_ais_check;
