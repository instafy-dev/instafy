---
"@instafy/cli": patch
---

`instafy web read --find` cuts a page to the passages that mention the terms only when the page is longer than the reader's 12,000-character ceiling. A shorter page comes back whole, past `--max-chars`, with the counts: `find.passages` (the places on the page that mention a term), `find.matchedLines` and `find.whole: true`. A line that names no term, such as a place's opening hours under its name, is no longer cut away from the line that says whose hours they are.
