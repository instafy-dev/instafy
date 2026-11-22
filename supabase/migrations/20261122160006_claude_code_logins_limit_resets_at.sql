-- limit_resets_at: until when one of a person's Claude Code logins is at its
-- Claude plan's limit, as the controller alone records it
-- (docs/Local-Engine-Turns.md 11.20). Completion sets it when a turn on the
-- login, the one its lease took, fails as plan_limit, to the reset time the
-- turn reported, at most 8 days ahead, or one hour ahead when it gave none,
-- and clears it when a turn on the login completes. Null: no limit known. A
-- time that has passed holds nothing. A plan's limit is the subscription's,
-- so it holds on every computer the login is set up on: dispatch and the
-- lease pass over the login while it holds.
-- Its own file: adding a nullable column with no default holds ACCESS
-- EXCLUSIVE on claude_code_logins alone, briefly, and rewrites nothing.
set local lock_timeout = '5s';

alter table public.claude_code_logins
  add column limit_resets_at timestamptz;
