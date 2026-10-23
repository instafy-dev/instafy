---
---

New development tool `scripts/fake-rate-limit-upstream.mjs`: a fake rate-limited AI upstream that sits between the model proxy and the real provider, forwards every request, and answers some with HTTP 429 and a `Retry-After` (at most N requests per window, a fraction, time windows, or only requests that start a conversation), so rate-limit handling and the pacing of team agents can be tried locally. The local Compose proxy takes `PROXY_UPSTREAM_CHATGPT_ENDPOINT` and `PROXY_UPSTREAM_OPENAI_ENDPOINT` to send its requests there; empty, as before, is the provider itself. Nothing in the product starts it. No package changes.
