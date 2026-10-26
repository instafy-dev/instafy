---
---

The pinned `interactive-map` skill pack is now `instafy-dev/maps-skill-pack` v0.1.2. An empty place search moves on to the next lookup instead of reporting "not found"; answers from a fallback or with missing data are marked partial and the map says "data may be incomplete", so a verdict like the longest walk to a station is never shown as complete; every command finishes well inside the turn limit; an HTTP 429 stops that service for the turn; and lookup state lives in the runtime's per-space cache folder. No package changes.
