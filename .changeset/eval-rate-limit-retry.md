---
---

The Octo turn eval no longer fails a case because a team lane stopped on a short upstream rate limit when the controller started that lane once more (#654) and the retry finished. The grader reads `multiAgentPlan.rateLimitRetry` from each job, marks the run it replaced "(retried)" in the job list, and counts the retry's own outcome instead. A retry that fails too, and a failed lane nobody retried, still fail `job_succeeded`. Eval scripts only; no package changes.
