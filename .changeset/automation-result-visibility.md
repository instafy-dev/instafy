---
"@instafy/cli": patch
---

Automations can now share their result threads with the team. `instafy automations create` gains `--share-results`, `--no-share-results`, and `--result-visibility <private|team>`, and a new `instafy automations update <automation-id>` command flips the same setting on an existing automation. The result visibility (`private` by default, `team` when shared) is shown in `automations list` and `--json` output. "Team" means visible to anyone with access to the space; results stay private unless you opt in.
