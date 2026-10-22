-- What the controller learned about each AI upstream's rate limit, to pace
-- when team plan agents start (`upstream_pacing` in the runtime controller).
--
-- The lanes of every team on one upstream (a person's own credential, or the
-- platform's model proxy) share its limit. A run that stops on the provider
-- rate-limit kind states a wait: until cooldown_until no plan agent of that
-- upstream starts. The same stop halves how many may run at once (ceiling,
-- at most once per congestion event, decreased_at); each plan agent that
-- ends without one raises it a little. What is learned applies for a while
-- after last_rate_limited_at, then the upstream is open again.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.upstream_pacing (
  upstream_key text primary key check (char_length(upstream_key) <= 200),
  cooldown_until timestamptz,
  ceiling double precision not null check (ceiling >= 1),
  last_rate_limited_at timestamptz not null,
  decreased_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.upstream_pacing enable row level security;
revoke all on public.upstream_pacing from anon, authenticated;
grant all on public.upstream_pacing to service_role;
