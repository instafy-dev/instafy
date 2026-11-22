-- claude_code_login_id: the Claude Code login a Claude Code agent's turns run
-- on (docs/Local-Engine-Turns.md 11.19). Only its owner sets it, through their
-- own session, to one of their own logins, and only on an agent whose AI is
-- Claude Code; choosing a connection or Instafy AI clears it. Null: the
-- owner's first login, their oldest. The reference is on (claude_code_login_id,
-- user_id), so an agent can only name a login of its own owner's, whoever
-- writes the row, and deleting the login clears the column alone, leaving
-- user_id as it is (Postgres 15's column list for SET NULL).
--
-- Its own file because it holds ACCESS EXCLUSIVE on user_agents, one of the
-- tables live requests write together (MIGRATIONS.md). The reference holds
-- SHARE ROW EXCLUSIVE on claude_code_logins, which the rules allow. It is NOT
-- VALID, so nothing is checked under that lock: checking the rows would also
-- row-share lock claude_code_logins, which the rules refuse beside
-- user_agents' lock. It holds for every row written from now on, and the
-- column is new and null in every row there is; 20261122140010 validates it.
set local lock_timeout = '5s';

alter table public.user_agents
  add column claude_code_login_id uuid,
  add constraint user_agents_claude_code_login_fkey
    foreign key (claude_code_login_id, user_id)
    references public.claude_code_logins (id, user_id)
    on delete set null (claude_code_login_id)
    not valid;
