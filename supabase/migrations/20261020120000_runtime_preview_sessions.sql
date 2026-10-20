-- Viewer sessions of private site previews. Opening a preview in Studio
-- mints a random hostname label (the capability) for one user and one
-- preview tunnel. Only its sha256 is stored here; the raw label lives in the
-- viewer's frame URL and nowhere else. The tunnel broker asks the controller
-- about every label it has not cached, and the controller allows it while
-- the session is not revoked, idle under 30 minutes and under 12 hours old,
-- the preview grant is still active, and the user may still see the runtime.
--
-- extended_by_use: a session the Studio pane opened is kept alive only by the
-- pane's authenticated heartbeat. Requests through the preview do not push
-- its idle timer forward: the label is in the page's origin, which browsers
-- send to every third party the site calls, so traffic alone must not keep a
-- label working after the member stops looking. A session opened for a
-- separate browser tab has no heartbeat, so its own traffic extends it.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.runtime_preview_sessions (
  capability_hash text primary key check (capability_hash ~ '^[0-9a-f]{64}$'),
  tunnel_id text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz,
  extended_by_use boolean not null default false
);

-- A grant's revocation ends its sessions by tunnel.
create index runtime_preview_sessions_tunnel_idx
  on public.runtime_preview_sessions(tunnel_id);
-- The mint trims a viewer's live sessions per preview.
create index runtime_preview_sessions_viewer_idx
  on public.runtime_preview_sessions(user_id, tunnel_id, created_at desc);
-- The retention prune deletes old rows.
create index runtime_preview_sessions_created_idx
  on public.runtime_preview_sessions(created_at);

alter table public.runtime_preview_sessions enable row level security;
revoke all on public.runtime_preview_sessions from anon, authenticated;
grant all on public.runtime_preview_sessions to service_role;
