---
---

CI now runs the tunnel broker's own tests. A new "Rust test tunnel broker" lane runs `cargo test --locked` over the whole `packages/tunnel-broker` workspace and is part of the required `Rust tests` check, so a broker change that breaks its ACL, preview-auth or port-reuse tests can no longer merge. It is routed, qualified and cached like the other Rust test lanes (its own cache key, saved only from hosted `main`). No package changes.
