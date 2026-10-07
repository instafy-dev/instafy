---
"@instafy/cli": patch
---

Add `conversation show --transcript` to read original user and assistant text with stable message IDs and timestamps, excluding bulky runtime events and metadata. Bounded pagination skips event-only pages and provides an explicit continuation cursor without changing the existing raw JSON output.
