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
references, and an `UPDATE` holds the row locks of the rows it changed. Live requests lock
`agent_jobs` and `org_credit_ledger` in both orders, so one migration must not write or lock
both, or a request can deadlock against it; reading one of them is safe. Change each of the
two in its own migration, as `20260929100000_managed_ai_metering_ledger.sql` and
`20260929100100_managed_ai_metering_tables.sql` do.

The empty-database test (`pnpm test:migrations:empty-db`) reads the table locks every
migration after `20260000000063` holds before it commits. It fails when one migration holds
on both tables any lock other than `ACCESS SHARE` (a plain read) or `SHARE UPDATE EXCLUSIVE`,
neither of which a live write waits on. That covers the `SHARE` and stronger locks of schema
changes and the `ROW SHARE` or `ROW EXCLUSIVE` lock that comes with `SELECT ... FOR UPDATE`,
`INSERT`, `UPDATE` and `DELETE`, which Postgres takes even when a statement matches no rows.
The test cannot see a lock taken only for a row that exists, such as a foreign-key check or a
row trigger that writes the other table, because the empty database has no rows. Review a
migration that changes data in one of the two tables for such a lock on the other by hand.

`supabase/supabase/migrations/` is an ignored generated working directory for the Supabase
CLI. Do not author or commit migrations there.
