---
---

A preview whose site answers no longer stays on "Checking…": once the controller's own probe reaches the site through the tunnel (on `ready` or any read of the preview), an issuing preview is recorded as active and `tunnel.status_updated` says so. A preview that is closed or expired is never brought back this way. No package changes.
