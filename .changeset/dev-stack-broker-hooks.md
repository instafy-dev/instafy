---
---

The local dev stack can recreate its tunnel broker with the controller hooks it needs. `node scripts/run-e2e-dev.mjs broker:start` recreates only this checkout's broker services from the same settings `up` uses, so `ACL_HOOK_URL`, `EVENT_HOOK_URL` and their tokens are always set. `status` and `check` now say when the running broker lacks any of them (names only, never values), and `check` fails then: a broker recreated by hand without them creates tunnels the controller never approved and never reports them. Dev scripts only; no package changes.
