# Instafy CLI

The Instafy CLI helps you run an Instafy runtime on your own machine (or server) and connect it back to Instafy Studio.

## Install

```bash
npm i -g @instafy/cli
```

## Login

The CLI needs a user access token for most space actions. The easiest way is:

```bash
instafy login
```

This prints a Studio URL where you can sign in. After you finish logging in, the Studio page will send the token back to the CLI automatically (no copy/paste). If that callback fails, you can still copy the token from the page and paste it into the terminal.

If you haven't configured a server/studio yet, `instafy login` will use `http://localhost:5173` only when it can reach it (and a local controller is selected); otherwise it will use `https://staging.instafy.dev` with `https://controller.instafy.dev`.

By default, `instafy login` also installs a git credential helper so `git clone` / `git push` works with Instafy Git Service without copying tokens. Disable with `instafy login --no-git-setup`.

## Profiles (multiple accounts)

By default, `instafy login` stores a single token globally in `~/.instafy/config.json`.

If you need different users in different folders, use named profiles:

```bash
instafy login --profile work
instafy login --profile personal
```

Bind a folder to a profile (writes a non-secret `profile` name into `.instafy/space.json`):

```bash
instafy space profile work
```

Utilities:

```bash
instafy profile list
instafy logout --profile work
```

Resolution order for auth (highest → lowest priority): explicit flags/env tokens → folder `profile` → global config.

## Core concepts

### Space manifest

Most commands look for a space manifest at `.instafy/space.json` (walks up from the current directory). Create one via:

```bash
instafy space init
```

Invite a teammate to the linked space:

```bash
instafy space invite teammate@example.com
instafy space invite teammate@example.com --role viewer
instafy space role teammate@example.com builder
instafy space role teammate@example.com admin
```

If the current folder is not linked yet, pass `--space <spaceId>` or `--team-id <teamId>`.

Inspect earlier conversations in the linked space:

```bash
instafy conversation search "fruit discussion"
instafy conversation show "Fruit planning"
instafy conversation show 123e4567-e89b-12d3-a456-426614174000
```

Use this when you want to reuse context from an earlier chat without manually hunting through the Studio UI.

Coordinate agents through normal conversations and linked threads:

```bash
instafy conversation create --parent <conversationId> --thread-kind agent --title "Octo coordination" --json
instafy chat --conversation <threadId> "@octo can you summarize what you know about the checkout copy?" --no-wait --json
```

This is the preferred agent-to-agent coordination model. The current/default agent can act as coordinator, but it should coordinate by creating/reusing normal child threads, posting normal `@agent` messages, and referencing useful results with inline references:
`[[conversation:<conversationId>|<label>]]` for an ordinary prior chat, `[[thread:<conversationId>|<label>]]` for a linked agent lane, and `[[message:<conversationId>/<messageId>|<label>]]` for exact evidence.
When this command is run from inside an active runtime agent turn, keep peer posts non-blocking (`--no-wait`) so the current turn can finish and the target agent can pick up the child-thread job.
For actual top-level parallel execution, run multiple available runtimes; one runtime may process leased agent jobs serially.

Inspect available agents and their compact scoped context cards:

```bash
instafy agents list
instafy agents context list --query "auth flow"
instafy agents context put --agent @octo --scope-kind conversation --scope-id <conversationId> "User prefers the short checkout copy from the auth thread."
```

Agent context cards are optional compact coordination hints/cache, not the primary collaboration path. They are keyed by `agent`, `scopeKind`, and `scopeId`; for now `scopeKind=conversation` maps to the Instafy conversation/work-thread boundary. The controller keeps the newest 200 cards per user/project/agent, so cards should summarize durable coordination context rather than every conversation fact.

Use context cards for soft work focus instead of a first-class ownership ledger. A useful card says which agent/thread is investigating which area, paths, open questions, and where focused follow-up should go. It is a hint for coordination, not a lock. For concurrent file edits, the separate structured `writeScope` metadata still controls safety.

For cross-chat context recovery, search cards first, then conversation/thread history:

```bash
instafy agents context list --query "auth session" --json
instafy conversation search "auth session" --include-threads --json
instafy conversation show <conversationId> --json
```

A same-handle agent in a new chat should not assume it has global memory from old threads. Reuse or message the old thread when that thread should keep owning the topic; otherwise answer from recovered evidence and cite the conversation, thread, message, or context card.

### Provider bindings

Project-scoped provider access is stored next to the linked space manifest at `.instafy/provider-bindings.json`.

The same file is also managed from Studio under Project Settings → Guests & access → Provider access, so CLI and Studio stay on one project-local binding record.
Provider integrations consume that same record for mutating flows, so grant/revoke changes take
effect in the active provider surface instead of being CLI-only metadata.

Inspect current bindings:

```bash
instafy space provider-bindings show
instafy space provider-bindings show demo
```

