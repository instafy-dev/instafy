-- Keep private runtime and origin routing data behind the controller.
--
-- The controller applies immutable-owner checks to self-hosted runtimes and
-- redacts private runtime state from teammates. Project-member SELECT policies
-- on these raw operational tables bypass that boundary and expose machine,
-- tunnel, origin, device, and arbitrary metadata. No browser/desktop/CLI
-- product path reads these tables directly; the controller is the canonical
-- authorization and presentation surface.

drop policy if exists "runtimes project read" on public.runtimes;
drop policy if exists "runtime leases project read" on public.runtime_leases;
drop policy if exists "runtime tunnel grants project read" on public.runtime_tunnel_grants;
drop policy if exists "workspace origins project read" on public.workspace_origins;
drop policy if exists "origin presence project read" on public.origin_presence;
drop policy if exists "origin instances project read" on public.origin_instances;
drop policy if exists "workspace commit receipts project read" on public.workspace_commit_receipts;

revoke all privileges on table public.runtimes from anon, authenticated;
revoke all privileges on table public.runtime_leases from anon, authenticated;
revoke all privileges on table public.runtime_tunnel_grants from anon, authenticated;
revoke all privileges on table public.workspace_origins from anon, authenticated;
revoke all privileges on table public.origin_presence from anon, authenticated;
revoke all privileges on table public.origin_instances from anon, authenticated;
revoke all privileges on table public.workspace_commit_receipts from anon, authenticated;

-- Runtime telemetry became controller-only in migration 54. Repeat the
-- lockdown idempotently so the full runtime operational boundary is explicit
-- even when an environment was provisioned from a non-canonical baseline.
drop policy if exists "runtime events project read" on public.runtime_events;
revoke all privileges on table public.runtime_events from anon, authenticated;
