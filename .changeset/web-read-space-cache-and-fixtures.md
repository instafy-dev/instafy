---
"@instafy/cli": patch
---

`instafy web read` keeps its cache, robots.txt answers, stop records and turn budget in the space's own folder (`INSTAFY_CACHE_DIR`) when a runtime provides one, so a worker whose home folder is new every turn still remembers what an earlier turn stopped at and every worker of a turn shares one budget; on a person's own computer they stay in `~/.cache` and `~/.local/state`, and the command now honours the `HOME` it is given. The link-only guard, turn budget, cache, untrusted wrapper and address check moved into one module that later web commands reuse; reading behaves as before. A test build of the CLI (built with `INSTAFY_TEST_BUILD=1`) answers from hand-written pages in `INSTAFY_WEB_FIXTURES=<folder>` instead of the network, under the same rules, with each page's `viewer` labelled `fixture`; the published CLI refuses that variable (exit 70) rather than reading the live web in its place.
