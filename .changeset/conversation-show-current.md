---
"@instafy/cli": patch
---

`instafy conversation show` without a target now shows the current conversation from `INSTAFY_CONVERSATION_ID` (or `CONVERSATION_ID`), which runtime jobs set, instead of failing with a missing argument. With neither set it explains how to name one. A value in either variable that is not a conversation UUID is now rejected with a clear error before any request, by `conversation show`, by `history messages` and `history runs` without `--conversation`, and by `agents context put` without `--scope-id`, instead of being sent to the controller as part of the request path or as a context card's scope.
