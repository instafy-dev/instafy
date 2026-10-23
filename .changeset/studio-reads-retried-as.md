---
---

Studio's team card now shows a plan lane the controller started again (a turn that ran out of time and continued, or a run that stopped on a short provider rate limit and was retried) as that lane's newer run, not as a red failure. The stopped run no longer counts toward "need attention" or decides the lane's chip, whichever source Studio reads it from: the run feed, the chat's messages or the group status's `retriedAs`/`retriedFor`. One quiet line under the card says what happened ("@builder ran out of turn time and continued in a new turn.") with an "Open continuation" link, and the stopped run's trace ends with the same line. A lane that failed without a rerun still shows as failed. Frontend only; no package changes.
