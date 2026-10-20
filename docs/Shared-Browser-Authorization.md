# Shared Browser authorization

Shared Browser access is independent of workspace file access. Origin tokens use
two browser-specific scopes:

| Scope | Allows |
| --- | --- |
| `browser.view` | Capabilities, page metadata, the action feed, and browser pixels. |
| `browser.control` | Focusing a page, navigation/history/reload commands, and pointer/keyboard input. |

`fs.read` and `fs.write` do not grant browser access. Browser scopes are valid
only for an `http` origin token and do not require a workspace lease: browser
input changes an ephemeral Chromium session, not the canonical workspace.

## Transport rules

- `/browser/capabilities`, `/browser/pages`, and `/browser/actions` require
  `browser.view`.
- `/browser/collaboration` requires `browser.view` plus the controller-signed
  browser surface identity. View-only members may publish bounded presence and
  cursors but cannot acquire control.
- `/browser/pages/:pageId/focus`, `/browser/pages/:pageId/command`, and the
  input-only websocket require `browser.control` and the exact live driver
  lease. Ownership is rechecked immediately before every mutation.
- CDP screencast and a WebRTC offer require `browser.view`; both are pixel-only
  and close at the signed grant deadline. Their separate input websocket still
  requires `browser.control` and the live driver lease.
- RFB requires both scopes and the live driver lease because raw pixels and
  input share one protocol. The origin rechecks ownership before every
  client-to-VNC packet.

Builder-or-higher Shared Browser surfaces request both scopes; Viewer surfaces
request `browser.view` only. Narrow metadata and command helpers request only
the scope needed for that operation. The controller proxy and runtime origin
enforce the same route-to-scope mapping so neither path can weaken the other.

## Steering an active browser turn

Steer adds text to an agent turn that is already running, and the runtime
delivers it to the model without an author. For a turn that drives a Shared
Browser or a Desktop Personal Browser (`browserTransport` of `shared` or
`desktop-personal`), that text would act inside one person's signed-in browser
session, so the controller limits steering to the person whose prompt started
the turn.

- The author is the `prompts.user_id` that dispatch recorded from the signed-in
  caller. Client metadata such as `metadata.userId` is never consulted.
- Any other caller, including a trusted service token without a user, receives
  `403` with code `browser_turn_steer_forbidden`. A browser turn with no
  recorded author cannot be steered by anyone.
- The refusal happens before anything is stored: no transcript message and no
  job input is created. Queue remains available to every member with write
  access, and a queued message starts a new turn after the current one ends.
- Ordinary agent turns keep the existing rule: anyone with write and
  conversation access may steer them.

Studio shows the refusal as "Only the person who started this browser task can
steer it. Queue your message instead." Older Studio builds show the
controller's message for the same refusal.
