---
"@instafy/cli": patch
---

Automations can now share their result threads with the team. `instafy automations create` and `instafy automations update <automation-id>` gain `--share-results`, `--no-share-results`, and `--result-visibility <private|team>`, so the setting can be chosen at creation or flipped on an existing automation. The result visibility (`private` by default, `team` when shared) is shown in `automations list` and `--json` output. "Team" means visible to anyone with access to the space; results stay private unless you opt in.
