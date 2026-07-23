-- Ensure idempotency keys dedupe regardless of `reason` (retries should not double-burn).

DROP INDEX IF EXISTS org_credit_ledger_idempotency_unique;

CREATE UNIQUE INDEX IF NOT EXISTS org_credit_ledger_idempotency_unique
    ON org_credit_ledger(org_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
