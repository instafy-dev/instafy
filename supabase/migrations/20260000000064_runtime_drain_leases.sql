-- Desktop update/quit fencing is a renewable lease, not a permanent runtime
-- state. If Electron crashes or loses the resume response, an actively
-- heartbeating runtime automatically becomes schedulable again after expiry.
alter table public.runtimes
  add column if not exists drain_expires_at timestamptz;

create index if not exists runtimes_drain_expires_at_idx
  on public.runtimes (drain_expires_at)
  where drain_expires_at is not null;

comment on column public.runtimes.drain_expires_at is
  'Expiry of the renewable desktop quit/update lease fence; null when schedulable.';
