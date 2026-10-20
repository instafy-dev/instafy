---
---

A write turn whose model commits its own work with `git commit` now reports those files and saves them to the workspace's origin at the end of the turn, instead of failing for "no workspace changes" or leaving them on the runtime until a later turn's refresh. No package changes.
