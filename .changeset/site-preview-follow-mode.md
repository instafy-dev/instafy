---
---

Site previews get follow mode: a member presents a preview from its browser bar and the others in the space follow it live, each in their own copy of the site, from the bar or the "Ready to preview" card. Only what the site says is visible travels (small JSON, through a controller relay with its own Redis channel); nothing is stored. Present is offered only for a site that says it can share its view, a view holding the presenter's own position is not sent, and a preview that stops or closes ends its presentation. Presenting survives opening a run tab or another chat and carries on its sequence numbers when the pane comes back. The frontend-previews skill tells Octo how to make a site followable. No package changes.
