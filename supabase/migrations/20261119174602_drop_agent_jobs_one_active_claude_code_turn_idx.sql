-- Claude Code turns now wait, queued, for their person's computer, and any
-- number of a person's turns may wait (docs/Local-Engine-Turns.md 11.7). The
-- index that allowed one running or waiting turn per person would refuse a
-- second waiting one; 20261119174600's index, on running turns alone, takes
-- its place.
-- Its own file: dropping an index holds ACCESS EXCLUSIVE on agent_jobs alone,
-- briefly, and nothing is scanned.
set local lock_timeout = '5s';

drop index public.agent_jobs_one_active_claude_code_turn_idx;
