---
"@instafy/cli": patch
---

`instafy preview open` now accepts the same paths and titles as the server: a path may carry a query string (`/app?x=1`), and a non-ASCII path or a title with control characters is refused before any request. Its JSON output adds `httpStatus`, the status the server's check got from the site. A site that answers only on `[::1]` exits `2` with a message saying it is running and must bind `127.0.0.1` or `0.0.0.0`. A preview's config, which holds its token, is removed whenever the preview is forgotten locally, and two `open` runs for the same port at once start one client. `instafy preview` and `instafy tunnel stop` signal a recorded process only when its command line is the rathole binary that was started with `-c <config>`, never a process that only mentions the config file.
