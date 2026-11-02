---
"@instafy/cli": patch
---

`instafy web read --find` cuts a page to the passages that mention the terms only when the page is longer than the reader's 12,000-character ceiling. A shorter page comes back whole, past `--max-chars`, so a line that names no term, such as a place's opening hours under its name, is no longer cut away from the line that says whose hours they are. Its passages come first, in `find.text` (in the text output, under the `--find` line), ahead of the page, its links and its structured data, so a reader that keeps only the start and the end of the output still sees them; `find.whole: true` says the page's `text` is all of it, and is never set for a page whose HTML was too large to read whole. Each passage now keeps the two lines above its match, where the name or heading it belongs to usually is, and the one below.
