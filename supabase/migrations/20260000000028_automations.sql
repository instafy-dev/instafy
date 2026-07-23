-- Automations: scheduled prompts that run in the background.
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

create table if not exists automations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  prompt_text text not null default '',
  metadata jsonb not null default '{}'::jsonb,

  schedule_kind text not null check (schedule_kind in ('hourly', 'weekly')),
  interval_hours integer,
  by_day text[] not null default '{}'::text[],
  by_hour integer,
  by_minute integer,
  timezone text not null default 'UTC',

  runtime_mode text not null default 'auto' check (runtime_mode in ('auto', 'hosted', 'existing')),
  runtime_provider text,
  conversation_id uuid references conversations(id) on delete set null,

  status text not null default 'active' check (status in ('active', 'paused')),
  locked_until timestamptz,
  last_run_at timestamptz,
  next_run_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint automations_schedule_fields check (
    (
      schedule_kind = 'hourly'
      and interval_hours is not null
      and interval_hours >= 1
      and by_hour is null
      and by_minute is null
    )
    or (
      schedule_kind = 'weekly'
      and interval_hours is null
      and by_hour is not null
      and by_hour >= 0
      and by_hour <= 23
      and by_minute is not null
      and by_minute >= 0
      and by_minute <= 59
      and coalesce(array_length(by_day, 1), 0) >= 1
    )
  )
);

create index if not exists automations_project_idx on automations(project_id);
create index if not exists automations_user_idx on automations(user_id);
create index if not exists automations_due_idx on automations(status, next_run_at);
create index if not exists automations_lock_idx on automations(locked_until);

drop trigger if exists set_automations_updated_at on automations;
create trigger set_automations_updated_at
  before update on automations
  for each row
  execute function set_timestamp();

alter table if exists automations enable row level security;

drop policy if exists "automations service role" on automations;
create policy "automations service role" on automations
  for all using (public.current_request_role() = 'service_role')
  with check (true);

drop policy if exists "automations project read" on automations;
create policy "automations project read" on automations
  for select using (auth.uid() is not null and public.has_project_access(project_id));

drop policy if exists "automations self" on automations;
create policy "automations self" on automations
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

