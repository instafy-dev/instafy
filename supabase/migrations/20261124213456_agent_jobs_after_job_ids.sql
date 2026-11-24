set local lock_timeout = '5s';

-- The jobs whose turns a job waits for (docs/Local-Engine-Turns.md 11.22). A
-- person's message that names several agents runs their turns one after
-- another, in the order it names them: dispatch records on each agent's job
-- after the first the jobs of every agent named before it, and the lease
-- passes over a queued job while any of them is queued or leased. Naming every
-- earlier job, not just the one before, keeps a later turn waiting when a
-- middle one is stopped while it waits. Only the controller writes it, in the
-- dispatch that queued them all. Null for every other job.
--
-- Its own file because it holds ACCESS EXCLUSIVE on agent_jobs (MIGRATIONS.md).
-- The column is bare, with no default, reference or constraint, so nothing is
-- rewritten or scanned under that lock. A job it names that is gone counts as
-- ended.
alter table public.agent_jobs
  add column after_job_ids uuid[];
