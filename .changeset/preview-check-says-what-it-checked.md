---
"@instafy/cli": patch
---

`instafy preview check` ends a check with no errors by saying what it checked: "Loaded on both sizes with no errors; how it looks isn't checked until someone opens the screenshots." (or the one size it loaded with `--phone` or `--desktop`), in place of "No problems found. Open the screenshots…", which an agent read as the page displaying correctly without opening them.
