---
"@instafy/cli": patch
---

`instafy bind init` and `instafy bind check` end with the step that shows the page. In a space, init's next step names the one command that serves the page and posts its card in Studio, `(cd <dir> && instafy preview open --title '<short title>' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json)`, after putting the content in `data.json` and checking it with `instafy bind check` (for the blank starter, after writing `app.js`). A check that passes ends with the same command (`next` with `--json`) until the CLI has recorded a preview opened from the site's folder. Before, init's next step was `instafy-bind serve <dir>`, which posts no card and is not a command in a space, and a passing check named no next step, so a finished page could end with nothing to open. Outside a space the binder still says to serve the site itself.
