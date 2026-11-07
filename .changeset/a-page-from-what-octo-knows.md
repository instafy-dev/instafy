---
"@instafy/cli": patch
---

A comparison page asked for from what Octo already knows, with nothing looked up, now says so instead of claiming checks that never happened: with `"from": "memory"` in its `data.json`, the compare starter shows each value as "<value>, not checked", with no source, date or link, and adds "From what Octo knows; nothing checked." to the page's opening line. `instafy bind check` passes such a page's rows without pages, and fails any address or date on it. Pages made before keep their own copy of `app.js`.
