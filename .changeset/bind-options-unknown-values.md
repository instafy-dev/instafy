---
"@instafy/cli": patch
---

`instafy bind` starters (compare, ranked): a stated limit ("€600 or less") counts only a value the page shows, so a row whose price is unknown is listed apart under "Price unknown", never as within the limit (`site.within`, `site.byFilter`), and the page says "None is known to be €600 or less." when no row is. Each value cites the page it was read on and the day ("checked 27 Oct on maker.com ↗"; a price "seen 27 Oct on shop.com ↗"); a line under the list cites one page only when that page gives every value it covers. A missing value in a table of options reads "Unknown" with why, and a dash, "n/a", "?" or "unknown" is never drawn as a value. `instafy bind check` also fails a page of options for a value that only says nothing, a value without its page and day, and a filter applied without `site.byFilter`, and notes the rows the filter lists apart.
