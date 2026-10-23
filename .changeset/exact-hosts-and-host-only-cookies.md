---
"@instafy/cli": patch
---

The git credential helper that `instafy login` installs now answers only exact hosts: the hosted git service, the configured controller's host, the host of `ORIGIN_GIT_REMOTE_URL`, loopback and the local stack's `git-edge`/`git-shard-*` names. It no longer answers every host under a domain. Name any other git host in `INSTAFY_GIT_HOSTS` (comma-separated).

`instafy bind serve` hardens its viewer cookie against other hosts under the same parent domain. On HTTPS (an `https://` `--public-url`, or `x-forwarded-proto: https` with `--trust-proxy`) the cookie is `Secure`, and a site served at the root gets the `__Host-` prefix, so no other host can set or shadow it. The binder now checks every cookie of that name a request carries, so a same-name cookie set for the parent domain no longer locks a viewer out.
