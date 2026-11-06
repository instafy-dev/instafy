---
"@instafy/cli": patch
---

`instafy web search` runs in a turn with no time limit again: the runtime gives such a turn a start and no deadline, which the command took for no turn at all, so nothing was searched. Such a turn lasts while the folder the runtime made for its job is there, so a process left over from it cannot search once the job has ended. A site a turn starts to outlive it (`instafy preview open --start`, `instafy bind serve --detach`) no longer carries the turn's `INSTAFY_TURN_*` values, so it is never taken for the turn.
