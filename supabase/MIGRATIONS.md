# Supabase migration contract

`supabase/migrations/` is the canonical public migration history. A clean public checkout
must be able to initialize and upgrade its database using this track alone.

The history through version `20260000000063` predates the open-core split. New public
migrations use a current 14-digit UTC timestamp greater than the newest migration, with an
even final digit. Do not backfill unused numbers: migration history is append-only.
Downstream distributions may use current timestamps in the reserved odd-numbered lane,
without changing or becoming a prerequisite of the public history.

The private distribution records every successfully released public-plus-private migration
as a content-bound version set. Before applying, it requires every recorded migration to be
unchanged and present, and permits production history to contain only that released set plus
the already-applied prefix of migrations that the exact current composed plan adds beyond the
set. The database query remains globally version-sorted, so released and current-only entries
may interleave. This admits a safe retry after a partially applied release and allows a later
public migration to sort before an already released private migration. Apply uses
`--include-all` so every current migration absent from production is still applied; skipped,
unknown, removed, reordered, or modified released history fails closed.

Each migration file runs in its own transaction and holds every lock it takes until it
commits; a foreign key, for example, holds a `SHARE ROW EXCLUSIVE` lock on the table it
references, and an `UPDATE` holds the row locks of the rows it changed. A migration therefore
must not contain a top-level `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK` or
`ABORT`; `node scripts/check-supabase-migrations.mjs` rejects them.

Live requests lock any two of `agent_jobs`, `org_credit_ledger` and `org_credit_balances` in
both orders, so one migration must not write or lock two of them, or a request can deadlock
against it; reading the others is safe. Completion updates `agent_jobs` before it writes the
ledger, and dispatch writes the ledger before `agent_jobs`. `org_credit_balances` is in the set
because every insert into the ledger locks the ledger and then runs a trigger that writes and
locks the org's balance row, while a credit burn locks that balance row for its daily refill
before it writes the ledger, and dispatch burns credits before it writes `agent_jobs`. Change
each of the three in its own migration, as `20260929100000_managed_ai_metering_ledger.sql` and
`20260929100100_managed_ai_metering_tables.sql` do.

The empty-database test (`pnpm test:migrations:empty-db`) reads the table locks every
migration after `20260000000063` holds before it commits. It fails when one migration holds
on two of the tables any lock other than `ACCESS SHARE` (a plain read) or
`SHARE UPDATE EXCLUSIVE`, neither of which a live write waits on. That covers the `SHARE` and
stronger locks of schema changes and the `ROW SHARE` or `ROW EXCLUSIVE` lock that comes with
`SELECT ... FOR UPDATE`, `INSERT`, `UPDATE` and `DELETE`, which Postgres takes even when a
statement matches no rows. It reads the locks in the migration's own transaction: it prints the
transaction id before the migration and again with the locks, and fails when the two differ or
psql warns that a transaction is already or no longer in progress. The test cannot see a lock
taken only for a row that exists, such as a foreign-key check or a row trigger that writes
another of the tables, because the empty database has no rows; every row inserted into
`org_credit_ledger`, for example, also writes `org_credit_balances` through its trigger. Review
a migration that changes data in one of the tables for such a lock on the others by hand.

`supabase/supabase/migrations/` is an ignored generated working directory for the Supabase
CLI. Do not author or commit migrations there.
