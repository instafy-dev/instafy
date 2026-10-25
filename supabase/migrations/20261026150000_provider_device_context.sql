-- What a provider device says of its own state, as plain text. Controller-only,
-- like the table.
set local lock_timeout = '5s';

-- context: at most 1,200 characters the device's owner sent with its last
-- heartbeat, which replaces it each time. A granted turn reads it as the
-- device's words, after the catalog's instructions; it is not part of the
-- catalog, so a grant does not pin it.
alter table public.project_provider_devices
  add column if not exists context text
    constraint project_provider_devices_context_length check (char_length(context) <= 1200);
