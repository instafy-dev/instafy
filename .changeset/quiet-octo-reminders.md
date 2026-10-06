---
"@instafy/cli": patch
---

Add commands to inspect, dismiss, and reschedule a proactive recommendation's reminder from its chat. Reminder commands preserve the current job's scoped credentials and report the controller's saved preference.

Automation commands now use the active runtime job's scoped controller credential for conversational cadence changes, preserving its controller origin binding without requiring a separate user login.

Creating an automation from a runtime job now requires an explicit timezone or the current client's known timezone. An unknown client timezone cannot silently fall back to the runtime host's timezone; human CLI defaults and updates that preserve an existing timezone remain unchanged.
