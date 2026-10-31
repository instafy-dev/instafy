---
"@instafy/cli": patch
---

`instafy preview open` records, with each preview it opens on the machine, the folder the site's server runs from (inside the space's workspace) and whether it was opened with `--no-thumbnail`; `instafy preview open` and `instafy preview check` record when they last pictured the site for the preview's card, also when no picture came of it. A preview opened with `--no-thumbnail` gets no picture from a later `check` either. `instafy preview check --desktop` loads only the desktop size, which the card's picture comes from. While a turn that changed a file in the site's folder after it was last pictured saves its changes, the runtime checks the site again with `instafy preview check --desktop`, so the card shows the site as the turn left it, also when the turn stopped before its own check: a map opened early no longer keeps its blank starter on its card. A preview restarted after the space slept keeps what was recorded.
