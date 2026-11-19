-- At most one Claude Code turn per person running at a time, across all spaces
-- (docs/Local-Engine-Turns.md 11.7). Any number may wait, queued, for one of
-- their person's computers: the lease hands out a person's next turn only while
-- none of theirs is leased, and this index refuses a second lease that two of
-- their computers race for.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261113113604_agent_jobs_one_active_claude_code_turn_idx.sql did. The rows
-- it covers are a subset of that index's, so the build finds no duplicate.
set local lock_timeout = '5s';

create unique index agent_jobs_one_running_claude_code_turn_idx
  on public.agent_jobs ((payload ->> 'user_id'))
  where engine = 'claude-code'
    and status = 'leased';
