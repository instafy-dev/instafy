-- The ingress sidecar runs next to rathole and records, for each live tunnel it serves, whether
-- the site behind it answered HTTP at its last round. A broker that is not beside that rathole
-- answers GET /tunnels/:id/probe from this record.
-- listening_status is the HTTP status that came back, or NULL when nothing answered.

ALTER TABLE tunnels
    ADD COLUMN IF NOT EXISTS listening_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS listening_status integer;
