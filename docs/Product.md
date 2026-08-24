# Product Overview

Instafy Studio is a browser-based AI workspace for chatting with a runtime controller and editing space files. The Studio prioritizes three surfaces: Assistant, Files, and Credits.

## Studio Surface
- **Assistant**: conversational control of the workspace, runs, and file changes.
- **Files**: Monaco editor + file explorer backed by the controller workspace.
- **Credits**: team-scoped credits, plan selection, and Stripe-backed subscription management.

## Header
The Studio header is owner-first: `Team/Personal > Space`, followed by runtime status and the user menu.

## Composer delivery actions

The composer exposes three one-shot actions instead of a persistent delivery mode:

- **Steer** adds the message to the matching agent's active turn. While that turn is active,
  `Enter` and the primary send control steer it.
- **Queue** saves the message for the matching agent's next turn. Use `Cmd+Enter` on macOS or
  `Ctrl+Enter` elsewhere. If there is no matching active turn, the controller may dispatch it
  immediately rather than leave an idle queue entry behind.
- **Stash** saves a private draft without creating a transcript message, run, or job. Use
  `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` elsewhere, or choose **Stash draft** from the
  composer actions. Stashes never auto-send, remain private to their author, and are capped per
  author and conversation at 50 drafts and 5 MiB of serialized draft data.

`Shift+Enter` always inserts a newline. When no matching agent is active, ordinary `Enter` sends a
new turn. A queued message's edit action is named **Edit**, reserving **Steer** for genuine active-
turn input.

## Scope Guardrails
- No preview/publish UI.
- No custom domains or domain purchase flows.
- GitHub repository import is available for onboarding existing code into a space.
- Broader integrations such as issue/PR workflow automation and hosting are future, opt-in, and must be driven by conversation runs.

## Notes
- The filesystem is the source of truth; the controller reads/writes under each space workspace.
- Keep UI copy aligned with the chat + filesystem focus.
