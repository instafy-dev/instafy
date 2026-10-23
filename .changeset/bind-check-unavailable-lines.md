---
"@instafy/cli": patch
---

`instafy bind check` no longer counts an item as shown when the page only says it is unavailable. A line such as "Not found yet: Tokyo", "Missing: …", "Could not place …" or "Unavailable …", a data string that starts that way, and a data file's `missing` / `notFound` / `unavailable` list are skipped before matching. Before, a builder that honestly listed what it could not add passed the check for exactly those items. The eval grader already read pages this way.
