-- backup_ais: an agent's backup AIs (docs/Local-Engine-Turns.md 11.20). After
-- its first AI, an agent lists up to 8 more of its owner's own sign-ins, in
-- order: {"credentialId": "<uuid>"}, one of their connections, or
-- {"claudeCodeLoginId": "<uuid>"}, one of their Claude Code logins. Only its
-- owner sets it, through their own session, and only on an agent whose first
-- AI is one of their connections or Claude Code; choosing Instafy AI or the
-- default clears it. Dispatch runs each turn on the first of the agent's AIs
-- with room, and checks again there that each entry is its owner's, so an
-- entry of anyone else's, or of a connection revoked or a login deleted since,
-- is passed over.
--
-- The check keeps it an array of at most 8 entries. It is added NOT VALID in
-- the same statement as the column, whose default is a constant, so nothing
-- is rewritten or scanned under the ACCESS EXCLUSIVE lock this holds on
-- user_agents, one of the tables live requests write together
-- (MIGRATIONS.md). Every row there is holds the default, '[]';
-- 20261122160002 validates the check.
set local lock_timeout = '5s';

alter table public.user_agents
  add column backup_ais jsonb not null default '[]'::jsonb,
  add constraint user_agents_backup_ais_check
    check (
      case
        when jsonb_typeof(backup_ais) = 'array' then jsonb_array_length(backup_ais) <= 8
        else false
      end
    )
    not valid;
