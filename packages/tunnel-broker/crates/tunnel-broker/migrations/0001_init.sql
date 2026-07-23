-- Base schema for tunnel broker. Safe to run on a standalone Postgres instance.

CREATE TABLE IF NOT EXISTS ingress_nodes (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 443,
    ipv4 TEXT,
    ipv6 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ingress_nodes_host_port_idx ON ingress_nodes(host, port);

CREATE TABLE IF NOT EXISTS tunnels (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL,
    runtime_id UUID,
    lease_id UUID,
    ingress_id UUID NOT NULL REFERENCES ingress_nodes(id) ON DELETE RESTRICT,
    hostname TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',
    token TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ,
    url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS tunnels_project_id_idx ON tunnels(project_id);
CREATE INDEX IF NOT EXISTS tunnels_runtime_id_idx ON tunnels(runtime_id);
CREATE INDEX IF NOT EXISTS tunnels_hostname_idx ON tunnels(hostname);
CREATE INDEX IF NOT EXISTS tunnels_expires_at_idx ON tunnels(expires_at);

CREATE TABLE IF NOT EXISTS dns_records (
    id UUID PRIMARY KEY,
    tunnel_id UUID REFERENCES tunnels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    record_type TEXT NOT NULL,
    value TEXT NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 60,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dns_records_name_idx ON dns_records(name);
CREATE INDEX IF NOT EXISTS dns_records_expires_at_idx ON dns_records(expires_at);
