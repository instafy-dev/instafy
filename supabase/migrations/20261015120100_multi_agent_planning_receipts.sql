-- A planning turn is terminal as soon as its plan is dispatched or refused.
-- The issuing runtime may then attach its final diagnostic/usage receipt once,
-- without reopening the job or repeating completion side effects.
alter table public.agent_jobs
  add column if not exists planning_receipt_state jsonb
  check (planning_receipt_state is null or jsonb_typeof(planning_receipt_state) = 'object');

comment on column public.agent_jobs.planning_receipt_state is
  'Controller-owned one-shot planning receipt state, bound to the original runtime and lease generation. Never accepted from dispatch/message metadata.';
