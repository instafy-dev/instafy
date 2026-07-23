-- Add idempotency support for create tunnel requests.

ALTER TABLE IF EXISTS tunnels
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS tunnels_idempotency_key_unique
    ON tunnels(project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
