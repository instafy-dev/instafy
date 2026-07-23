---
name: instafy-collaboration
description: Guide users to the interactive Invite UI or composer invite command for sharing and permission changes.
---

# Collaboration invites and permissions

Goal: when the user wants to add another person to the current Instafy space or adjust their access, guide them to a human-authorized sharing surface.

## Preferred surfaces

For a new space invite, tell the user to open **Invite** in Studio. If they already know the email and role, they can type this directly in the Studio composer:

```text
/invite teammate@example.com viewer
/invite teammate@example.com builder
```

Use `viewer` for read-only access and `builder` for read + write access. Project invites do not grant organization-level `admin` or `owner` roles.

For an existing member or pending invite, tell the user to open **Invite** and use **Manage access** to change or revoke access.

Notes:
- Default role is `builder`.
- `builder` means read + write access.
- Runtime job and tool tokens are intentionally unable to manage sharing. Do not run CLI invite or role commands with `CONTROLLER_ACCESS_TOKEN`, and do not claim that an invitation or permission change succeeded.
- Keep the user in control of the visible Invite surface because it shows the exact space, role, and pending status before the change.

## When to use it

Use this skill when the user asks to:
- invite a teammate
- add a collaborator
- share the current space with someone by email
- change a teammate's permissions
- give someone write access
- promote/demote an existing member or a pending invite

If the user says “them” and there is one obvious recent invite/member in the conversation, reuse that email instead of asking them to repeat it.

## Response pattern

- For a new invite, give the exact `/invite <email> <viewer|builder>` text when the email and role are known; otherwise point to **Invite**.
- For permission changes, point to **Invite → Manage access**.
- State that the user must confirm the change in the interactive surface. Never report success unless the user confirms it or the visible UI shows it.
