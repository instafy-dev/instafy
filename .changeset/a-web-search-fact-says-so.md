---
"@instafy/cli": patch
---

A starter page's fact that only a web search gave, marked `"viewer": "provider search"`, now reads "from a web search, 17 Nov · example.com ↗" (`site.trust`, `site.cite`, `site.seen`), with the day and the page the search named, and never "checked" or "seen": those stay for a page that was read. A price at a store reads "at Store ↗ · from a web search, 17 Nov", and one the search didn't find reads "Not found · from a web search, 17 Nov · example.com ↗". The compare and ranked starters cite values from one page on one day once under the list only when all of them were read there, or all came from a web search, so the line's "checked" never covers a value a search gave (`site.js` 1.11.0). Pages made before keep their own copies of `app.js` and `site.js`.
