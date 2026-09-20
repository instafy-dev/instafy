---
"@instafy/cli": patch
---

Rebuild the published bundle with tsup 8. The emitted JavaScript is formatted
differently because tsup's esbuild moves from 0.19 to 0.27, and `node:` prefixes
are now kept in the output, which the config states explicitly rather than
inheriting. No CLI behaviour changes; the test suite and the packed file list
are unchanged.
