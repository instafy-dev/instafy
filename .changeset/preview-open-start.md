---
"@instafy/cli": minor
---

`instafy preview open` gains `--start`. With `--serve-cmd "<command>"`, when nothing answers on the port it starts the site in the background, in its own session so it keeps running after the command (or Octo turn) that started it ends, without Instafy credentials in its environment (the same rule as `instafy bind serve --detach`), with its output appended to `.instafy/agent/logs/preview-<port>.log`, and waits up to 60 seconds for the port before it posts the card. When the port already answers, nothing is started. It exits 2 with the log's path when the command exits first or the port does not answer in time. `--json` adds `startedPid` (null when nothing was started) and `logFile`. The help and output now say that Open starts a restartable site again when the process that started it exits, or the space sleeps.
