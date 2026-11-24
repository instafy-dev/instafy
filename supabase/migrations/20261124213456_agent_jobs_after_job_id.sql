set local lock_timeout = '5s';

-- The job whose turn a job waits for (docs/Local-Engine-Turns.md 11.22). A
-- person's message that names several agents runs their turns one after
-- another, in the order it names them: dispatch records on each agent's job
-- after the first the job of the agent named before it, and the lease passes
-- over a queued job while that job is queued or leased. Only the controller
-- writes it, in the dispatch that queued both jobs. Null for every other job.
--
-- Its own file because it holds ACCESS EXCLUSIVE on agent_jobs (MIGRATIONS.md).
-- The column is bare, with no default, reference or constraint, so nothing is
-- rewritten or scanned under that lock. A job it names that is gone counts as
-- ended.
alter table public.agent_jobs
  add column after_job_id uuid;
