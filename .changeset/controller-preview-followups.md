---
---

The controller refuses to start when `PREVIEW_DENY_PORTS` has an entry that is not a port or `TUNNEL_DOMAIN` is not a readable domain, warns when the preview domain is not on the Public Suffix List, no longer stores a viewer session for a preview revoked during the Open, and keeps a closed preview closed on the generic tunnel status route. No package changes.
