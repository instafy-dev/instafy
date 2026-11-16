-- Per-minute counts of the side calls a person's own saved AI connection
-- answers outside any job: inline editor completions and conversation titles.
-- The controller counts a person's last hour of them from these rows, at most
-- 61 per person and kind, instead of reading every receipt of the hour
-- (`ai_connection_limits` in the runtime controller). The last minute is still
-- counted exactly from the receipts in ai_connection_attempts. The hour counts
-- whole minutes, so it can refuse a call up to a minute before an exact count
-- of the hour would.
--
-- Each counted call adds one to its minute's row, under the person's advisory
-- lock for that kind of call. Rows change once a call at typing speed, so the
-- table leaves room on each page for those updates to stay on it. The
-- retention loop deletes rows after two hours.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.ai_side_call_minutes (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null
    check (action in ('editor_completion', 'conversation_title')),
  -- The start of the minute, as date_trunc('minute', ...) gives it.
  minute_start timestamptz not null,
  calls integer not null check (calls > 0),
  primary key (user_id, action, minute_start)
) with (fillfactor = 70);

-- The retention prune.
create index ai_side_call_minutes_minute_start_idx
  on public.ai_side_call_minutes (minute_start);

alter table public.ai_side_call_minutes enable row level security;
revoke all on public.ai_side_call_minutes from public, anon, authenticated;
grant all on public.ai_side_call_minutes to service_role;

comment on table public.ai_side_call_minutes is
  'Controller-internal per-minute counts of inline editor completions and conversation titles, counted for per-person hourly limits; service-role access only.';
