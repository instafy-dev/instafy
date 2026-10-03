---
"@instafy/cli": patch
---

Allow recommendation submissions to include a concise message for a private Octo conversation, and expose delivery state without starting the suggested work. Submissions without a message keep the existing proposal-only behavior.

Add explicit `automations create --mode space_review` for an opted-in, private and quiet review schedule using the bundled instructions. Existing prompt automations keep their defaults.
