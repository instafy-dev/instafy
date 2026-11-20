---
"@instafy/cli": patch
---

`instafy bind check` fails a page that says "checked <date>" or "seen <date>" in typed words, linked or not, and names each such line (`TYPED:`, and `typed` in `--json`). `site.trust` and `site.cite` write those words themselves, from how a fact's page was read (its `viewer`). A page captioned a journey planner whose form was never sent "<planner> · checked 20 Nov 2026; no connection result", typed as a link's words, and the check passed it because the line linked a page. The check reads the words in a page's HTML, its own scripts and `data.json`, never in a file a command writes (a check's records, a map's layers), and never words put together while the page runs.
