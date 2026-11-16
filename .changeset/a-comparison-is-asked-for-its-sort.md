---
"@instafy/cli": patch
---

`instafy bind check` now fails a comparison of two or more options whose `sort` decides nothing while a column reads as a number in every row. It names those columns and asks for a `sort` entry, with its `dir`, for each of the person's criteria among them. The compare starter writes the line under the title from its sort entries ("Lowest price: Option B"), so a page built with every column as text and no `sort` said nothing there. The numbers are read as the page reads them, by the first number in each value ("From €619" is 619, "1.3kg" is 1.3), and with fewer than 5 options an entry moves no row.
