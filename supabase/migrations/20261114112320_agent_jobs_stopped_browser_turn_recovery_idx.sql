-- The idle sweep ends the run of a Personal or Shared Browser turn whose
-- runtime stop failed its job but whose own end was never written: it reads
-- only failed browser jobs that ended recently, oldest first. The predicate
-- reads a job's browser transport word for word as the controller does
-- (BROWSER_TRANSPORT_SQL in packages/runtime-controller/src/runtime/stop.rs,
-- whose tests hold this file to it): the planner uses a partial index only
-- for a query that repeats its predicate.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261113212156_agent_jobs_stopped_claude_code_turn_recovery_idx.sql did.
set local lock_timeout = '5s';

create index agent_jobs_stopped_browser_turn_recovery_idx
  on public.agent_jobs (completed_at, id)
  where status = 'failed'
    and lower(replace(btrim(coalesce(
                 payload #>> '{metadata,browserTransport}',
                 payload #>> '{metadata,browser_transport}',
                 ''
               )), '_', '-')) in ('desktop-personal', 'shared');
