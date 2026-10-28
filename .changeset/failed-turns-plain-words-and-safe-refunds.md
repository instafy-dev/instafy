---
---

Every failed-turn sentence is now in plain words, not only the ones for a proxy failure. The reply that didn't come through, no AI connected, a rate limit, a spent usage limit (on Instafy AI, on the person's own AI, or unknown) and an answer the AI stopped early no longer say "provider", "credential" or "switch"; the raw text behind Details is unchanged. The controller refunds a managed-AI prompt the proxy or the provider refused as sent (any client error other than a 408 or a 429, reason `request_rejected`), since the proxy answers with a status only before it streams anything. It keeps the charge when a call in the usage receipt recorded usage, even one that failed later: a call records usage only once a model response in it completed. No package changes.
