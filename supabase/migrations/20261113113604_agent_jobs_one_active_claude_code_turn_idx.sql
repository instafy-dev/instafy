-- At most one Claude Code turn per person that is running or may still start,
-- across all spaces: a running turn cannot start another through its person's
-- own session, and two concurrent sends cannot both be admitted. A queued turn
-- whose lease ended (lease_attempts > 0) can never start again and is left out.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261025145800_agent_jobs_early_checkpoint_recovery_idx.sql did.
set local lock_timeout = '5s';

create unique index agent_jobs_one_active_claude_code_turn_idx
  on public.agent_jobs ((payload ->> 'user_id'))
  where engine = 'claude-code'
    and (status = 'leased' or (status = 'queued' and lease_attempts = 0));
