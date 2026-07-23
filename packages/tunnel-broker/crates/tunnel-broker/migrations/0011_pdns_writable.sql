-- Switch PowerDNS backend to writable `domains`/`records` tables.
-- This enables the PowerDNS REST API (and tools like Traefik/lego) to create/delete
-- TXT challenges for ACME DNS-01 (wildcard certificates).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'records' AND relkind = 'v') THEN
    EXECUTE 'DROP VIEW records';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'domains' AND relkind = 'v') THEN
    EXECUTE 'DROP VIEW domains';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pdns_records' AND relkind = 'v') THEN
    EXECUTE 'DROP VIEW pdns_records';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS domains (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'NATIVE',
    master TEXT,
    notified_serial INTEGER,
    last_check INTEGER,
    account TEXT
);

CREATE TABLE IF NOT EXISTS records (
    id SERIAL PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 60,
    prio INTEGER,
    change_date INTEGER,
    disabled BOOLEAN NOT NULL DEFAULT false,
    ordername TEXT,
    auth BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS records_domain_id_idx ON records(domain_id);
CREATE INDEX IF NOT EXISTS records_name_idx ON records(name);
CREATE INDEX IF NOT EXISTS records_name_type_idx ON records(name, type);
