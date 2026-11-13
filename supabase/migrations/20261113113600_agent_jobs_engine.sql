-- engine: what runs the job's turn when it is not the runtime's embedded engine.
-- Only dispatch writes it (claude_code_lane.rs), once, when it queues the job,
-- and never from a request body. Null: the runtime's embedded engine, as for
-- every job queued before this column. 'claude-code': its person's own signed-in
-- Claude Code on their own computer, for one turn they started
-- (docs/Local-Engine-Turns.md). Such a job holds no Instafy credential, no device
-- grant and no plan role, and records when its person sent it.
--
-- Its own file because it holds ACCESS EXCLUSIVE on agent_jobs (MIGRATIONS.md).
-- The column has no default, so nothing is rewritten, and the check is NOT VALID,
-- so nothing is scanned under that lock; the next migration validates it.
set local lock_timeout = '5s';

alter table public.agent_jobs
  add column engine text,
  add constraint agent_jobs_engine_check check (
    engine is null
    or (
      engine = 'claude-code'
      and credential_id is null
      and grant_ids is null
      and parent_job_id is null
      and plan_group_id is null
      and agent_role is null
      and trigger_received_at is not null
    )
  ) not valid;
