-- Reserve the managed credential id for the platform lane.
--
-- 4d414e41-4745-4441-8949-4e5354414659 is MANAGED_AI_CREDENTIAL_ID in
-- runtime-controller and openai-proxy-server: the id under which the
-- controller serves the managed lane's platform credential from its own
-- configuration. It is never a user credential, so no user_credentials row may
-- take it. Defence in depth: the controller also treats a row under this id as
-- absent wherever it resolves a user credential.
--
-- NOT VALID enforces the check for every new or updated row without scanning
-- existing rows under the ACCESS EXCLUSIVE lock. Validating it is deferred to
-- a later migration, once any row already stored under the id has been
-- handled; until then the controller treats such a row as absent, as above.
set local lock_timeout = '5s';

alter table public.user_credentials
  add constraint user_credentials_id_not_reserved
  check (id <> '4d414e41-4745-4441-8949-4e5354414659'::uuid) not valid;

comment on constraint user_credentials_id_not_reserved on public.user_credentials is
  'The managed lane''s platform credential id (MANAGED_AI_CREDENTIAL_ID) is reserved and never a user credential.';
