-- Checks the rows that existed before 20261122140002 against the reference it
-- added NOT VALID, from an agent's Claude Code login to its owner's own
-- (docs/Local-Engine-Turns.md 11.19). Every such row has a null
-- claude_code_login_id, so none is refused.
-- Its own file because VALIDATE CONSTRAINT scans user_agents under SHARE UPDATE
-- EXCLUSIVE, which blocks no live read or write, and row-share locks
-- claude_code_logins without locking a row there (MIGRATIONS.md).
set local lock_timeout = '5s';

alter table public.user_agents
  validate constraint user_agents_claude_code_login_fkey;
