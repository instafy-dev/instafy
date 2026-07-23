-- Migration 53: runtime provider ids are compared through the controller's normalized route
-- key (case-insensitive, with hyphen/underscore/space runs collapsed). Prevent
-- two rows from claiming the same route: otherwise launch and release could
-- resolve different endpoints for one provider generation.
--
-- The table is operational configuration and is expected to stay tiny. Keep a
-- short lock timeout so a production deploy fails safely instead of waiting
-- behind a long writer and blocking provider registration indefinitely.
set lock_timeout = '5s';

create unique index if not exists runtime_providers_normalized_id_unique
  on runtime_providers (
    (btrim(lower(regexp_replace(btrim(id), '[-_[:space:]]+', '_', 'g')), '_'))
  );

reset lock_timeout;
