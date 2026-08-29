---
"@instafy/cli": patch
---

Jobs and agents that do not pin an OpenAI model now default to `gpt-5.6-sol` on the hosted runtime (previously `gpt-5.5`). The new default takes effect on the next hosted deploy; explicitly selected models, including `gpt-5.5`, are unaffected.
