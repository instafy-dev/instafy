---
"@instafy/cli": patch
---

Remove `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`, the controller's decrypt-only credential keys during a key rotation, from the environment of runtime child processes, as `CREDENTIAL_ENCRYPTION_KEY` already is.
