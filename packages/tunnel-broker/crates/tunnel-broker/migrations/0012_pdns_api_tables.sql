-- Fill out the PowerDNS gpgsql schema so the REST API (and ACME DNS-01 tooling)
-- can list zones and create/delete RRsets reliably.

-- The upstream schema includes a few extra columns used by the API.
ALTER TABLE IF EXISTS domains
    ADD COLUMN IF NOT EXISTS options TEXT,
    ADD COLUMN IF NOT EXISTS catalog TEXT;

ALTER TABLE IF EXISTS domains
    ALTER COLUMN notified_serial TYPE BIGINT
    USING notified_serial::bigint;

CREATE INDEX IF NOT EXISTS domains_catalog_idx ON domains(catalog);

CREATE TABLE IF NOT EXISTS supermasters (
    ip INET NOT NULL,
    nameserver VARCHAR(255) NOT NULL,
    account VARCHAR(40) NOT NULL,
    PRIMARY KEY(ip, nameserver)
);

CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    domain_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(10) NOT NULL,
    modified_at INTEGER NOT NULL DEFAULT 0,
    account VARCHAR(40) DEFAULT NULL,
    comment VARCHAR(65535) NOT NULL DEFAULT ''
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'comments'::regclass
      AND contype = 'f'
      AND conname = 'domain_exists'
  ) THEN
    ALTER TABLE comments
      ADD CONSTRAINT domain_exists FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS comments_domain_id_idx ON comments(domain_id);
CREATE INDEX IF NOT EXISTS comments_name_type_idx ON comments(name, type);
CREATE INDEX IF NOT EXISTS comments_order_idx ON comments(domain_id, modified_at);

-- Ensure optional PowerDNS DNSSEC tables have the expected columns/constraints.
ALTER TABLE IF EXISTS domainmetadata
    ALTER COLUMN kind TYPE VARCHAR(32),
    ALTER COLUMN content TYPE TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'domainmetadata' AND relkind = 'r') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'domainmetadata'::regclass
        AND contype = 'f'
        AND conname = 'domain_exists'
    ) THEN
      ALTER TABLE domainmetadata
        ADD CONSTRAINT domain_exists FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS domainidmetaindex ON domainmetadata(domain_id);

ALTER TABLE IF EXISTS cryptokeys
    ADD COLUMN IF NOT EXISTS published BOOLEAN DEFAULT TRUE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'cryptokeys' AND relkind = 'r') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'cryptokeys'::regclass
        AND contype = 'f'
        AND conname = 'domain_exists'
    ) THEN
      ALTER TABLE cryptokeys
        ADD CONSTRAINT domain_exists FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS domainidindex ON cryptokeys(domain_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'tsigkeys' AND relkind = 'r') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'tsigkeys'
        AND indexname = 'namealgoindex'
    ) THEN
      CREATE UNIQUE INDEX namealgoindex ON tsigkeys(name, algorithm);
    END IF;
  END IF;
END $$;
