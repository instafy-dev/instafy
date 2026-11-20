---
"@instafy/cli": patch
---

Add `instafy runtime machines`, which lists your own machines in every space (Desktop, its Personal Browser and `instafy runtime start` runtimes, and tokens minted for machines that have not connected yet), and `instafy runtime revoke <id-or-prefix…>`, which ends the runtime, agent and job tokens of the machines you name and stops the ones still running. A computer you use in several spaces is listed once for each space, and revoking one of its rows ends its access to that space only; `--all` revokes all of them. A revoked machine stays listed as revoked until it is started again. Both need your own sign-in. `revoke` asks first unless you pass `--yes`, which `--json`, a script or CI needs. Revoking does not sign you out on a machine: one that still has your sign-in can mint a new token.
