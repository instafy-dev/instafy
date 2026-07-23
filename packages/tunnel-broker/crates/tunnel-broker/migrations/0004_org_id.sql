ALTER TABLE tunnels
    ADD COLUMN IF NOT EXISTS org_id UUID;

CREATE INDEX IF NOT EXISTS tunnels_org_id_idx ON tunnels(org_id);

