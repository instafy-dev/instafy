---
"@instafy/cli": patch
---

`instafy preview open` now records how the site was started, so a member's Open on the card can start it again after the space sleeps, without an Octo turn. On a Linux space it reads the argv and working directory of the process listening on the port; `--serve-cmd "<command>"` gives the command instead, run from the current directory (one command and its arguments; shell syntax is refused). Nothing is recorded for a directory outside the workspace, a command that uses a temporary folder, or a command line that looks like it carries a secret; a `--serve-cmd` that looks like it carries one is refused. The JSON output gains `restartable` and, when it is `false`, `restartNote` saying why.
