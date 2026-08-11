-- Revoked tunnels no longer need their client credential. Scrub historical
-- rows first, then make the invariant fail closed for every future writer.

UPDATE tunnels
SET token = '',
    token_expires_at = NULL
WHERE status = 'revoked'
  AND (token <> '' OR token_expires_at IS NOT NULL);

ALTER TABLE tunnels
    ADD CONSTRAINT tunnels_revoked_token_scrubbed
    CHECK (
        status <> 'revoked'
        OR (token = '' AND token_expires_at IS NULL)
    ) NOT VALID;

ALTER TABLE tunnels
    VALIDATE CONSTRAINT tunnels_revoked_token_scrubbed;
