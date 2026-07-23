-- Compatibility views for PowerDNS gpgsql backend, which expects `domains` and `records`.

CREATE OR REPLACE VIEW domains AS
SELECT
    id,
    name,
    type,
    NULL::text AS master,
    0::int AS notified_serial,
    NULL::int AS last_check,
    NULL::text AS account
FROM pdns_domains;

CREATE OR REPLACE VIEW records AS
SELECT
    id,
    domain_id,
    name,
    type,
    content,
    ttl,
    prio,
    EXTRACT(EPOCH FROM NOW())::int AS change_date,
    disabled,
    NULL::text AS ordername,
    auth
FROM pdns_records;

