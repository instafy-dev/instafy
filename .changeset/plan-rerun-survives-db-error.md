---
---

A team lane's re-run (after a short rate limit, or its next turn after running out of time) is no longer lost to a single failed database statement. Ensuring the runtime during a dispatch now runs in a savepoint, so when that step fails (for example, a deadlock with a concurrent dispatch) the dispatch goes on, as it was always meant to, instead of failing on a transaction that was already aborted. A re-run whose dispatch still fails on the server's side is tried once more after a short pause, unless the first attempt was queued after all. Runtime-record errors are now logged with their Postgres code and message instead of only "db error". No package changes.
