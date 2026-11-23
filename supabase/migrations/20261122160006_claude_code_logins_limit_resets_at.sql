-- limit_resets_at: until when one of a person's Claude Code logins is at its
-- Claude plan's limit, as the controller alone records it
-- (docs/Local-Engine-Turns.md 11.20). Completion sets it when a turn on the
-- login, the one its lease took, fails as plan_limit, to the reset time the
-- turn reported, at most 8 days ahead, or one hour ahead when it gave none,
-- keeping a limit already recorded that resets later. Null: no limit known. A
-- time that has passed holds nothing. A plan's limit is the subscription's,
-- so it holds on every computer the login is set up on: dispatch and the
-- lease pass over the login while it holds.
-- limit_recorded_at: when completion last recorded that limit. A turn on the
-- login that completes clears the limit only when its lease came after this,
-- so a turn that started before the limit was reached, and finishes after,
-- leaves it standing.
-- Its own file: adding nullable columns with no default holds ACCESS
-- EXCLUSIVE on claude_code_logins alone, briefly, and rewrites nothing.
set local lock_timeout = '5s';

alter table public.claude_code_logins
  add column limit_resets_at timestamptz,
  add column limit_recorded_at timestamptz;
