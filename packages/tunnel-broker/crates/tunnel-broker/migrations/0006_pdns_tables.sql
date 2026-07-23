-- Minimal PowerDNS gpgsql support tables (empty by default).

CREATE TABLE IF NOT EXISTS domainmetadata (
    id SERIAL PRIMARY KEY,
    domain_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cryptokeys (
    id SERIAL PRIMARY KEY,
    domain_id INTEGER NOT NULL,
    flags INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT false,
    content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tsigkeys (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    secret TEXT NOT NULL
);

