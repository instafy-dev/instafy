---
"@instafy/cli": patch
---

`instafy preview list` now says what it shows: each row's status is the preview's (`preview active`), not whether the site answers, and rows carry `restartable` (also in `--json`) when the server sends it. The text output says that `instafy preview check` checks a site, and that a preview whose machine stopped or restarted is not listed: its card reads Stopped, and Open on a restartable card starts the site again. The bundled `instafy-frontend-previews` skill says the same, says that rerunning `instafy preview open` in a later turn posts that turn's card rather than refreshing an earlier one, and asks Octo to report what each command returned; an unedited earlier bundled copy is upgraded.
