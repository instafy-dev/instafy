---
"@instafy/cli": patch
---

`instafy bind check` now fails a page that loads a file from outside its folder (`../another-page/site.js`, in an element, a style or a script): a page is served from its own folder, so there it couldn't load it, and it would change whenever that other folder does. The check names the `instafy bind init <dir> --starter <name>` that gives the page its own files (the starter whose script it borrowed, else `blank`). In a space, while no preview shows the folder, a check that passes now serves the page and posts its card itself, titled from the page (`data.json`'s title, else the page's own), and prints what `instafy preview open` answered; any other check still ends with the card's command, except for a page that loads files from outside its folder. On a phone, the compare starter names every missing value once, under "Still missing", with its note, in place of "Not found yet" and "Not checked". Pages made before keep their own copies of `app.js`.
