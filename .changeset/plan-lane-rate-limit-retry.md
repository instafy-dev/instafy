---
---

A team plan's lane that stops on a short upstream rate limit before it did anything (no command, MCP tool call or file change; a web search is fine) is now started once more in the same group, on the runtime that ran it, after the wait the provider stated plus a per-lane jitter (at most 45 s). While that retry waits the group stays open, so the lead is not woken early to re-plan the lane. It happens at most once per lane. Usage, plan and quota limits, auth errors, other 4xx, waits over 30 s and a 429 without a stated wait are never retried. The shared provider rate-limit classifier now also treats "You've hit your usage limit" as a usage limit, as the Studio already did. No package changes.
