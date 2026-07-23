-- Fix idempotency_key unique index to be compatible with `ON CONFLICT (project_id, idempotency_key)`.
-- Postgres index inference does not match partial unique indexes unless the conflict clause also
-- includes a predicate, so prefer a plain unique index and rely on NULL semantics.

DROP INDEX IF EXISTS tunnels_idempotency_key_unique;

CREATE UNIQUE INDEX IF NOT EXISTS tunnels_idempotency_key_unique
    ON tunnels(project_id, idempotency_key);
