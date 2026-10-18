---
"@instafy/cli": patch
---

`instafy tunnel start` now connects when it runs inside a container against a local tunnel broker: a loopback ingress address is dialed through `host.docker.internal` instead of the container itself. Set `INSTAFY_TUNNEL_SERVER_HOST` to override the ingress host anywhere.
