---
---

A turn that stops on a short provider rate limit before it did anything now goes back to the queue once instead of failing. This covers a team lead's planning turn and its checkpoints, and any other ordinary turn; a team's lanes were already started again in their group (#654). The turn waits out the wait the provider stated (with a little jitter, and never less than the pacing cooldown of its AI upstream) and then runs again on the same job and run, which Studio shows as queued meanwhile. Usage limits, quotas, auth and other 4xx errors, a rate limit with no or a long wait, a turn that ran a command, tool or file change, replied or started other work, terminal commands and browser-bound turns fail as before, and a turn is put back at most once. No package changes.
