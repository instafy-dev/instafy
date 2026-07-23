-- Per-tunnel rathole ingress bindings (service name + public port).

ALTER TABLE tunnels
    ADD COLUMN IF NOT EXISTS rathole_service TEXT,
    ADD COLUMN IF NOT EXISTS rathole_port INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS tunnels_rathole_port_active_idx
    ON tunnels (rathole_port)
    WHERE rathole_port IS NOT NULL AND status != 'revoked';
