-- Checks the rows that existed before 20261113113600 against the check it added
-- NOT VALID. Its own file because VALIDATE CONSTRAINT scans agent_jobs under
-- SHARE UPDATE EXCLUSIVE, which blocks no live read or write. Every earlier row
-- has a null engine.
set local lock_timeout = '5s';

alter table public.agent_jobs
  validate constraint agent_jobs_engine_check;
