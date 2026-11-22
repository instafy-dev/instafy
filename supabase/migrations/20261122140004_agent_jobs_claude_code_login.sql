-- The Claude Code logins of a local-engine turn (docs/Local-Engine-Turns.md
-- 11.19). Only the controller writes them, never from a request body.
-- claude_code_login_ids: the logins dispatch queued the turn to run on, in
-- order: its agent's login, or its person's first login, or none. Null for
-- every job that is not a Claude Code turn, and for one queued before this
-- column. claude_code_login_id: the login its lease took, the first of those
-- still its person's, or else their first login; one turn runs on each login
-- at a time (agent_jobs_one_running_claude_code_login_turn_idx). Null until a
-- lease takes one.
--
-- Its own file because it holds ACCESS EXCLUSIVE on agent_jobs (MIGRATIONS.md).
-- The columns have no default and no constraint, so nothing is rewritten or
-- scanned under that lock.
set local lock_timeout = '5s';

alter table public.agent_jobs
  add column claude_code_login_ids uuid[],
  add column claude_code_login_id uuid;
