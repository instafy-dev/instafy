---
"@instafy/cli": patch
---

`instafy runtime token --scope` now names the scopes a token gets without it (`agent.*`, `origin.*`, `git.*`, `telemetry.write` and `workspace.lease.read`) and says that renewal keeps a narrower list: the controller renews a runtime token with the scopes it holds, so a machine started on a narrowed token gains another scope only from a new mint. A token that keeps every `agent.*` and `origin.*` scope, `git.read` and `git.write` still mints Git tokens and reads workspace leases, as one minted before `git.token.mint` and `workspace.lease.read` existed does.
