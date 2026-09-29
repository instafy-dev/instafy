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

Each migration file runs in its own transaction and holds every lock it takes until it commits;
a foreign key, for example, holds a `SHARE ROW EXCLUSIVE` lock on the table it references, and
an `UPDATE` holds the row locks of the rows it changed. A migration therefore must not contain
a top-level `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK` or `ABORT`. It must also
be plain SQL: `supabase db push` sends its statements to the server without psql, so a psql
meta-command such as `\gset`, `\echo` or `\o` cannot run in production. And it must not mention
`standard_conforming_strings`, which changes how a backslash in a string is read.
`node scripts/check-supabase-migrations.mjs` rejects all three.

Live requests write `agent_jobs`, `org_credit_ledger`, `org_credit_balances`, `runs`,
`prompts`, `conversations` and `conversation_messages` in one transaction, each of them in
both orders with another of them. Dispatch inserts the prompt, the run and the user's message,
which updates its conversation, then burns credits and inserts the `agent_jobs` row.
Completion and cancel update `agent_jobs` and then the run, and completion then writes the
ledger, the agent's message and its conversation. Deferred billing writes the ledger and then
the prompt, the run, `agent_jobs` and the message. Every insert into the ledger locks the
ledger and then runs a trigger that writes and locks the org's balance row, while a credit
burn locks that balance row for its daily refill before it writes the ledger. Around those
writes the same requests read and lock other tables, also in both orders: a refill locks the
balance row and then inserts into the ledger, whose foreign-key check row-locks the
organization; credit status reads `org_subscriptions` after that balance lock; completion
updates `agent_jobs` and then reads `projects`. A migration that holds, on two tables, locks
that such a request waits on can deadlock it: the migration waits for the request on one
table while the request waits for the migration on the other. Postgres breaks the deadlock by
aborting one side, which can be the request.

So a migration that writes or locks one of those seven tables, with any lock other than
`ACCESS SHARE` (a plain read) or `SHARE UPDATE EXCLUSIVE`, must not also:

- write or lock another of the seven that way, even with only an index (`SHARE`) or a foreign
  key (`SHARE ROW EXCLUSIVE`). Live requests take any two of them in both orders, so no order
  of the migration's two locks is safe;
- hold `ACCESS EXCLUSIVE`, which most `ALTER TABLE` forms and `CREATE POLICY` take and which
  blocks even a read, or `EXCLUSIVE`, which blocks a row lock, on any other table that existed
  before it;
- change or lock rows of any other table that existed before it (`INSERT`, `UPDATE`,
  `DELETE`, `SELECT ... FOR UPDATE`), whose row locks block a request that locks the same rows.

Split such a change into migrations that commit separately, as
`20260929100000_managed_ai_metering_ledger.sql` and
`20260929100100_managed_ai_metering_tables.sql` do. A table the migration creates does not
count, because no live request can lock it before the migration commits, and a lock on an
index counts as a lock on its table. `SHARE` (an index) and `SHARE ROW EXCLUSIVE` (a foreign
key) on any other table are allowed, as the foreign keys of `20260929100100` take on
`organizations` and `projects`: they block a write to that table, but no read or row lock, and
no live request writes such a table in both orders with the seven. When live requests come to
write another table in both orders with them, add it to the list in
`scripts/test-supabase-migrations-empty-db.mjs`. `20260816213316`, `20260816213318` and
`20260906120000` break these rules only because `runs`, `prompts`, `conversations` and
`conversation_messages` joined the list after them. History is append-only, so the test checks
those three against `agent_jobs`, `org_credit_ledger` and `org_credit_balances` alone.

Two things remain for review by hand. The first is a lock taken only for a row that exists,
which an empty database cannot show: a foreign-key check, a row trigger, or a statement that a
function body or `DO` block runs only when rows exist, and the row locks of any data such a
statement or trigger changes. Every insert into `org_credit_ledger`, for example, also writes
`org_credit_balances` through its trigger. The second is lock order on other tables. `SHARE`
and `SHARE ROW EXCLUSIVE` still block a live write to that table, so a request that writes it
in the same transaction as one of the seven deadlocks a migration that takes the two locks in
the opposite order. An organization delete writes every table that cascades from
`organizations`, parents before children, so a migration that adds a foreign key referencing a
child such as `agent_jobs` before one referencing its parent `organizations` can deadlock it.
Take such locks in the order live requests take them. Postgres adds a new table's foreign keys
in the order they are declared, column references and table constraints alike, so declare the
parent references first: `20260929100100` declares its `agent_jobs` reference as a table
constraint after its `organizations` and `projects` columns for this reason.

The empty-database test (`pnpm test:migrations:empty-db`) enforces the rules above for every
migration after `20260000000063`. It lists the public relations that exist before the
migration, and after it, before it commits, the locks the migration holds on them. Postgres
takes the table locks of `SELECT ... FOR UPDATE`, `INSERT`, `UPDATE` and `DELETE` even when a
statement matches no rows, so the empty database still shows them. The test passes the
migration to psql as one `--command`, which psql sends to the server without reading it, so a
psql meta-command in it is a syntax error there as in production, and its probe queries resolve
every name in `pg_catalog`, so a table, view, function or operator the migration creates cannot
stand in for a catalog one. A row the migration prints cannot replace a relation the probe
listed before it. The test reads the locks in the migration's own transaction: it prints the
transaction id before the migration and again with the locks, and fails when the two differ or
psql warns that a transaction is already or no longer in progress. Because the id query runs
before the migration, a migration whose first statement is `SET TRANSACTION ISOLATION LEVEL`
fails the test with "must be called before any query", although `supabase db push` would apply
it; no migration does that. The test also cannot send a migration larger than 128 KiB, the most
Linux passes in one argument; split such a migration.

`supabase/supabase/migrations/` is an ignored generated working directory for the Supabase
CLI. Do not author or commit migrations there.
