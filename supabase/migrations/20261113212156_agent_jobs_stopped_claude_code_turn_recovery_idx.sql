-- The idle sweep finishes a local-engine turn (docs/Local-Engine-Turns.md) whose
-- runtime stop failed its job but whose own end was never written: it reads
-- only failed engine jobs that ended recently, oldest first. Ordinary jobs have
-- a null engine and are not in this index.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261112084100_agent_jobs_lost_final_checkpoint_recovery_idx.sql did.
set local lock_timeout = '5s';

create index agent_jobs_stopped_claude_code_turn_recovery_idx
  on public.agent_jobs (completed_at, id)
  where engine is not null
    and status = 'failed';
