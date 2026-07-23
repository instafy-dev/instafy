-- Allow multiple ingress nodes to reuse the same rathole port ranges.
-- Ports must only be unique per ingress node, not globally.

DROP INDEX IF EXISTS tunnels_rathole_port_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS tunnels_rathole_port_ingress_active_idx
    ON tunnels (ingress_id, rathole_port)
    WHERE rathole_port IS NOT NULL AND status != 'revoked';