Grant a provider access to the linked project:

```bash
instafy space provider-bindings grant demo \
  --purpose "Persist provider state and session summaries" \
  --prefix ".instafy/providers/demo/" \
  --capability project_content_read \
  --capability project_content_write
```

Revoke a provider binding:

```bash
instafy space provider-bindings revoke demo
```

This is a project-local binding record, not a second storage system. The project filesystem remains the persistence boundary.

### Server URL

The default server URL is `http://127.0.0.1:8788` (local dev). Override via `--server-url`, `INSTAFY_SERVER_URL`, or `instafy config set controller-url https://controller.instafy.dev`.

## Config

The CLI stores defaults under `~/.instafy/config.json`. Manage it with:

```bash
instafy config list
instafy config set controller-url https://controller.instafy.dev
instafy config set studio-url https://staging.instafy.dev
```

Profiles are stored under `~/.instafy/profiles/<name>.json` and are selected by `.instafy/space.json` (`profile`) or `INSTAFY_PROFILE`.
Changing or unsetting the saved controller origin clears the saved login session; run
`instafy login` again for the new controller.

## Auth & tokens

The CLI supports a few ways to authenticate, depending on what you have available:

- **Saved CLI token (recommended)**: run `instafy login` once (stores token in `~/.instafy/config.json`).
- **Studio access token** (recommended): pass `--access-token` or set `INSTAFY_ACCESS_TOKEN`.
- **Supabase session token** (convenient): pass `--supabase-access-token` / `--supabase-access-token-file` or set `SUPABASE_ACCESS_TOKEN`. The CLI will exchange this session for server + runtime/origin tokens automatically.
- **Pre-minted runtime/origin token**: pass `--runtime-token` / `RUNTIME_ACCESS_TOKEN` (also reused for origin), or `--origin-token` / `ORIGIN_INTERNAL_TOKEN`.

Public commands use an interactive user token from `instafy login` (or an explicit user access
token). Hosted service credentials belong to the separate `instafy-ops` distribution. A runtime
may still pass its narrowly scoped child-process credential to commands invoked inside an active
agent job; that internal runtime contract is not a public shell credential fallback.

### How token minting works

- When `--access-token` (or `INSTAFY_ACCESS_TOKEN`) is provided and `--runtime-token` is not, the CLI mints a **runtime access token** via `POST /projects/:spaceId/runtime/token`.
- The minted token is exported to the runtime as `RUNTIME_ACCESS_TOKEN` and mirrored to `ORIGIN_INTERNAL_TOKEN` for the bundled origin server.

Runtime/origin tokens require the server to be configured with the Ed25519 signing pair:

- `RUNTIME_SIGNING_PRIVATE_KEY`
- `RUNTIME_SIGNING_PUBLIC_KEY`

## Git (git-canonical)

### `instafy git`

When working inside an Instafy git-canonical workspace (where `.instafy/.git` exists), you can run git commands against the canonical repo with:

```bash
instafy git status
instafy git add -A
instafy git commit -m "instafy: checkpoint"
instafy git push origin HEAD:main
```

## Runtime lifecycle

### `instafy runtime start`

Starts the local runtime (agent + origin). It records state under:

- `~/.instafy/cli-runtime-state.json` (PID, space ID, workspace, server URL)
- `~/.instafy/cli-runtime-logs/*` (when detached/logging is enabled)

Notes:

- The CLI prefers a local `runtime-agent` binary when running inside this monorepo. Docker
  fallback is explicit: set `INSTAFY_RUNTIME_AGENT_IMAGE` to a locally built tag or an
  immutable published OCI digest. It does not silently pull a mutable `latest` channel.
- `runtime start` runs in the foreground by default; use `--detach` to background it.

### `instafy runtime status`

Shows health information for the last started runtime (server/proxy/origin).

### `instafy runtime stop`

Stops the last started runtime recorded in `~/.instafy/cli-runtime-state.json`.

## Local Hardware

The CLI is the first headless entrypoint for host-native hardware capabilities. Desktop should use
the same runtime/provider contracts and add approval UI on top, rather than implementing USB or BLE
access only inside Electron views.

Project-scoped hardware access is stored next to the linked space manifest at `.instafy/hardware-bindings.json`.
This is separate from `.instafy/provider-bindings.json`: provider bindings grant project file access, while
hardware bindings grant local host capability/device access. Studio project settings use the same file for
manual local-device approval inside the same access card as provider file access; the CLI remains the
headless/admin path.

Inspect current hardware bindings:

```bash
instafy hardware bindings show
instafy hardware bindings show hardware.serial
```

Grant serial discovery/probe access for the linked project:

```bash
instafy hardware bindings grant hardware.serial \
  --purpose "Probe attached USB serial devices" \
  --device /dev/cu.usbserial-130
```

