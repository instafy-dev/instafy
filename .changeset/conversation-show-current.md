---
"@instafy/cli": patch
---

`instafy conversation show` without a target now shows the current conversation from `INSTAFY_CONVERSATION_ID` (or `CONVERSATION_ID`), which runtime jobs set, instead of failing with a missing argument. With neither set it explains how to name one. A value in either variable that is not a conversation UUID is now rejected with a clear error before any request, by `conversation show` and by `history messages` and `history runs` without `--conversation`, instead of being sent to the controller as part of the request path.
