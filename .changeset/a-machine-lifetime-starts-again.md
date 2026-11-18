---
"@instafy/cli": patch
---

`instafy runtime start` starts a private runtime again when its machine lifetime ends. The controller now renews a self-hosted machine's token only for a limited time from its mint (a week by default). When the agent exits for that reason (exit status 4), a foreground `runtime start`, as a process or in Docker, mints a new token for the same runtime from your sign-in and starts the agent again. It does this at most once in ten minutes. If the runtime token was given with `--runtime-token` or `RUNTIME_ACCESS_TOKEN`, it says to mint a new one and exits with status 4 instead. A detached runtime (`--detach`) stops when its lifetime ends. Before minting from a saved login that ends within 15 minutes, `runtime start` refreshes it first, because a runtime token now ends no later than the sign-in that minted it.
