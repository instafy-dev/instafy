# Notification database simulation

Run from the repository root:

```sh
python3 scripts/test-durable-notifications.py
```

The runner requires local PostgreSQL binaries (`initdb`, `pg_ctl`, and `psql`). Set
`PG_BIN` to their directory when they are outside `PATH`. It creates an isolated
cluster in a temporary directory, listens only on its private Unix socket, applies
the entire public migration history, and removes the cluster when it finishes.
It never reads `DATABASE_URL`, configuration files, or deployment credentials.
The minimal local `auth.users` fixture supplies the Supabase identity columns used
by the public migrations and controller tests; it does not simulate Supabase Auth.

The SQL fixtures cover source/outbox transaction rollback, the customer support
reply/read/resolve/reopen lifecycle, exact resolution transitions, all initial
event producers, quiet automation completions, payload privacy, category/channel
preferences, monotonic read/archive state, browser privilege isolation, project
and private-conversation revocation, endpoint account reassignment, and retained
APNs delivery audit after endpoint deletion. Conversation coverage includes
canonical human mentions, duplicate mention/participant recipients, sender
exclusion, malformed and oversized mention metadata, private and wrong-project
mention denial, muted delivery with durable inbox retention, and team automation
replies to existing participants without duplicating the owner's terminal alert.
The Python harness also runs
concurrent producers, concurrent support resolutions, concurrent `SKIP LOCKED`
claims, lease recovery, stale-token fencing, bounded retry exhaustion, and replay
of the notification migration without changing existing state.

The same run also executes `org_credit_ledger_idempotency.sql`. It posts repeated
burn and credit keys, with and without `on conflict do nothing`, and checks that a
repeated key adds no ledger row and never moves the org balance. It also checks that
other keys, projects and orgs stay distinct (including one project's key reused under
another org) and that, like the partial unique index, a row without a project or
with a NULL or empty key is never deduplicated. The concurrent case runs in the
controller tests `credits::tests::concurrent_`, which need a fully migrated
`TEST_DATABASE_URL`.

`managed_ai_metering.sql` covers the managed-AI metering tables and the credit ledger's
balance guard: overdraft rows, credits into a negative balance, ordinary debits still refused
below zero, duplicate idempotency keys skipped without moving the balance, NULL-project keys,
admission uniqueness, cascades, an index behind every foreign key of the metering tables, and
browser-role privileges. The harness then posts one ledger key from 16 concurrent sessions and
requires a single debit. The controller suite runs the same file inside a rolled-back
transaction (`tests_ai_metering_schema`).

The run also executes `reserved_managed_credential_id.sql`. It checks that
`user_credentials_id_not_reserved` exists and, as migrated, is not validated: it ships
`NOT VALID`, and validating it is left to a later migration. As the signed-in role,
through the `user_credentials` row-level security policy, it checks that the owner
still inserts and updates ordinary credential rows and that the managed credential id
is refused by the check on insert, upsert and renumbering; the table owner is refused
too. For reference when the check is validated, it also shows, for a row stored under
that id before the check existed, that revoking it or clearing its default flag is
refused and VALIDATE fails, and that deleting the row (which clears agent references
to it) lets the check validate. The fixture runs in one transaction and rolls back.

It also executes `agent_credential_owner.sql`. As the signed-in role and as the table
owner, it checks that `user_agents_credential_owner` refuses an agent pinned to a
credential its owner does not hold, on insert, on update and when the agent moves to
another user, while owners still pin, switch and clear their own credentials and
deleting a credential still clears pins to it. It also rolls back.

The cluster has no Supabase Storage, so the replay also proves that
`20261003120000_chat_attachments.sql` succeeds without it and only reports a notice. The
run then installs `storage_stub.sql`, the buckets and objects columns the Storage policies
read, and reruns that migration twice, as an install that adds Storage later does.
`chat_attachments.sql` then checks the private `chat-attachments` bucket, inside a transaction
the run rolls back. It acts as the signed-in and anonymous roles, through the `storage.objects`
row-level security policies, and checks these rules:

- Every member of a live space reads its `<projectId>/<uuid>.<ext>` objects.
- Only its owner, and owners, admins and builders of the space or its team, upload.
- Non-members, a deleted space and anon are refused.
- A free-form name, another extension, a malformed id and another spelling of the space id are
  refused.
- Nobody updates or upserts an object.
- An uploader deletes only their own objects, and only while they can still write.

The controller test `chat_attachment_sql_fixture_passes_on_storage` runs the same file against
Storage's own schema on the local stack, so CI checks the policies against the real table.

To also run the real controller HTTP and mocked transport tests against a clean,
fully migrated database in that same disposable cluster:

```sh
python3 scripts/test-durable-notifications.py \
  --controller-test notification
```

This optional mode opens a temporary loopback-only TCP listener for the Rust
PostgreSQL driver and builds/runs the selected tests with `cargo test`. The test
database is cloned before the SQL fixtures run, so the worker cannot consume
simulation jobs from another test. Repeat `--controller-test` to select another
test filter. Missing dependencies or failed migrations/tests produce a failure,
not a skipped success.

These are automated database and transport simulations. They do not verify
physical devices, browser push permissions, or deployed VAPID/APNs credentials.
