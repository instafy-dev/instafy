-- Automations: add one-shot ("once") schedule support.
--
-- Note: Instafy Studio is not live yet; no backfills/migrations required beyond schema updates.

alter table if exists automations
  add column if not exists run_at timestamptz;

-- Expand allowed schedule kinds.
alter table if exists automations
  drop constraint if exists automations_schedule_kind_check;

alter table if exists automations
  add constraint automations_schedule_kind_check
  check (schedule_kind in ('hourly', 'weekly', 'once'));

-- Replace schedule field constraint to include one-shot schedules.
alter table if exists automations
  drop constraint if exists automations_schedule_fields;

alter table if exists automations
  add constraint automations_schedule_fields check (
    (
      schedule_kind = 'hourly'
      and interval_hours is not null
      and interval_hours >= 1
      and by_hour is null
      and by_minute is null
      and run_at is null
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
      and run_at is null
    )
    or (
      schedule_kind = 'once'
      and interval_hours is null
      and by_hour is null
      and by_minute is null
      and coalesce(array_length(by_day, 1), 0) = 0
      and run_at is not null
    )
  );

