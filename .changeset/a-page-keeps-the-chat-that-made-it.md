---
"@instafy/cli": patch
---

`instafy preview open` now records which chat made each page: the chat its card goes to (a job's own chat, or `--conversation`). Opening the same folder again from another chat keeps the chat that made it, and a page opened before this change keeps none. The starters' `site.link` takes the web address from either argument, so a link written name first is still a link, and a note longer than 100 characters ends at a whole word with "…". On a phone, the compare starter names the values of an item whose own page wasn't opened under "Not checked", apart from what was looked for and not found. Pages made before keep their own copies of `site.js` and `app.js`.
