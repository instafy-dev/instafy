---
---

A skill pack command can no longer take the name of one of the runtime's own helpers. Besides the reserved names, `applypatch`, `rathole`, `runtime-entrypoint`, `browser-egress-proxy`, `browser-webrtc-sender` and every name starting with `codex-` or `instafy-` are refused by the installer and the runtime. Some of these reach the runtime image's `/usr/local/bin` after the pack commands, and Codex's `applypatch` alias exists only once the runtime starts, so neither the image build's check nor the runtime's PATH check could see them. A test now checks that every command the runtime images put in `/usr/local/bin` is a name no pack may declare. No package changes.
