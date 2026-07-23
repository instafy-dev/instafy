-- Authoritative DNS nodes for PowerDNS.
-- If dns_nodes is populated, NS + glue records are emitted for these nodes.
-- If empty, fall back to a single ns1.<zone> pointing at the most recently updated ingress node (or 127.0.0.1).

CREATE TABLE IF NOT EXISTS dns_nodes (
    id UUID PRIMARY KEY,
    hostname TEXT NOT NULL,
    ipv4 TEXT,
    ipv6 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS dns_nodes_hostname_idx ON dns_nodes(hostname);

CREATE OR REPLACE VIEW pdns_records AS
WITH domain AS (
    SELECT id, name FROM pdns_domains ORDER BY updated_at DESC LIMIT 1
),
configured_dns_nodes AS (
    SELECT hostname, ipv4, ipv6
    FROM dns_nodes
    WHERE ipv4 IS NOT NULL OR ipv6 IS NOT NULL
),
fallback_dns_node AS (
    SELECT
        'ns1'::text AS hostname,
        COALESCE(
            (SELECT ipv4 FROM ingress_nodes WHERE ipv4 IS NOT NULL ORDER BY updated_at DESC LIMIT 1),
            '127.0.0.1'
        ) AS ipv4,
        (SELECT ipv6 FROM ingress_nodes WHERE ipv6 IS NOT NULL ORDER BY updated_at DESC LIMIT 1) AS ipv6
),
selected_dns_nodes AS (
    SELECT * FROM configured_dns_nodes
    UNION ALL
    SELECT * FROM fallback_dns_node
    WHERE NOT EXISTS (SELECT 1 FROM configured_dns_nodes)
),
primary_ns AS (
    SELECT hostname FROM selected_dns_nodes ORDER BY hostname LIMIT 1
),
static_records AS (
    SELECT domain.name AS name, 'NS'::text AS record_type, (dns.hostname || '.' || domain.name) AS value, 60 AS ttl
    FROM domain CROSS JOIN selected_dns_nodes dns
    UNION ALL
    SELECT domain.name AS name, 'SOA'::text AS record_type,
        format('%s.%s admin.%s 1 120 60 86400 30', primary_node.hostname, domain.name, domain.name) AS value, 60 AS ttl
    FROM domain CROSS JOIN primary_ns primary_node
    UNION ALL
    SELECT (dns.hostname || '.' || domain.name) AS name, 'A'::text AS record_type, dns.ipv4 AS value, 60 AS ttl
    FROM domain CROSS JOIN selected_dns_nodes dns
    WHERE dns.ipv4 IS NOT NULL
    UNION ALL
    SELECT (dns.hostname || '.' || domain.name) AS name, 'AAAA'::text AS record_type, dns.ipv6 AS value, 60 AS ttl
    FROM domain CROSS JOIN selected_dns_nodes dns
    WHERE dns.ipv6 IS NOT NULL
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
