---
---

The pinned `interactive-map` skill pack is now `instafy-dev/maps-skill-pack` v0.1.3. Its manifest declares `"bin": {"uw": "scripts/uw.mjs"}`, so with pack commands on PATH Octo runs `uw <command>` instead of defining a `uw()` shell function before every command, and the skill names a fallback for a shell that does not find `uw`. The manifest also carries a short, fixed label per `uw` subcommand for the chat's activity line ("Looking up places", "looked up 14 places", "built the map"), and the map engine sets `<meta name="description">` from numbers and fixed words only ("Trip · 3 days · 14 places"). No package changes.
