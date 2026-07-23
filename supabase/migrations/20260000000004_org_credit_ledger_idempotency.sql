-- Add idempotency support to org credit burns/refills.

ALTER TABLE IF EXISTS org_credit_ledger
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS org_credit_ledger_idempotency_unique
    ON org_credit_ledger(org_id, project_id, reason, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
