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

`supabase/supabase/migrations/` is an ignored generated working directory for the Supabase
CLI. Do not author or commit migrations there.
