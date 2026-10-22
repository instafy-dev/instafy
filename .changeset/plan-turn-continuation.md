---
---

A team plan's lane that runs out of turn time now carries on in a new turn instead of dying mid-command.

- Wrap-up: shortly before an ordinary turn's hard limit (120 s by default; `INSTAFY_TURN_WRAP_UP_SECONDS` changes it and 0 turns it off), the runtime sends the live turn one message, the way a person's mid-turn message arrives: stop starting long steps, save, end the turn.
- Continuation note: a lane that may get another turn also gets `INSTAFY_TURN_CONTINUE_FILE`. The note it writes there is recorded as `agent/turn-continuation`. A turn the limit stops anyway records one too, with its last commands as the note when it wrote none.
- Next turn: the controller starts the same lane again in the same group, on the runtime that holds its saved files, with its own prompt and the note. That happens at most twice per lane; the last turn is marked so and gets no continue file. A stopped group starts none. The group stays open meanwhile, and the lead's checkpoint reads each continued run as superseded by the run that replaced it.
- Rate limit: a continuation turn that stops on a short provider rate limit before it acted is retried as that turn. The time-limited turn it continued no longer counts as an earlier failure of the lane.
- Run log and timings: a turn that ends in an error keeps the run log and command timings of what it streamed. Every turn records `agent/turn-timings`: each command's start and duration, the wrap-up, and the steps tools append to `INSTAFY_STEP_TIMINGS_FILE`.
- Eval: the Octo turn eval shows where each case's time went. A continued turn no longer fails `job_succeeded`.

No package changes.
