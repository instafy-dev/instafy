-- One Claude Code turn now runs at a time on each Claude Code login rather
-- than for each person (docs/Local-Engine-Turns.md 11.19), so a person's turns
-- on two logins run at once on two computers. The index that allowed one
-- running turn per person would refuse the second; 20261122140006's index, on
-- the login a turn's lease took, takes its place.
-- Its own file: dropping an index holds ACCESS EXCLUSIVE on agent_jobs alone,
-- briefly, and nothing is scanned.
set local lock_timeout = '5s';

drop index public.agent_jobs_one_running_claude_code_turn_idx;
