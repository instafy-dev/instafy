---
"@instafy/cli": patch
---

`instafy credentials list` shows the model a credential's jobs run, which the controller now sends as `defaultModel` (a stored OpenAI id that the own-AI floor raises runs the own-AI default), instead of the id stored when the credential was saved. With an older controller it still shows the stored id.
