-- A person's Claude Code logins (docs/Local-Engine-Turns.md 11.19). A login is a
-- Claude Code configuration folder (CLAUDE_CONFIG_DIR) on one of the person's
-- computers that they signed in to themselves, with Claude Code's own /login;
-- the same login is set up on each of their computers with a folder of its own.
-- A row is only the login's id and the name its person gives it: it holds no
-- folder, path, account or sign-in, and Instafy signs nobody in. An agent names
-- the login its turns run on (user_agents.claude_code_login_id), a lane job the
-- logins it may run on and the one its lease took (agent_jobs), and a runtime's
-- attested claudeCode capability which of them are ready on that computer.
--
-- label: what Studio shows, trimmed, 1 to 60 characters, unique among the
-- person's labels ignoring case. The controller also refuses control
-- characters, and more than 10 logins a person. The first login is the
-- person's oldest (created_at, id): an agent that names none uses it.
-- unique (id, user_id): the target of user_agents' composite reference, which
-- keeps an agent from naming another person's login, whoever writes the row.
--
-- Controller only: RLS is on, only the service role has a policy, and neither
-- browser role holds a privilege. The new table references only auth.users.
set local lock_timeout = '5s';

create table public.claude_code_logins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (label = btrim(label) and char_length(label) between 1 and 60)
);

comment on table public.claude_code_logins is
  'A person''s Claude Code logins (docs/Local-Engine-Turns.md 11.19): an id and the label its person gives it. It holds no folder, path, account or sign-in.';

-- One label per person, ignoring case.
create unique index claude_code_logins_user_label_idx
  on public.claude_code_logins (user_id, lower(label));
-- A person's logins oldest first, the first login among them, as the routes,
-- dispatch and the lease read them.
create index claude_code_logins_user_created_idx
  on public.claude_code_logins (user_id, created_at, id);

create trigger claude_code_logins_set_updated_at
  before update on public.claude_code_logins
  for each row execute function public.set_timestamp();

alter table public.claude_code_logins enable row level security;
create policy "claude code logins service role" on public.claude_code_logins
  for all using (public.current_request_role() = 'service_role')
  with check (true);
revoke all privileges on table public.claude_code_logins from public, anon, authenticated;
