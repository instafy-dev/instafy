-- project_provider_requests' indexes. Controllers before 20261028140000 made
-- the first two at run time, so they may already exist. Their own file
-- because CREATE INDEX holds SHARE while it builds, which blocks a write to
-- the table but no read; in the migration that altered the table it would
-- build under ACCESS EXCLUSIVE.
set local lock_timeout = '5s';

create index if not exists project_provider_requests_lookup_idx
  on public.project_provider_requests (project_id, provider_id, status, created_at);
create index if not exists project_provider_requests_project_idx
  on public.project_provider_requests (project_id, created_at desc);
-- A job's end cancels its pending and claimed requests.
create index project_provider_requests_job_idx
  on public.project_provider_requests (job_id)
  where job_id is not null;
