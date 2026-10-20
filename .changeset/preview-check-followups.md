---
"@instafy/cli": patch
---

`instafy preview check` and `instafy preview open` no longer tell you to start a site that is already running but slow to answer. When a server takes the connection but sends nothing in time (often a dev server compiling its first request), they say so and say not to start a second server; both still exit 2. `preview check` now waits as long as `--timeout` for that first answer instead of a fixed 5 seconds. When `preview check` cannot read its own screenshot, it says the blank check is incomplete instead of passing silently; on a page with no text that is a problem (exit 1). Without `--out`, screenshots go to a new folder for each run that only you can read, instead of a fixed shared path.
