-- Waking a stopped site preview, and how long viewing keeps a space awake.
--
-- runtime_preview_wakes: `instafy preview open` records how the site was
-- started (grant metadata `_instafyPreview.serve`: argv and a
-- workspace-relative directory). When a member opens a preview whose runtime
-- slept, the controller starts the runtime again and leaves a wake here; the
-- runtime agent claims it, starts the recorded command without a model turn,
-- reconnects the preview tunnel and reports back. No agent job, run or chat
-- message is created. One open wake (pending or claimed) per preview; the
-- rows double as the audit trail (who asked, when, how it ended) and the
-- rate limit's window.
--
-- runtime_preview_viewing_windows: viewing a preview (the pane's heartbeat,
-- a tab's own traffic) is activity in the space, but each person's viewing
-- keeps a space's runtime up for at most four hours a day, counted from
-- started_at. One row per (space, person), so a new session does not start a
-- new window.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.runtime_preview_wakes (
  id uuid primary key default gen_random_uuid(),
  tunnel_id text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  runtime_id uuid not null,
  requested_by uuid references auth.users(id) on delete set null,
  state text not null default 'pending'
    check (state in ('pending', 'claimed', 'done', 'failed')),
  error text check (error is null or char_length(error) <= 500),
  claim_count integer not null default 0,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);

create unique index runtime_preview_wakes_one_open_idx
  on public.runtime_preview_wakes(tunnel_id)
  where state in ('pending', 'claimed');

create index runtime_preview_wakes_runtime_open_idx
  on public.runtime_preview_wakes(runtime_id)
  where state in ('pending', 'claimed');

create index runtime_preview_wakes_tunnel_created_idx
  on public.runtime_preview_wakes(tunnel_id, created_at desc);

create index runtime_preview_wakes_requester_idx
  on public.runtime_preview_wakes(project_id, requested_by, created_at desc);

alter table public.runtime_preview_wakes enable row level security;
revoke all on public.runtime_preview_wakes from anon, authenticated;
grant all on public.runtime_preview_wakes to service_role;

create table public.runtime_preview_viewing_windows (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

alter table public.runtime_preview_viewing_windows enable row level security;
revoke all on public.runtime_preview_viewing_windows from anon, authenticated;
grant all on public.runtime_preview_viewing_windows to service_role;
