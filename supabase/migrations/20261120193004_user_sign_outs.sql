-- When each person last signed out everywhere (`POST /me/sign-out-everywhere`).
-- The controller then refuses every credential they signed in for at or
-- before that second: their Supabase access tokens, by `iat`, and controller
-- sessions, by the sign-in each carries. Each controller keeps the recent
-- rows in memory, read again every 30 seconds; a runtime token mint, an agent
-- login, a device grant and a preview viewer session read the person's row
-- under their owner lock instead. One row per person, moved forward by each
-- sign-out and never back. No token is stored.
--
-- Controller only: RLS is on and no client policy exists.
set local lock_timeout = '5s';

create table public.user_sign_outs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  signed_out_at timestamptz not null
);

-- Each controller reads the recent sign-outs.
create index user_sign_outs_signed_out_at_idx
  on public.user_sign_outs (signed_out_at);

alter table public.user_sign_outs enable row level security;
revoke all on public.user_sign_outs from anon, authenticated;
grant all on public.user_sign_outs to service_role;
