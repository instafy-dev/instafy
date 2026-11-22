-- At most one Claude Code turn running on each Claude Code login at a time,
-- across all of its person's computers and spaces (docs/Local-Engine-Turns.md
-- 11.19). The lease hands out a turn on a login only while no turn holds it,
-- and this index refuses a second lease that two computers race for, which
-- then takes nothing. Turns on different logins of one person run at once.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261119174600_agent_jobs_one_running_claude_code_turn_idx.sql did. No row
-- has a login yet, and the index leaves out rows without one, so the build
-- finds no duplicate.
set local lock_timeout = '5s';

create unique index agent_jobs_one_running_claude_code_login_turn_idx
  on public.agent_jobs (claude_code_login_id)
  where engine = 'claude-code'
    and status = 'leased';