Revoke hardware access:

```bash
instafy hardware bindings revoke hardware.serial
```

List serial devices visible to the current host:

```bash
instafy hardware serial list
instafy hardware serial list --json
```

Probe one serial device path without writing to the device:

```bash
instafy hardware serial probe --device /dev/cu.usbserial-130
instafy hardware serial probe --device /dev/ttyUSB0 --json
```

List and run runtime-native IO actions. Project-specific hardware guidance belongs in compact
agent context cards; the CLI only verifies local serial access on demand.

```bash
instafy hardware opportunities
instafy hardware run serial.probe --device /dev/cu.usbserial-130
```

This only proves what the current process can see and access. If the runtime is inside Docker, the
serial device must still be passed into the container, or a host-native provider bridge must run
outside Docker. On macOS, BLE/CoreBluetooth should stay host-native because Bluetooth permissions
are app/bundle-id scoped. If a provider project needs BLE or flashing checks, store that as a
compact context card and let the agent run the relevant repo command after verifying it is on a
suitable Desktop or CLI runtime. Runtime prompts can include matching project cards directly; the
CLI remains the manual inspection/update surface.

Example soft host-IO hint, scoped to the project rather than committed as a skill:

```bash
instafy agents context put \
  --space <spaceId> \
  --agent @octo \
  --scope-kind project \
  --scope-id <spaceId> \
  --title "Device-provider host IO" \
  "Hints only: ESP32 was last seen on /dev/cu.usbserial-130 from the macOS bench host; verify before BLE or flashing work."

instafy agents context list --space <spaceId> --query "device-provider serial" --json
```

## Tunnels

Tunnels are server-managed: the runtime requests a tunnel assignment and then launches a local client.

### CLI usage

`instafy tunnel start` starts a local tunnel client (rathole) and prints a public URL.

- Default: **detached** (non-blocking) and writes logs to `~/.instafy/cli-tunnel-logs/*`.
- Foreground: `instafy tunnel start --no-detach` (streams logs until you `Ctrl+C`).

Manage detached tunnels:

```bash
instafy tunnel list
instafy tunnel logs <tunnelId> --follow
instafy tunnel stop <tunnelId>
```

- For self-hosted tunnels, the server returns `provider=self_hosted` when configured with:
  - `TUNNEL_BROKER_BASE_URL`
  - `TUNNEL_BROKER_TOKEN`

The CLI/runtime uses `rathole` (outbound-only) to connect to the broker. The CLI will:

- Use `RATHOLE_BIN` if set, otherwise
- Look on `PATH`, otherwise
- Download/cache a matching binary under `~/.instafy` (best-effort)

If you have a stable, reachable origin URL and don’t want tunnels, set `--origin-endpoint`.

### Security note (Origin auth)
The runtime origin serves space files over HTTP. When the origin is reachable from anything other than the local machine (tunnel, reverse proxy, port-forward, etc), keep auth **enabled**.

- Do **not** run with `ORIGIN_SKIP_AUTH=1` for any non-local usage.

## AI-readable diagnostics

`instafy diagnostics` exposes existing, user-authorized diagnostic records as stable JSON for
local agents and scripts. It is intentionally CLI-first; no dashboard is required for this
workflow.

```bash
# Sanitized persisted events for the linked space
instafy diagnostics runtime-events --limit 50

# Optional event filters
instafy diagnostics runtime-events \
  --space <spaceId> \
  --runtime-id <runtimeId> \
  --kind <eventKind> \
  --since 2026-08-15T12:00:00Z

# Authorized persisted result and artifacts for one run
instafy diagnostics run-result <runId>
```

On success, both commands emit an `instafy-diagnostics-v1` JSON envelope. On failure they exit
non-zero, leave stdout empty, and write a human-readable error to stderr. They accept a signed-in
user session or explicit user access token, but not ambient service-role or runtime credentials.
The controller enforces space and private-conversation access for run results. Runtime events come
from the bounded, sanitized runtime-event store and retain its private-runtime visibility checks.
For `run-result`, a top-level `status` of `ready` means the persisted result is available; agents
must inspect the nested result status or outcome before deciding whether the run succeeded.

The v1 success envelopes are:

- `runtime-events`: `schemaVersion`, `kind`, `spaceId`, and newest-first `events`. Each event has
  `runtimeId`, `kind`, `createdAt`, and sanitized but otherwise open JSON `data`.
- `run-result`: `schemaVersion`, `kind`, `runId`, nullable `conversationId`, `status`
  (`pending`, `ready`, or `error`), and nullable open JSON `result`.

Diagnostic reads never submit a bug report and never attach data to an existing report. An agent
must invoke `instafy support report` explicitly, with explicit diagnostic flags, before anything
is uploaded to support.

## Customer support reports

Use `instafy support` to send a report and review the reports created by your signed-in user:

