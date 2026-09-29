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
meta-command such as `\gset`, `\echo` or `\o` cannot run in production. It must not mention
`standard_conforming_strings`, which changes how a backslash in a string is read. And it must
be valid UTF-8, which the server requires. `node scripts/check-supabase-migrations.mjs` rejects
all four.

Live requests write `agent_jobs`, `org_credit_ledger`, `org_credit_balances`, `runs`,
`prompts`, `conversations`, `conversation_messages`, `runtimes`, `notification_events`,
`notification_recipients`, `notification_delivery_jobs`, `agent_job_inputs`, `activity_events`,
`runtime_events`, `conversation_participants`, `runtime_leases`, `automations`, `bug_reports`,
`bug_report_messages`, `origin_instances`, `notification_delivery_attempts` and `user_agents`
in one transaction, each of them in both orders with another of them. Dispatch records a new
conversation's `activity_events` row, inserts the prompt, the run and the user's message, which
updates its conversation and whose insert trigger writes the three notification tables, ensures
the runtime in `runtimes` with a `runtime_events` row for a new one, then burns credits and
inserts the `agent_jobs` row. Lease and heartbeat update `runtimes` and then `agent_jobs`.
Completion and cancel update `agent_jobs` and then the run, and completion then records
`activity_events` and `runtime_events` rows and writes the ledger, the agent's message, whose
trigger writes the notification tables, and its conversation. A runtime stop requeues
`agent_jobs` and then updates `runtimes` and records a `runtime_events` row. Deferred billing
writes the ledger and then the prompt, the run, `agent_jobs` and the message. A steer inserts
the user's message and then its `agent_job_inputs` row, while an input acknowledgement updates
`agent_job_inputs` and then the message. Dispatch adds the sender to
`conversation_participants` before it inserts the `agent_jobs` row, while a steer locks
`agent_jobs` and then adds the sender. A provider-managed runtime stop marks its
`runtime_leases` row cleanup pending before it requeues `agent_jobs`, then in its final
transaction updates `agent_jobs` before it releases the lease. Creating or editing an
automation writes its conversation and then `automations`, while a launch failure updates
`automations` and then posts a notice to that conversation. A support acknowledgement updates
`bug_reports` and then `notification_recipients`, while marking a support notification read
updates them in the other order; a support or customer reply inserts into `bug_report_messages`
and then updates `bug_reports`, while a status change updates `bug_reports` and then posts a
system message. A user's first dispatch creates their agent in `user_agents` after a new
conversation and its participant, or, in an existing conversation, before the message updates
the conversation and adds the participant. Ensuring a new runtime records its `runtime_events`
row before it inserts `origin_instances`, while a stop releases `origin_instances` before its
event. Delivering a notification updates `notification_delivery_jobs` and then its
`notification_delivery_attempts` row, while leasing a job whose lease expired updates the
attempt first. Every insert into the ledger locks the ledger and then runs a trigger that
writes and locks the org's balance row, while a credit burn locks that balance row for its
daily refill before it writes the ledger. Around those writes the same requests read and lock
other tables, also in both orders: a refill locks the balance row and then inserts into the
ledger, whose foreign-key check row-locks the organization; credit status reads
`org_subscriptions` after that balance lock; completion updates `agent_jobs` and then reads
`projects`. A migration that holds, on two tables, locks that such a request waits on can
deadlock it: the migration waits for the request on one table while the request waits for the
migration on the other. Postgres breaks the deadlock by aborting one side, which can be the
request.

So a migration that writes or locks one of those tables, with any lock other than
`ACCESS SHARE` (a plain read) or `SHARE UPDATE EXCLUSIVE`, must not also:

- write or lock another of them that way, even with only an index (`SHARE`) or a foreign
  key (`SHARE ROW EXCLUSIVE`). Live requests take any two of them in both orders, in one
  request or through a chain of requests that each hold one of them while they wait for the
  next, so no order of the migration's two locks is safe;
- hold `ACCESS EXCLUSIVE`, which most `ALTER TABLE` forms and `CREATE POLICY` take and which
  blocks even a read, or `EXCLUSIVE`, which blocks a row lock, on any other table that existed
  before it;
- change or lock rows of any other table that existed before it (`INSERT`, `UPDATE`,
  `DELETE`, `SELECT ... FOR UPDATE`), whose row locks block a request that locks the same rows.

