-- The country an OTA or desktop update event came from: the two-letter code
-- of the request's CF-IPCountry header (geo.rs), or null without one. The
-- operator download insights group events by it.
--
-- The OTA and desktop update routes of earlier releases added this column
-- themselves the first time they ran, so a database they served already has
-- it. Those routes no longer create tables or columns: these migrations alone
-- define ota_events and desktop_update_events.
--
-- Nullable with no default, so nothing is rewritten under the ACCESS EXCLUSIVE
-- lock each statement takes. Controller only: RLS stays on and clients keep
-- no privileges on either table.
set local lock_timeout = '5s';

alter table public.ota_events
  add column if not exists country_code text;

alter table public.desktop_update_events
  add column if not exists country_code text;
