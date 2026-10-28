---
---

The controller now tells browsers to cache its CORS preflight answers for ten minutes (`Access-Control-Max-Age: 600`). Studio calls the controller cross-origin with an `Authorization` header, so each such call used to cost an OPTIONS request first: a poll every 400 ms was two requests every 400 ms. A runtime's origin server, which Studio calls directly when the controller does not proxy it, caches its preflights the same way. The policy is otherwise unchanged. No package changes.
