---
"@instafy/cli": patch
---

Add `instafy credentials list | test | default | revoke` so you can see which AI provider credentials your account holds, verify one against its upstream provider through the proxy, pick or clear the default that jobs use, and revoke a credential. Commands accept a full id or a unique id prefix, support `--json`, and never print secret material.
