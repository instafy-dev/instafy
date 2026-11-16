-- Inline editor completions and conversation titles run on a person's own
-- saved AI connection, through the model proxy, outside any job. The
-- controller now counts them per person as it counts connection tests
-- (`ai_connection_limits` in the runtime controller): a receipt for each call
-- it sends to the proxy, counted under an advisory lock with the database
-- clock in a rolling minute and hour. Their receipts use credential_id for
-- the connection the call ran on.
--
-- A side call has nothing pending once it is recorded, so its receipt is
-- written with completed_at set and never counts as a pending ChatGPT login.
-- The retention loop keeps these receipts two hours.
--
-- Controller only, as before: RLS stays on and no client policy exists.
set local lock_timeout = '5s';

alter table public.ai_connection_attempts
  drop constraint ai_connection_attempts_action_check,
  add constraint ai_connection_attempts_action_check
    check (action in (
      'credential_test',
      'codex_device_auth',
      'editor_completion',
      'conversation_title'
    ));

comment on table public.ai_connection_attempts is
  'Controller-internal receipts for AI-connection tests, ChatGPT device-login starts, inline editor completions and conversation titles, counted for per-person and global limits; service-role access only.';
