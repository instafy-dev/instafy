---
---

The tunnel broker no longer hands out a hostname under a domain it no longer serves. When an `idempotency_key` names a tunnel whose hostname is not a single label under the current `TUNNEL_DOMAIN` (it was minted before the domain changed), the broker retires that tunnel (revoked, credential scrubbed, address records removed, key released) and mints a new tunnel with a new id under the current domain, whatever the old tunnel's status. A replaced private preview therefore gets a new capability namespace, so capabilities minted for the old tunnel never reach the new one. Revoking a tunnel now clears its address records in whichever zone holds them. While the domain is unchanged, reuse and refresh behave as before. No package changes.
