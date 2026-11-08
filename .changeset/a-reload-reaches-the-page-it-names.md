---
"@instafy/cli": patch
---

`instafy bind command <dir> …` now reaches only the binder that serves `<dir>`: the folder of one of its sites, or the binder's own folder when it serves one site. Before, a folder below a binder of one site that was none of its sites (a page something else serves) sent the command to that binder's page instead. `instafy bind try --save` no longer says an open page needs a reload command: in a space, every open page shows the saved records once the change is saved.
