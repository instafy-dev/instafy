-- A long-lived job can renew its short-lived model capability. Keep every
-- issued hash so requests already in flight can settle with their original
-- token. No raw token or provider credential is persisted.
set local lock_timeout = '5s';
create table public.ai_usage_job_proxy_tokens (
  job_id uuid not null references public.ai_usage_jobs(job_id) on delete cascade,
  lease_attempt integer not null check (lease_attempt > 0),
  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (job_id, lease_attempt, token_sha256)
);

alter table public.ai_usage_job_proxy_tokens enable row level security;
revoke all on public.ai_usage_job_proxy_tokens from anon, authenticated;
grant all on public.ai_usage_job_proxy_tokens to service_role;