```bash
instafy support report "Runtime stops after launch"
instafy support list --json
instafy support show <reportId> --json
```

The controller enforces customer mode for these requests: `list` and `show` can access only the
current user's reports, even though the underlying support system is also used by operators. A
report can default to the space linked by `.instafy/space.json`; use `--space <spaceId>` to select
one explicitly or `--no-linked-space` to omit space context.

Only the summary and selected context are submitted by default. Extra diagnostics require explicit
flags:

```bash
instafy support report "Build fails on startup" \
  --details-file ./support-details.txt \
  --metadata-file ./support-metadata.json \
  --logs-file ./support-logs.json \
  --screenshot ./failure.png
```

The metadata file must contain a JSON object, the logs file must contain a JSON array, and each
screenshot must be a PNG, JPEG, or WebP file. Attachment inputs must remain inside the active
Instafy workspace; outside paths and symlink escapes are rejected. Nothing discovers or attaches
logs, metadata, or screenshots automatically. Before uploading, inspect a bounded description of
the payload without sending it:

```bash
instafy support report "Build fails on startup" \
  --logs-file ./support-logs.json \
  --screenshot ./failure.png \
  --preview
```

`support show` returns only the customer-safe report view. Stored metadata, logs, internal triage
fields, and screenshot bytes are never returned by the customer endpoint; screenshot descriptors
show which images were attached. The controller applies the same minimized projection to legacy
bug-report reads made by ordinary users; only operator/service authorization can retrieve the full
triage record and attachment bytes.

## Teams and invitations

Manage team (organization) membership and invitations with `instafy team`. Every subcommand
resolves the team from `--team-id <uuid|slug>`. If you omit it and belong to a single team, that
team is used automatically; otherwise the command asks you to pass `--team-id` and points you at
`instafy team list`.

List teams and their members:

```bash
instafy team list
instafy team members --team-id acme
```

There are two ways to bring someone in:

- An **email invitation** targets one address. The person must sign in to Instafy with that exact
  email to accept.
- An **invite link** is a shareable token. Anyone who opens it and signs in — with any sign-in
  method — can join, so treat it like a shared secret.

```bash
# Email invitation (roles: owner, admin, builder, viewer; default builder).
# Only owners can assign the owner role.
instafy team invite teammate@example.com --role builder --team-id acme

# Shareable invite link (roles: builder or viewer; default builder).
instafy team invite-link --role builder --team-id acme
```

`instafy team invite-link` prints the full accept URL and the token. The URL is the Studio base
(from config, `INSTAFY_STUDIO_URL`, `--studio-url`, or the default `https://instafy.dev`) joined
with the controller-returned accept path, for example:

```
https://instafy.dev/invite?token=<uuid>&panel=chat
```

If the invitee already has an Instafy account, add them directly instead of emailing an invite:

```bash
instafy team add-member --user-id <uuid> --role builder --team-id acme
```

Review and clean up pending invitations and links:

```bash
instafy team invites --team-id acme
instafy team revoke-invite <invitation-id> --team-id acme --yes
instafy team revoke-link <invite-link-id> --team-id acme --yes
```

`revoke-invite` and `revoke-link` ask for confirmation on an interactive terminal; pass `--yes` to
skip the prompt (required when there is no TTY).

Accept an invitation or invite link as the account you are currently signed in with:

```bash
instafy team accept <token>
```

Add `--json` to any of these commands for machine-readable output.

## Scheduled automations

Create and manage scheduled project prompts with `instafy automations`. When no local space
manifest is available, pass `--space` to the project-scoped `list` and `create` commands.

For checks that should report only findings, opt in at creation time:

```bash
instafy automations create --json \
  --space "<Project ID>" \
  --name "Dependency change check" \
  --prompt "Check whether dependency versions changed and report the changes." \
  --schedule-kind weekly \
  --days mo,tu,we,th,fr \
  --time 08:00 \
  --timezone "Europe/Vienna" \
  --silent-when-nothing-to-report
```

The flag is default-off. It suppresses only the completion result message and result notification
for a successful run that explicitly finds nothing to report; results, errors, unexpected empty
output, and execution records remain visible. See
[Automations](Automations.md) for the controller semantics and audit behavior.

## Public and operator CLI boundary

The published `@instafy/cli` package is the customer and self-hoster CLI. Hosted Instafy staff
operations, including cross-customer investigation and rollout administration, belong in a
separate, non-public `instafy-ops` distribution. That private distribution is not packaged by this
repository.

The former `instafy ops`, raw `instafy api`, `instafy ota`, and `instafy desktop-updates` command
groups are not included in the public artifact. Public automation should use typed customer or
self-hoster commands; hosted operational tooling must live in `instafy-ops`.

## Help

- Public command reference: `instafy --help`
- Per-command options: `instafy <command> --help`
