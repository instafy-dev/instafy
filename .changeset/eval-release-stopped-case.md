---
---

The Octo turn eval now deletes each case's space through the controller when the case ends, instead of stopping its
containers with docker. That cancels the case's queued and running work and releases its runtimes, so a builder's
queued continuation can no longer wake a runtime after the case was graded, and no runtime row is left `requested`.
Eval scripts only; no package changes.
