---
"@instafy/cli": patch
---

A starter page says "checked" or "seen" only for a fact that says how it was read: its `"viewer"` names the reader (`"server fetch"` for `instafy web read`, `"shared browser"` or `"personal browser"` for a browser, or a skill's own command). A dated fact with no `"viewer"` shows its page alone ("maker.com ↗"), never "checked" or "seen", and the compare and ranked starters' line under the list never cites it together with values that were read (`site.readThere`, `site.js` 1.12.0). A fact whose `"viewer"` names a search (`"provider search"`, or `"search result"` as `instafy web search` gives its answers) reads "from a web search", and no limit or sort counts it as read. `instafy bind check` notes each value in `data.json` that gives a day but not how it was read, on every starter, and the starters' sample data carries `"viewer"`. Pages made before keep their own copies of `app.js` and `site.js`.
