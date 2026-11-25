-- A person's Claude Code turns that wait for one of their computers, oldest
-- first (docs/Local-Engine-Turns.md 11.23): each computer's held poll reads
-- them every few seconds by the person's id, across all of their spaces. The
-- predicate is the one that poll repeats (RC/computers.rs), so the planner can
-- use the index for it; a_turn_waits_in reads the same rows by conversation.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261122140006_agent_jobs_one_running_claude_code_login_turn_idx.sql did.
set local lock_timeout = '5s';

create index agent_jobs_waiting_claude_code_turn_idx
  on public.agent_jobs ((payload ->> 'user_id'), created_at, id)
  where engine is not null
    and status = 'queued';
