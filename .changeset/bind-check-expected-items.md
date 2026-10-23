---
"@instafy/cli": patch
---

Add `instafy bind check <site> --expect "<item>,<item>"`. It says whether a site shows every item the request named (each product, stop or entry): it reads the text of the site's HTML pages and every value in its data files (`data.json`, `data/**/*.json`), lists the items it does not show, and exits 1 when one is missing (2 when there is nothing to check). The list can also live in `data.json` as `"expect": [...]`, so every later check uses it. The bound-sites skill now runs it before the reply, so a page that quietly leaves out an item someone asked for is caught. What a page script renders from elsewhere is not seen by the check.
