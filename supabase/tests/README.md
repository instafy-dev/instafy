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
APNs delivery audit after endpoint deletion. The Python harness also runs
concurrent producers, concurrent support resolutions, concurrent `SKIP LOCKED`
claims, lease recovery, stale-token fencing, bounded retry exhaustion, and replay
of the notification migration without changing existing state.

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
