-- Managed AI metering. The proxy reports the exact usage of every request it
-- makes on the platform key, and the controller records it per job and per
-- request here. Controller-only: no client reads these tables.
set local lock_timeout = '5s';

-- The ledger changes come first. Creating the tables below takes a lock on
-- agent_jobs for their foreign keys, held until commit, so they run last and
-- that lock lasts only as long as creating empty tables and their indexes.

-- A metered debit is posted after the request already ran upstream, so it may
-- take the balance below zero. Every other debit is still refused there.
alter table public.org_credit_ledger
  add column if not exists allow_overdraft boolean not null default false;
-- Serves the daily refill window lookup (org_id, reason, newest first).
create index if not exists org_credit_ledger_org_reason_created_idx
  on public.org_credit_ledger(org_id, reason, created_at desc);

-- Changes from the original guard: a debit with allow_overdraft may leave the
-- balance negative, a credit into a still-negative balance is allowed, and a
-- row whose idempotency key already exists is skipped without moving the
-- balance. The row trigger fires before ON CONFLICT is checked, so without the
-- skip a duplicate `insert ... on conflict do nothing` still moved the balance.
create or replace function public.org_credit_ledger_before_insert() returns trigger as $$
declare current_balance int;
begin
  insert into public.org_credit_balances(org_id) values (new.org_id) on conflict (org_id) do nothing;
  select balance into current_balance from public.org_credit_balances where org_id = new.org_id for update;
  -- Skip a duplicate key with no side effect. This runs after the balance lock, so a
  -- concurrent insert of the same key has committed and is visible here. It mirrors the
  -- unique index: a NULL project never matches. The index predicate is repeated so the
  -- lookup can use that partial index.
  if new.idempotency_key is not null and new.idempotency_key <> '' and exists (
       select 1 from public.org_credit_ledger l
       where l.org_id = new.org_id and l.project_id = new.project_id
         and l.idempotency_key = new.idempotency_key
         and l.idempotency_key is not null and l.idempotency_key <> '') then
    return null;
  end if;
  current_balance := coalesce(current_balance, 0) + new.delta;
  if new.delta < 0 and current_balance < 0 and not new.allow_overdraft then
    raise exception 'Insufficient credits for org %', new.org_id;
  end if;
  update public.org_credit_balances set balance = current_balance, updated_at = now() where org_id = new.org_id;
  new.balance_after := current_balance;
  return new;
end; $$ language plpgsql;

-- One row per platform-lane agent job (a credential-less AI job). A job
-- without a row has no platform lane. The billing fields are stamped when the
-- row is created and never change; the counters are the job's running totals.
create table if not exists public.ai_usage_jobs (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  run_id uuid,
  prompt_id uuid,
  -- record_only jobs are measured but never posted to the ledger.
  billing_mode text not null check (billing_mode in ('record_only','meter')),
  -- Units a declined ambient evaluation is not charged while no answer is
  -- recorded. Server-computed at dispatch, never read from the job payload.
  decline_waiver_units integer not null default 0 check (decline_waiver_units >= 0),
  answered_at timestamptz,
  -- sha256 of each job token the lease minted, keyed by lease attempt.
  token_sha256_by_attempt jsonb not null default '{}'::jsonb,
  requests integer not null default 0,
  unknown_requests integer not null default 0,
  input_tokens bigint not null default 0,
  cached_input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  by_source jsonb not null default '{}'::jsonb,
  -- Exact running cost in nano-USD. Units are rounded up once per job from it.
  cost_nano_usd bigint not null default 0 check (cost_nano_usd >= 0),
  units_due integer not null default 0,
  units_posted integer not null default 0 check (units_posted >= 0),
  stop_reason text,
  last_platform_lease_at timestamptz,
  last_settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_usage_jobs_prompt_idx on public.ai_usage_jobs(prompt_id);
create index if not exists ai_usage_jobs_run_idx on public.ai_usage_jobs(run_id);
create index if not exists ai_usage_jobs_org_lease_idx
  on public.ai_usage_jobs(org_id, last_platform_lease_at);
-- Every foreign key in this file has an index that leads with it, so an org or
-- project delete cascades by index instead of scanning a metering table under
-- lock. They are built here, while the tables are empty.
create index if not exists ai_usage_jobs_project_idx on public.ai_usage_jobs(project_id);
-- The per-org daily budget for declined-evaluation waivers counts only the
-- org's recent jobs that carry a waiver.
create index if not exists ai_usage_jobs_org_waiver_created_idx
  on public.ai_usage_jobs(org_id, created_at)
  where decline_waiver_units > 0;

-- One row per upstream request, keyed by the request id the proxy minted.
-- A replayed report must carry the same report_sha256.
create table if not exists public.ai_usage_events (
  request_id uuid primary key,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  lease_attempt integer not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  run_id uuid,
  route text not null check (route in ('responses','chat_completions')),
  source_tag text not null,
  served_by text not null check (served_by in ('controller_lease','static_api_key','static_chatgpt')),
  outcome text not null check (outcome in ('completed','incomplete','failed','rejected','unknown')),
  upstream_status integer, upstream_response_id text, upstream_model text,
  served_model text not null,
  output_ceiling integer,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  hosted_tool_calls integer not null default 0,
  estimated_input_tokens bigint,
  cost_nano_usd bigint not null default 0 check (cost_nano_usd >= 0),
  rates jsonb not null,
  flags text[] not null default '{}',  -- usage_missing, model_mismatch, hosted_tool,
                                       -- not_platform_lane, input_over_bound, unbound_token
  job_token_sha256 bytea not null,
  report_sha256 bytea not null,
  ledger_id uuid,
  proxy_instance_id text, latency_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_events_job_idx on public.ai_usage_events(job_id);
create index if not exists ai_usage_events_org_created_idx on public.ai_usage_events(org_id, created_at);
create index if not exists ai_usage_events_project_idx on public.ai_usage_events(project_id);

-- What counts toward a user's daily managed-AI limit. A subject counts once
-- per kind: prompt and evaluation_answer use the prompt id, steer the
-- agent_job_inputs id.
create table if not exists public.managed_ai_admissions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('prompt','steer','evaluation_answer')),
  subject_id uuid not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  unique (kind, subject_id)
);
create index if not exists managed_ai_admissions_user_created_idx
  on public.managed_ai_admissions(user_id, created_at);
create index if not exists managed_ai_admissions_org_idx on public.managed_ai_admissions(org_id);
create index if not exists managed_ai_admissions_project_idx on public.managed_ai_admissions(project_id);

alter table public.ai_usage_jobs enable row level security;
alter table public.ai_usage_events enable row level security;
alter table public.managed_ai_admissions enable row level security;
revoke all privileges on table public.ai_usage_jobs, public.ai_usage_events,
  public.managed_ai_admissions from public, anon, authenticated;
