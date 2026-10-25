-- What started an agent job, and how it may be delivered to a runtime. Only
-- controller code writes either, once, when it queues the job, and never from
-- a request body. A job with no recorded cause is read as no person's, and a
-- job that sets no delivery option is delivered as before. Controller-only,
-- like the table.
set local lock_timeout = '5s';

-- trigger_user_id: the person whose send it was, or whose agent or automation
-- sent it. trigger_received_at: when the controller received the cause, on
-- the database clock; for a queued message, when it was queued. Both null:
-- nobody recorded a cause.
--
-- at_most_once: the lease hands the job out once, and never again after that
-- lease ends. start_by: no lease after this time, on the database clock.
-- strict_pin: only target_runtime_id leases it, and nothing moves it to
-- another runtime. The controller's idle sweep fails a queued job that can no
-- longer start.
alter table public.agent_jobs
  add column if not exists trigger_user_id uuid,
  add column if not exists trigger_received_at timestamptz,
  add column if not exists at_most_once boolean not null default false,
  add column if not exists start_by timestamptz,
  add column if not exists strict_pin boolean not null default false;
