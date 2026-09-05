-- Optional exact native-build targeting; NULL preserves existing release compatibility.
alter table public.ota_releases
  add column if not exists required_native_build text;

-- Operational diagnostics retain the native build separately from the marketing version.
alter table public.ota_device_states
  add column if not exists native_build text;
alter table public.ota_events
  add column if not exists native_build text;
