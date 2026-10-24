-- What started an agent job, and when. Only the controller route that
-- authenticated the cause writes it, once, when it queues the job; a job with
-- no recorded cause is read as no person's. Controller-only, like the table.
set local lock_timeout = '5s';

-- trigger_user_id: the person whose send it was, or whose agent or automation
-- sent it. trigger_received_at: when the controller received the cause, on
-- the database clock; for a queued message, when it was queued. Both null:
-- nobody recorded a cause.
alter table public.agent_jobs
  add column if not exists trigger_user_id uuid,
  add column if not exists trigger_received_at timestamptz;
