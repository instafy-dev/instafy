---
"@instafy/cli": patch
---

`instafy preview open` records, with each preview it opens on the machine, the folder the site's server runs from (inside the space's workspace), and `instafy preview open` and `instafy preview check` record when the picture now on the preview's card was taken. When a turn that changed a file in that folder after the picture was taken ends, the runtime checks the site again with `instafy preview check`, so the card shows the site as the turn left it, also when the turn stopped before its own check: a map opened early no longer keeps its blank starter on its card. A preview restarted after the space slept keeps both.
