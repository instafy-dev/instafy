-- Which device may claim a provider request, which agent job made it, and why
-- it was canceled. Controller-only, like the table.
set local lock_timeout = '5s';

-- Only this device may claim the request. Null: any device of the provider.
alter table public.project_provider_requests
  add column if not exists target_device_id text;

-- The agent job the request belongs to. When the job ends, its pending and
-- claimed requests are canceled in the job's own transaction.
alter table public.project_provider_requests
  add column if not exists job_id uuid;

create index if not exists project_provider_requests_job_idx
  on public.project_provider_requests (job_id)
  where job_id is not null;

-- steered when a person's new words were steered into the request's job,
-- which goes on without it. Null on any other cancel and every other status.
alter table public.project_provider_requests
  add column if not exists cancel_reason text
    constraint project_provider_requests_cancel_reason_check
    check (cancel_reason = 'steered');
