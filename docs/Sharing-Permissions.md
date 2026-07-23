# Sharing, Invitations, and Permissions

This document defines the shipped collaboration contract. In the UI, a **space** is a project and a **team** is an organization.

## Project access

The controller returns an effective role plus explicit `canWrite`, `canShare`, and `canManage` capabilities. The capabilities are authoritative because the same role can have different governance rights depending on how it was granted.

| Effective role | Read | Write | Share project access | Manage |
| --- | --- | --- | --- | --- |
| Viewer | Yes | No | No | No |
| Builder | Yes | Yes | Only when inherited from team membership | No |
| Admin | Yes | Yes | Yes when inherited from team membership | Yes when inherited from team membership |
| Owner | Yes | Yes | Yes | Yes |

Important details:

- Effective access combines project ownership, direct project membership, and team membership, keeping the strongest role and capabilities.
- A direct project builder can edit but cannot grant access. A team builder can edit and share projects in that team. A project owner can always share their project.
- Project invitations grant only `viewer` (Read) or `builder` (Edit) access. Team invitations can grant viewer, builder, admin, or owner; only a team owner may grant or manage the owner role.
- Accepting an invitation can add or upgrade access, but it never downgrades an existing stronger role.
- Viewer is enforced as read-only by the controller, not just by hidden controls. Viewers can inspect the workspace and chats they are allowed to see, but cannot send prompts, modify files or source-control state, change project settings, manage runtimes/providers/devices, or create other project mutations.
- The Studio fails closed while capabilities are unresolved and refreshes them on focus, visibility changes, explicit access-change events, and periodically while visible. Member and invitation changes publish a target-user control event only after the database commit; it contains no role or project content, and the client clears stale capabilities before refetching the authoritative summary. Team-wide changes use one target-user invalidation rather than one event per project. The controller still reauthorizes every request.

## Inviting another person to a space

Open **Invite** from the chat composer or use **Space settings**, choose **Read** or **Edit**, then use one of these paths:

### Link, system share, or QR

- Copy creates an HTTPS accept link. The system share action sends the same link through the device share sheet.
- QR displays that access-granting link for scanning on another device.
- The recipient must sign in before accepting. A link is not restricted to a particular email address, so treat it like a secret.
- A project invite link remains reusable until it is revoked or expires after 30 days.
- Creating a new link rotates the existing active link for the same project/private-chat scope. Project-wide and private-chat links do not revoke each other.
- Revoking a link prevents future acceptance. It does not remove people who already accepted; change or remove their membership in settings.

### Prepared email invitation

- Enter an email and choose Read or Edit. The controller creates a pending, address-bound invitation that expires after 7 days.
- **Instafy does not currently deliver the email.** The UI says **Prepare**, then immediately offers the native share sheet, an addressed `mailto:` draft when native sharing is unavailable, and **Copy link**.
- The recipient must accept while signed in with the invited email address.
- Pending invitations can be canceled. Preparing the same role again for the same email and scope returns the existing invitation; changing its role requires canceling the pending invitation first, so concurrent requests cannot silently replace its access or token.
- The secure accept URL is returned only to the creation flow. It is removed before invitation data enters the query cache, pending lists remain token-free, and `/invite` does not write the URL into chat history.

The `/invite <email> [viewer|builder]` command uses the same prepared-email behavior; it does not imply that an email was sent.

## Team invitations

Team owners and admins can prepare address-bound invitations from **Team members** settings. They can choose viewer, builder, or admin; only owners see and can select owner. Admins cannot change or remove owners, and the last owner cannot be removed.

A team invitation grants access across the team according to its role. This differs from a space invitation, which creates direct access to only that project. Team builders can share individual spaces but cannot manage team membership.

## Private chats

Private chat visibility is narrower than project visibility: project access alone does not reveal a private chat. A user must also be its creator or a participant.

- A participant with project write access can add an existing project/team member from the **Private chat** section.
- Bringing in a new person uses a Read/Edit link, QR, or prepared email invitation. Acceptance grants the selected project access and adds the person to that private chat in one transaction.
- Conversation-scoped invitations are available only for private chats and only after the chat has synchronized with the controller (normally after its first message).
- Creating, listing, canceling, or revoking a private-chat invitation rechecks both sharing permission and access to that exact conversation.

## Open on another device

**Open on my other device** is a same-account handoff, not an invitation:

- The app QR contains a token-free `instafy://studio?...` route. Copy/share uses a token-free HTTPS Studio route.
- Both routes contain navigation identifiers only. The destination device must sign in to the same account and independently pass the normal project and conversation authorization checks.
- The handoff is available to any resolved project member, including viewers, because it grants no new access.
- Scanning this QR does not connect a runtime or AI provider. Provider/device setup is a separate, write-authorized flow.

Use the Read/Edit invite QR when another person needs access. Use the device-handoff QR when the current user wants to continue on another phone or computer.

## Security invariants

- UI capability checks are usability guards; controller authorization is the security boundary. Mutating project routes require write access, sharing routes require share access, and team membership routes require owner/admin authority.
- Interactive invitation acceptance requires a real signed-in user session. Scoped runtime/tool tokens cannot accept invitations, manage sharing, or authorize general project writes.
- Invite cancellation and revocation are bound to the stored organization, project, and private-conversation scope; identifiers from another tenant or inaccessible private chat do not authorize the operation.
- Private conversation reads require project access plus creator/participant access. The same boundary applies to messages and conversation-derived runs, prompts, jobs, queues, and runtime events; personal automations and agent context remain user-scoped.
- Runtime events are operational telemetry, not a second chat store. Event payloads are allowlisted and private-conversation events retain a conversation binding for authorization.
- Invitation tokens must never be logged, pasted into chat, or included in a device-handoff URL. Use the pending-invitation list for status and cancel/revoke controls rather than redisplaying secrets.

## Release checks

Before changing this contract, verify at minimum:

1. A viewer can read but receives both disabled mutation controls and server-side rejection for writes.
2. A direct builder can edit but cannot share; a team builder can edit and share a team project.
3. Read and Edit invitations grant the selected access, and accepting either cannot downgrade an existing role.
4. An address-bound invitation rejects a different signed-in email; a revoked, canceled, expired, or already accepted token fails.
5. A nonparticipant cannot discover or manage a private chat or its invitations.
6. Device-handoff QR and copied URLs contain no invite or session token and do not grant access to a different account.
7. Mobile invite sheets scroll with the keyboard open, keep controls reachable, and render QR codes without horizontal overflow.
