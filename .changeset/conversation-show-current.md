---
"@instafy/cli": patch
---

`instafy conversation show` without a target now shows the current conversation from `INSTAFY_CONVERSATION_ID` (or `CONVERSATION_ID`), which runtime jobs set, instead of failing with a missing argument. With neither set it explains how to name one.
