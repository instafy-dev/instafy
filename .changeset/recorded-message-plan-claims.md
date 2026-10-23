---
---

A message a space member records through `/conversations/:id/messages/record` (or sends to a running job) can no longer carry `multiAgentPlan` metadata; the controller strips it, as it already strips controller-notice, site-intent and group-participation claims. Studio reads a message's `multiAgentPlan` for a team card's lanes and, since #683, for which lane a later run replaced, so a forged message could make a failed lane show as continued and drop it from "need attention" for everyone in the space. Messages the controller records keep it. No package changes.
