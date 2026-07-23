-- Verifies that every project_id reference across core tables is a valid UUID
-- and that the referenced project exists. Run with `psql -f supabase/scripts/verify_project_ids.sql`.

\pset tuples_only on
\pset format aligned

WITH invalid_project_rows AS (
  SELECT 'org_credit_ledger', project_id::text
  FROM org_credit_ledger
  WHERE project_id IS NOT NULL
    AND project_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  UNION ALL
  SELECT 'sites', project_id::text
  FROM sites
  WHERE project_id IS NULL OR project_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  UNION ALL
  SELECT 'runs', project_id::text
  FROM runs
  WHERE project_id IS NULL OR project_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  UNION ALL
  SELECT 'build_runs', project_id::text
  FROM build_runs
  WHERE project_id IS NULL OR project_id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)
SELECT *
FROM invalid_project_rows
ORDER BY table_name
\gset

\if :ROWCOUNT > 0
\echo '❌ Found rows with non-UUID project_id values. Inspect the results above.'
\else
\echo '✅ All project_id columns contain valid UUIDs.'
\endif

WITH orphan_rows AS (
  SELECT 'org_credit_ledger', project_id
  FROM org_credit_ledger cl
  WHERE project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = cl.project_id)
  UNION ALL
  SELECT 'sites', project_id
  FROM sites s
  WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id)
  UNION ALL
  SELECT 'runs', project_id
  FROM runs r
  WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = r.project_id)
  UNION ALL
  SELECT 'build_runs', project_id
  FROM build_runs br
  WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = br.project_id)
)
SELECT *
FROM orphan_rows
ORDER BY table_name
\gset

\if :ROWCOUNT > 0
\echo '❌ Some project_id references do not match rows in projects.'
\else
\echo '✅ All project_id references point at an existing project.'
\endif
