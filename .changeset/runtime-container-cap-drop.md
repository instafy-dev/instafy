---
"@instafy/cli": patch
---

`instafy runtime start` now starts a Docker runtime container with the `SYS_PTRACE` and `NET_RAW` capabilities dropped, as the runtime compose files do.
