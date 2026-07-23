-- PowerDNS-compatible domain table and view to expose broker-managed records.

CREATE TABLE IF NOT EXISTS pdns_domains (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL DEFAULT 'NATIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- View that maps broker dns_records into the schema PowerDNS expects (records table).
CREATE OR REPLACE VIEW pdns_records AS
WITH domain AS (
    SELECT id, name FROM pdns_domains ORDER BY updated_at DESC LIMIT 1
),
ingress AS (
    SELECT ipv4 FROM ingress_nodes ORDER BY updated_at DESC LIMIT 1
),
static_records AS (
    SELECT name, 'NS'::text AS record_type, ('ns1.' || name) AS value, 60 AS ttl FROM domain
    UNION ALL
    SELECT name, 'SOA'::text AS record_type,
        format('ns1.%s admin.%s 1 120 60 86400 30', name, name) AS value, 60 AS ttl FROM domain
    UNION ALL
    SELECT ('ns1.' || domain.name) AS name, 'A'::text AS record_type,
        COALESCE(ingress.ipv4, '127.0.0.1') AS value, 60 AS ttl
    FROM domain CROSS JOIN ingress
),
dynamic_records AS (
    SELECT name, record_type, value, ttl
    FROM dns_records
    WHERE expires_at IS NULL OR expires_at > NOW()
)
SELECT row_number() OVER ()::bigint AS id,
       domain.id AS domain_id,
       records.name,
       records.record_type AS type,
       records.value AS content,
       records.ttl,
       0::int AS prio,
       false AS disabled,
       true AS auth
FROM (SELECT * FROM static_records UNION ALL SELECT * FROM dynamic_records) records, domain;
