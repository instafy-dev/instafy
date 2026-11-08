---
"@instafy/cli": patch
---

`instafy preview open` now writes down which chat made each page, in the space's own folder (`.instafy/pages/pages.json`), so the record outlasts the machine: the chat its card goes to (a job's own chat, or `--conversation`) and how the page is served. Opening the same folder again from another chat keeps the chat that made it, a page written down without a chat stays without one, and the workspace itself is not written down. The starters' `site.link` takes the web address from either argument, so a link written name first is still a link, and a note longer than 100 characters ends at a whole word with "…". On a phone, the compare starter names the values of an item whose own page wasn't opened under "Not checked", apart from what was looked for and not found. Pages made before keep their own copies of `site.js` and `app.js`.
