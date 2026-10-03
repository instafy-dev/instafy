---
"@instafy/cli": patch
---

`instafy git sync` now names every path the saved history did not take, as "Not saved: <paths> (kept at <ref>)", and exits 1 when anything was not saved. `--json` carries `gitSyncStatus`, `conflictedPaths`, `rejectedPaths`, `recoveryRef` and `unpushedRefs`. Inside a runtime, the sync goes through that runtime's own origin.
