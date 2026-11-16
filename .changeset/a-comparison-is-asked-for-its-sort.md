---
"@instafy/cli": patch
---

`instafy bind check` now fails a comparison of two or more options that has no `sort` entry by a column that reads as a number, while a column reads as a number in every row. It names the columns that read as a number and asks for a `sort` entry, with its `dir`, for each amount the person compares by among them (a price, a weight, a size), never for a number in a name (a chip, a model, a version). The compare starter writes the line under the title from its sort entries ("Lowest price: Option B"), so a page built with every column as text and no `sort` said nothing there. The numbers are read as the page reads them, by the first number in each value ("From €619" is 619, "1.3kg" is 1.3). An entry by a column that reads as a number settles the check even while it says nothing yet, such as when a row lacks the value, so no entry is needed for a chip's name, and with fewer than 5 options an entry moves no row.
