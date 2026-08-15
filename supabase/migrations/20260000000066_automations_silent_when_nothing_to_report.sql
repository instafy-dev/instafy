-- Automations may opt into suppressing successful runs that explicitly decline to report.
alter table public.automations
  add column if not exists silent_when_nothing_to_report boolean not null default false;

comment on column public.automations.silent_when_nothing_to_report is
  'When true, a successful automation run that explicitly returns NO_RESPONSE produces no completion result message or result push notification.';
