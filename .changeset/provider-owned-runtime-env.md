---
---

The Docker runtime allocator no longer lets a runtime request's `metadata.env` replace what the provider sets itself (the runtime's ids and token, `CONTROLLER_BASE_URL`, the origin address), or set `PROXY_UPSTREAM_*`, which only the operator who runs the provider may set. Before, a request could point a runtime's model proxy, and the credential it carries, at another host, or point the runtime at another controller. Other settings a self-hosted runtime request may choose still apply. No package changes.
