-- limit_resets_at: until when one of a person's connections is at its plan's
-- usage limit, as the controller alone records it (docs/Local-Engine-Turns.md
-- 11.20). Completion sets it when a turn on the connection fails with its
-- provider's usage-limit error, to the reset time the turn reported, at most
-- 8 days ahead, or one hour ahead when it gave none, and clears it when a turn
-- on the connection completes. Null: no limit known. A time that has passed
-- holds nothing. Dispatch runs an agent's next turns on its next AI with room
-- while it holds.
-- Its own file: adding a nullable column with no default holds ACCESS
-- EXCLUSIVE on user_credentials alone, briefly, and rewrites nothing.
set local lock_timeout = '5s';

alter table public.user_credentials
  add column limit_resets_at timestamptz;
