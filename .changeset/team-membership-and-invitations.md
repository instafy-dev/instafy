---
"@instafy/cli": patch
---

Add `instafy team` commands for managing team membership and invitations: `members` lists a
team's people, `invite` sends an email invitation, `invite-link` creates a shareable join link,
`invites` lists what is pending, `add-member` adds an existing account by user id, `accept` joins
from a token, and `revoke-invite` / `revoke-link` remove pending invitations and links. The team
is resolved from `--team-id <uuid|slug>` and falls back to your only team when you belong to one.