Split such a change into migrations that commit separately, as
`20260929100000_managed_ai_metering_ledger.sql` and
`20260929100100_managed_ai_metering_tables.sql` do. A table the migration creates does not
count, because no live request can lock it before the migration commits, and a lock on an index
counts as a lock on its table. `SHARE` (an index) and `SHARE ROW EXCLUSIVE` (a foreign key) on
any other table are allowed, as the foreign keys of `20260929100100` take on `organizations`
and `projects`: they block a write to that table, but no read or row lock, and the audit behind
the list, described below, found no other table that live requests write both before and after
the same listed table. `20260816213316`, `20260816213318` and `20260906120000` break these
rules only because the tables after `org_credit_balances` joined the list after them. History
is append-only, so the test checks those three against `agent_jobs`, `org_credit_ledger` and
`org_credit_balances` alone.

The list is best effort. It comes from a code audit of the transactions in
`packages/runtime-controller`, which followed every table the controller writes, and the
triggers and SQL functions that write for it, through the helpers each transaction calls. It
does not come from anything the test can observe, so it can miss a table that a request writes
in both orders with a listed one, and a new request can add such a table. When live requests
come to write another table in both orders with one of the listed ones, add it to the list in
`scripts/test-supabase-migrations-empty-db.mjs`, with the version of the migration that created
it when that version is after `20260000000063`. The backstop for a miss is the `lock_timeout`
the migration sets, `set local lock_timeout = '5s'` as in `20260929100100`, together with
Postgres deadlock detection: a lock cycle between the migration and a request ends after
`deadlock_timeout` with one of them aborted, and a migration that waits longer than its
`lock_timeout` aborts before the requests queued behind it pile up. A miss therefore costs one
aborted request or a retried release, not an outage.

Two things remain for review by hand. The first is a lock taken only for a row that exists,
which an empty database cannot show: a foreign-key check, a row trigger, or a statement that a
function body or `DO` block runs only when rows exist, and the row locks of any data such a
statement or trigger changes. Every insert into `org_credit_ledger`, for example, also writes
`org_credit_balances` through its trigger. The second is lock order on other tables. `SHARE`
and `SHARE ROW EXCLUSIVE` still block a live write to that table, so a request that writes it
in the same transaction as one of the listed tables deadlocks a migration that takes the two
locks in the opposite order. An organization delete writes every table that cascades from
`organizations`, parents before children, so a migration that adds a foreign key referencing a
child such as `agent_jobs` before one referencing its parent `organizations` can deadlock it.
Take such locks in the order live requests take them. Postgres adds a new table's foreign keys
in the order they are declared, column references and table constraints alike, so declare the
parent references first: `20260929100100` declares its `agent_jobs` reference as a table
constraint after its `organizations` and `projects` columns for this reason. One known pair has
no safe order: `ensure_project_record_for_dispatch` in
`packages/runtime-controller/src/dispatch.rs` inserts a project before `ensure_project_org`
inserts its organization, the reverse of an organization delete, so no single order of foreign
keys to `projects` and `organizations` is safe against both, and a migration that references
both can at worst abort a service-role dispatch that creates its project. Reads count too: an
`ALTER TABLE` waits for its `ACCESS EXCLUSIVE` lock behind a request that has only read that
table, so the order to match includes requests that read the altered table before they write
the other one.

The empty-database test (`pnpm test:migrations:empty-db`) enforces the rules above for every
migration after `20260000000063`. It lists the public relations that exist before the
migration, and after it, before it commits, the locks the migration holds on them. Postgres
takes the table locks of `SELECT ... FOR UPDATE`, `INSERT`, `UPDATE` and `DELETE` even when a
statement matches no rows, so the empty database still shows them. The test passes the
migration to psql as one `--command`, which psql sends to the server without reading it, so a
psql meta-command in it is a syntax error there as in production, and its probe queries resolve
every name in `pg_catalog`, so a table, view, function or operator the migration creates cannot
stand in for a catalog one. A row the migration prints cannot replace a relation the probe
listed before it, and a table of the list missing from the relations before a migration fails
the test, unless that migration or a later one creates it. The test reads the locks in the
migration's own transaction: it prints the transaction id before the migration and again with
the locks, and fails when the two differ or psql warns that a transaction is already or no
longer in progress. Because the id query runs before the migration, a migration whose first
statement is `SET TRANSACTION ISOLATION LEVEL` fails the test with "must be called before any
query", although `supabase db push` would apply it; no migration does that. The test also
cannot send a migration larger than 128 KiB, the most Linux passes in one argument; split such
a migration.

`supabase/supabase/migrations/` is an ignored generated working directory for the Supabase
CLI. Do not author or commit migrations there.
