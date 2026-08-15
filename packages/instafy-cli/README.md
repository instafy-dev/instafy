<p align="center"><code>npm i -g @instafy/cli</code></p>

# Instafy CLI (Preview)

Run Instafy spaces locally and connect them back to Instafy Studio — from any terminal.

## Quickstart

0. Log in once: `instafy login`
   - Opens a Studio URL; the CLI continues automatically after you sign in.
   - Also enables Git auth (credential helper) for Instafy Git Service. Disable with `instafy login --no-git-setup`.
   - Multiple accounts: `instafy login --profile work` (then bind folders with `instafy space init --profile work` or `instafy space profile work`).
   - Optional: set defaults with `instafy config set controller-url <url>` / `instafy config set studio-url <url>`
1. Link a folder to a space:
   - VS Code: install the Instafy extension and run `Instafy: Link Workspace to Space`, or
   - Terminal: `instafy space init`
2. Start the runtime: `instafy runtime start`
3. Check status / stop:
   - `instafy runtime status`
   - `instafy runtime stop`

## Common commands

- `instafy runtime start` — start a local runtime (agent + origin).
  - A private local start receives a controller-assigned runtime/origin ID, registers without the hosted allocator, and requests its tunnel after registration with no runtime lease.
- `instafy runtime status` — show health of the last started runtime.
- `instafy runtime stop` — stop the last started runtime.
- `instafy space invite <email>` — invite a teammate to the linked space by email.
  - Optional: `--role viewer|builder|admin|owner`
- `instafy space role <email> <role>` — update a teammate's access in the linked space by email.
  - Works for existing members and pending invites.
  - `builder` means read & write.
  - Fallbacks: `--space <id>` or `--team-id <uuid>` when the folder is not linked yet
- `instafy conversation search "<keywords>"` — find earlier conversations in the linked space by title, preview, and recent message content.
- `instafy conversation show "<title-or-id>"` — inspect one conversation’s messages so you can reuse earlier context in a new chat.
- `instafy conversation create --parent <conversationId> --thread-kind agent --title "Octo coordination"` — create a linked child thread for conversation-native agent coordination.
- `instafy chat --conversation <threadId> "@octo ..." --no-wait` — involve another agent by posting a normal message into a normal conversation/thread. Use non-blocking posts from inside an active runtime turn.
- `instafy agents list` — list available top-level agents.
- `instafy agents context list --query "<topic>"` — inspect optional compact scoped context-card hints for cross-agent coordination.
- `instafy agents context put --agent @octo "<summary>"` — save/update a compact context card for the current conversation when `INSTAFY_CONVERSATION_ID` is set.
- Context cards are a bounded cache, not the primary collaboration path: the controller keeps the newest 200 cards per user/project/agent.
- Use context cards for soft work focus and overlap hints, not hard locks: note the agent/thread, topic/path/domain, open questions, and where follow-up should go. Structured `writeScope` metadata remains the safety mechanism for concurrent file edits.
- `instafy git <args...>` — run git commands against an Instafy canonical checkout (`.instafy/.git`) when present.
- `instafy tunnel start` — start a detached tunnel for a local port (sticky hostname by default; use `--rotate` to mint a new one).
  - `instafy tunnel list` — list local tunnels started by the CLI.
  - `instafy tunnel logs <tunnelId> --follow` — tail tunnel logs.
  - `instafy tunnel stop <tunnelId>` — stop + revoke a tunnel.
- `instafy secrets list` — list space secret metadata (names/descriptions, never values).
- `instafy secrets get <name-or-id>` — inspect one space secret metadata entry.
- `instafy secrets put <name> --value ...` — create/update a space secret.
- `instafy secrets revoke <name-or-id>` — revoke a space secret.
- `instafy support report "Runtime stops after launch"` — submit a support report as the
  signed-in user.
- `instafy support list` — list only your own support reports.
- `instafy support show <reportId>` — inspect one of your own support reports.
- `instafy diagnostics runtime-events` — emit sanitized runtime events for the linked space as
  versioned JSON.
- `instafy diagnostics run-result <runId>` — emit one authorized persisted run result as
  versioned JSON.
- `instafy providers list` — list local providers exposed by the shared provider host surface.
- `instafy providers discover <providerId>` — run fresh discovery for one provider.
- `instafy providers read <providerId> <uri>` — inspect one provider resource.
- `instafy providers probe <providerId>` — run a transport probe against one provider.

Run `instafy --help` for the public command list and options.

## AI-readable diagnostics

`instafy diagnostics` is the machine-readable diagnostics surface for local agents such as Codex
or Claude Code. Successful commands print the `instafy-diagnostics-v1` JSON contract; failures
exit non-zero with empty stdout and a human-readable stderr message. They do not require a
dashboard and do not scrape process logs.

```bash
instafy diagnostics runtime-events --space <spaceId> --limit 50
instafy diagnostics run-result <runId>
```

These commands accept only signed-in user credentials. The controller applies normal space,
conversation, and private-runtime authorization and sanitizes stored runtime-event data. A
diagnostic read never creates or enriches a support report automatically; use `instafy support
report` explicitly when information should be sent to support.

For `run-result`, top-level `status: "ready"` means a persisted result is available, not that the
run succeeded. Inspect the nested result status or outcome before making that decision.

## Support and operator boundary

`instafy support` is the customer-facing support surface. It requires a human user login (or an
explicit user access token), and the controller limits list/show operations to reports owned by
that user. Reports use the currently linked space by default; pass `--no-linked-space` to omit that
context. Diagnostics are opt-in: details, metadata, logs, and screenshots are uploaded only when
their corresponding flags are supplied, and file inputs must stay within the active workspace.
Use `--preview` to inspect the upload summary without sending a report.
Ordinary users receive a minimized owner-only report view; full triage fields and attachment bytes
require operator/service authorization.

Hosted Instafy operator access belongs in a separate, non-public `instafy-ops` distribution. It is
not part of this open-source package. The former `ops`, raw `api`, `ota`, and `desktop-updates`
command groups have been removed from the customer artifact. Saved login tokens are never
forwarded or refreshed to a different controller origin.

## Docs

- CLI reference & troubleshooting: https://github.com/instafy-dev/instafy/blob/main/docs/CLI.md
