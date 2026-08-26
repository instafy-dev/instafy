---
"@instafy/cli": patch
---

Add `instafy automations update <automation-id>` to change an automation's name, prompt (`--prompt` or `--prompt-file`), schedule, timezone, runtime mode and provider, and quiet-run setting in place. The automation keeps its id, private conversation, and run history, and its next run only moves when the schedule changes.
