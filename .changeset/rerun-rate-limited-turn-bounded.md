---
---

A turn that stops on a short provider rate limit before it did anything now goes back to the queue up to three times, not once. When four teams started at once on an upstream that takes two requests per 30 seconds, a lead's single re-run could land in a window the other teams had used up and fail the whole request. The rules are unchanged otherwise: the same short-wait, did-not-act and turn-kind checks, each wait at most 60 seconds, and the job records how many times it went back (`rateLimitRetry.attempts`). No package changes.
