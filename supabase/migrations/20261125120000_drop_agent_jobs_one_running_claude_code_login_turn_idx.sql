-- A Claude Code login now runs several turns at once, as many as the
-- computers running them allow (docs/Local-Engine-Turns.md 11.23, D56), so
-- the index that allowed one running turn per login would refuse the second.
-- The lease's clause now counts a computer's running turns instead.
-- Its own file: dropping an index holds ACCESS EXCLUSIVE on agent_jobs alone,
-- briefly, and nothing is scanned.
set local lock_timeout = '5s';

drop index public.agent_jobs_one_running_claude_code_login_turn_idx;
