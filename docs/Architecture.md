# Runtime Architecture

Instafy Studio is a chat-first filesystem UI backed by the runtime controller. The controller is the source of truth for runs, leases/tokens, and credits; file contents live in the canonical workspace backend (either a local folder or a git-backed checkout flow).

## Core Components
- **Frontend**: React + Vite + Zustand + Monaco.
- **Runtime controller**: orchestrates runs, credits, and workspace filesystem access.
- **Runtime agent**: applies prompts and file edits inside a workspace.
- **AI proxy**: all model traffic must flow through the proxy (`PROXY_BASE_URL`).

## Build-Time Feature Composition

The public frontend is the complete default application. Optional product
integrations are selected at build time through
`INSTAFY_FRONTEND_FEATURE_MANIFEST`; the default manifest contains only the
public-core feature module.

Feature modules contribute typed assistants, capabilities, routes, native
extensions, runtime families, and background Studio runtime bridges. The
composition rejects duplicate identifiers. Integration-owned implementation
and branded UI stay in the integration package, while the application depends
only on the generic feature API. This is deliberately a trusted build-time
plugin seam, not a runtime marketplace or arbitrary remote-code loader.

## Filesystem Model
- Hosted workers materialize per-space workspaces under `WORKSPACE_ROOT/<project_id>`.
- The hosted workspace gateway (the controller's `HOSTED_ORIGIN_ENDPOINT`) keeps no working
  copy: it reads git objects from a disposable per-space mirror and saves each write as a commit
  on the space's canonical `main` (see
  [Hosted workspace gateway](Git-Service.md#hosted-workspace-gateway)).
- Desktop/local-canonical mode can point directly at the user's chosen folder instead of materializing a hosted checkout.
- Studio and automation should treat the **Origin** as the filesystem API (`/entries`, `/files`, `/raw`, `POST /apply`).
- Do not persist file contents (“snapshots”) into Postgres; the filesystem is the source of truth.
- Large artifacts (images/logs) stay on disk and are referenced by relative path; avoid embedding binary payloads in Supabase/Redis.
- Desktop/Web handoff dogfood scenarios are tracked in `packages/frontend/tests/playwright/journeys/desktop-web-project-handoff.md`.

### Desktop Working Copies
- The Desktop runtime supervisor (`@instafy/desktop-runtime-agent`) registers a **local workspace presence** with the controller (`PUT /projects/:id/workspaces/local`, 60s heartbeats, unregister on stop) so Studio can show where a project's files live on a device. Presence is in-memory in the controller and TTL-pruned (120s).
- The per-project working copy defaults to `<workspace root>/<project_id>`. A user-chosen folder can be bound per project (Desktop app `projectWorkspaceDirs` config → `WORKSPACE_PROJECT_DIR` env → `Config::project_workspace_dir` in the runtime-agent), in which case the runtime works directly in that folder.
- Folder binding validates before accepting: empty folders onboard by checkout; folders carrying a matching `.instafy/space.json` are adopted; anything else is rejected — the origin server also hard-fails on non-empty non-clone roots, so nothing is overwritten.
- Desktop runtimes participate in git-canonical sync only when the controller advertises a reachable remote: set `GIT_REMOTE_PUBLIC_BASE_URL` and the runtime-token response (`POST /projects/:id/runtime/token`) includes `gitRemoteUrl`, which the supervisor wires through as `ORIGIN_GIT_REMOTE_URL`. `GIT_REMOTE_BASE_URL` alone is treated as cluster-internal and is not advertised to external runtimes.
- The `instafy` CLI runtime does not register presence or receive the advertised remote yet (follow-up; it accepts explicit `--origin-*` flags).

## Space appearance

Spaces may store a small optional emoji and color in `projects.icon` and `projects.color`.
Project summaries and discovery lists expose them as `projectIcon` and `projectColor`.
`PATCH /projects/:project_id` accepts either field alongside the optional `projectName`:
omitted fields stay unchanged, and explicit `null` restores the default icon or color.
The SDK's `project-identity` contract lists the supported emoji and palette names; both
the controller and database reject other values. The existing project write permission
applies. Settings → Space → Overview saves this metadata for every client; the fallback
is the space's initial on a neutral background. No image upload or workspace-file change
is involved. Apply the additive `20260908120000_project_identity.sql` migration before
deploying the controller that reads these columns.

## Provider Project Binding

- Provider-owned persistence should reuse the same project filesystem boundary instead of introducing a separate provider state service.
- A provider may declare project access needs up front with a descriptor such as:
  - `required`
  - `purpose`
  - `requestedCapabilities`
  - `preferredPrefix`
- The host should bind that provider to a project once, then pass the granted project context into provider initialization:
  - `projectId`
  - `rootUri`
  - `grantedCapabilities`
  - `grantedPrefix`
- The provider should report one binding status back:
  - `unbound`
  - `bound_read_only`
  - `bound_read_write`
- Read-only discovery may stay available before binding. Mutating provider workflows should require writable project access.
- CLI and Studio both persist those bindings under `.instafy/provider-bindings.json` inside the linked project.
- Studio exposes project-scoped provider access in Project Settings and can also open the same approval modal from a provider request event, so the approval path stays aligned with the CLI record format.
- Provider-owned mutating flows resolve the saved binding and request approval through the same
  Studio modal before writing provider state into the project.
- The remaining host gap is generic provider-context injection into provider `initialize`; the binding record, approval flow, and one real caller exist now.

## Provider Request Queue

`POST /projects/:id/provider-tools/call` and `/provider-resources/read` queue a request for the
device a provider is attached on and hold the call open (`timeoutMs`, 5-120 s) until the device
answers through `/projects/:id/provider-requests` (list, claim, complete).

- A held-open dispatch holds no database connection while it waits. It wakes on the request's
  `provider.request.updated` event and rereads the row at least once a second.
- Each request has `expiresAt`, set on the database clock when it is queued. A device may claim a
  request, or claim one it holds again, only before then, and listings stop offering pending and
  claimed requests after it. Every copy of a request carries `ageMs`, its age on the database
  clock, which a device trusts over its own clock.
- When the wait ends, only an unclaimed request expires. A claimed one stays claimed, and its
  device's later answer is still recorded. A reply that is not the device's own carries
  `noDeviceReply`: `never_claimed` when the request ended before any device claimed it, so
  nothing will run it, or `unknown` when a device claimed it and may have run it.
- A person's own session or the service role dispatches, with project write access. No scoped
  token dispatches, whatever its scopes.
- A request may name one device (`targetDeviceId`) and belong to an agent job (`jobId`). No
  route sets either yet, and no request body can. Only the device a request names may claim it
  (403 for any other). `?deviceId=` lists only what that device may act on: requests targeted at
  it or at no device, and not claimed by another.
- A job's request is its requester's alone: other callers do not see it in listings or events,
  and claim or complete it as not found. When the job ends (its runtime's report, a cancel, a
  stop, an expiry sweep, a deleted space) or is steered, its open requests are canceled in the
  same transaction. Those a steer canceled carry `cancelReason` `steered`: a person's words went
  into the job, which goes on. A steered call answers once the runtime took the new words, at
  most 3 s later. A claim of a request whose job has ended cancels the job's open requests
  instead.
- A device may have an owner. A heartbeat (`POST /projects/:id/provider-devices/heartbeat`) with
  `owned: true` from a person's own session makes the device theirs, if it is nobody else's. An
  owned device answers only to its owner: only their session heartbeats it, lists its requests
  (`deviceId`) or claims and completes requests as it, and it takes only their requests. Ownership
  ends only when the owner may no longer write to the space (they left it, lost write access or
  deleted their account): then anyone in the space may use the device under the space's rules, or
  take it. A heartbeat may also carry the device's tool `catalog` in MCP `tools/list` shape with
  its `initialize` instructions (at most 64 tools with distinct names, each input schema a JSON
  Schema object, 64 KiB in all); one without keeps the stored catalog. Only a person device grants
  are on for (`DEVICE_GRANTS_ENABLED`, below) takes a device or publishes a catalog. With the flag
  off both are ignored, and no device has an owner to answer to.
- In the app, `controllerClient.providerRequests.subscribe` streams a space's
  `provider.request.created` and `.updated` events on one `/events` stream, with the stream's
  usual reconnect and refusal backoff. It also asks for `events.resync` and hands it on as
  `onResync`, so a device reads its requests again after the stream dropped events.

## Agent Job Trigger

Each agent job records what started it, from the caller's own credential and never from a request
body: whose cause it was and when the controller received it, on the database clock
(`agent_jobs.trigger_user_id`, `trigger_received_at`).

- The message routes count a send as its person's (`person`) only when their own signed-in
  session says `metadata.input: {"kind": "typed"}`, and as speech one of their devices heard
  (`device_voice`) for `{"kind": "voice", "deviceId": ...}`. A resend (`retryOfMessageId`) or a
  goal's next turn (`goalContinuation`) is a `resend`. A job token's, the service role's, an
  automation's and an agent plan's sends are `automatic`. A send that says nothing has no trigger.
- Web chat's composer sends `{"kind": "typed"}`. What the app sends on the person's behalf, an
  automatic retry or its local fallback queue's drain, says nothing.
- A queued message is received when it was queued; Send now, when it is pressed.
- Where device grants are on for its sender, a user message also keeps the kind as
  `metadata.trigger`, over any value a client wrote; anywhere else it keeps no such key. Device
  grants are off unless `DEVICE_GRANTS_ENABLED` is on, and then on for every user under
  `DEV_MODE` and otherwise only for `DEVICE_GRANTS_USER_IDS`.

## Agent Job Delivery

Controller code may give any job delivery options, never a request body; a job without them is
delivered as before (`agent_jobs.at_most_once`, `start_by`, `strict_pin`).

- `at_most_once`: the lease hands the job out once, never again after that lease ends (a runtime
  stop or a lapsed lease), and the runtime neither replays nor retries its turn: one that ends
  without its answer fails, saying it was not run again. A short rate limit does not requeue it.
- `start_by`: no lease after this time, a set time after its trigger was received.
- `strict_pin`: only its target runtime leases it, even under a spread plan's rules; a runtime
  stop and an unready runtime's dispatch alert leave it pinned, as they do a browser turn.

The lease tells the runtime only `at_most_once`, as `payload.delivery.atMostOnce`; the controller
alone enforces `start_by` and `strict_pin`. The idle poll's one-read check counts no job they keep
from the polling runtime. The idle sweep fails a queued job that can no longer start
(`run_once_interrupted`, `start_by_passed`), tells its conversation why and cancels its open
provider requests.

## Canonical Workspace Modes
There are two supported canonical filesystem modes:

- **Local-canonical (BYO folder)**: a user-provided folder is the source of truth (desktop/self-host). The Origin runs next to it.
- **Git-canonical** (hosted): an Instafy-hosted git repo is the source of truth; runtimes and Desktop origins keep working copies and publish changes by commit + push, and the hosted workspace gateway serves from disposable bare mirrors and makes each save one commit on `main`.

We do **not** treat “shared-folder canonical” as a first-class product mode. A shared filesystem (EFS/NFS) can still exist inside hosted infrastructure, but only as private implementation plumbing for origins/runtimes. It should not be the user-facing source-of-truth model.

This does **not** require a dedicated public file server. Private storage stays inside the compute network; clients reach files through the Origin HTTP API (direct/reverse-proxy or a tunnel).

### Git-canonical Notes
- Files are at rest in the git service as bare repos; checkouts on runtime and Desktop nodes are working copies, and the hosted gateway keeps only disposable bare mirrors.
- The git service is intended to be load-balancable: `git-edge` (stateless) routes to `git-shard-*` (stateful repo storage). See `docs/Git-Service.md`.
- Studio and agents still use the Origin filesystem API; git is an implementation detail for persistence + reconciliation.
- Concurrency follows git semantics: allow concurrent branches, protect `main` (fast-forward only; no force pushes), and let runtimes merge + retry when pushes are rejected. The hosted gateway rebuilds a save on the new `main` and retries.
- Single-tenant origins (Desktop, workspace runtimes) and the hosted gateway serve the same saved-version routes (`/git/history`, `/git/history/review`, `POST /git/revert-commit`) and unsaved-work routes (`GET /git/recovery`, `POST /git/recovery/restore`, `POST /git/recovery/dismiss`), and decide a restore with the same code (`packages/origin-http-server/src/restore_plan.rs`). Studio's History uses them on both (see [History in Studio](Git-Service.md#history-in-studio)).

### Choosing A Mode
- Use **local-canonical** when one person's laptop or workstation should be the source of truth.
- Use **git-canonical** for hosted or shared collaboration, including self-hosted deployments.
- Avoid inventing a third "shared mount as truth" story when one of the two modes above already fits.

## Event Streaming
- Studio subscribes to controller SSE at `/events` for run updates. Browser clients use an
  authenticated `fetch` stream and send bearer credentials in the `Authorization` header; access
  tokens must never be placed in the event-stream URL. The client requires the SSE media type and
  bounds individual lines and accumulated event data before parsing JSON.
- Each Studio tab, Desktop window and phone holds one stream. A controller node allows one user
  eight at once and refuses another, before reading the database, with 429, the code
  `too_many_event_streams` and `Retry-After`. The client waits that long, doubles the wait on each
  refusal in a row up to a minute, and adds a little jitter, so an extra tab asks about once a
  minute instead of every few seconds. Opening a stream resets the wait.
- The limit is checked right after the token, before the request's space, filters and access, so
  a user at the limit gets 429 even for a stream that would otherwise be refused with 400, 403 or
  404; that answer comes once a stream is free. A refused tab keeps the controller shown as
  available: only its live updates wait, and it fetches its runs again when its stream opens.
- Streams do not share access checks. Each stream checks access for an event it matches, at most
  once per conversation every 5 s and on every runtime, origin, tunnel, workspace or roster event,
  so one user's eight streams on one space can ask for eight database connections for one event.
  That is more than the default pool of 4 (`DATABASE_POOL_SIZE`): the extra checks wait for a
  connection, and other requests on the node wait behind them.
- Supabase is a fallback when the controller is disabled.

## Conversation delivery intents

Prompt dispatch uses an existing, authorized project. Interactive clients create
projects through authenticated `POST /orgs/:org_id/projects` before calling
`/dispatch-prompt`.
Only controller/service-role requests can bootstrap a missing project during
dispatch; an anonymous caller's fresh project/session UUIDs cannot create a
project, organization, subscription, credit grant, or agent job. Existing
provisioned sandbox sessions retain their session-bound write access. The
controller checks project write access before initializing organization, billing,
or credit state.

The controller is authoritative for explicit composer delivery intent:

- A **queue** intent resolves the target agent lane on the server, persists an idempotent entry,
  and attempts a drain immediately. Busy lanes retain FIFO ordering; an idle lane must not leave
  the entry stranded.
- A **steer** intent is bound to one expected active job. The controller persists an ordered job
  input and the owning runtime acknowledges it only after submitting the input to that same active
  model turn. Steering never aliases to conversation-wide cancellation. Only the person whose
  prompt started a Shared or Personal Browser turn may steer it; see
  [Shared-Browser-Authorization.md](Shared-Browser-Authorization.md#steering-an-active-browser-turn).
- A **stash** is owner-private draft state. It is not conversation history and cannot enter the
  job or send-queue state machines. Per-owner/conversation row and serialized-byte quotas bound
  both storage and list responses.

Client-generated send and stash IDs make retries idempotent. Target lane identity, active-job
checks, queue ownership, and stash ownership are controller decisions; browser-supplied handles
are hints rather than authority. Provider-specific active-turn mechanics stay behind runtime
capabilities.

Editing a pending queue item cancels its delivery while the composer is open. Save and Cancel
restore that same row through
`POST /conversations/:conversationId/send-queue/:entryId/restore`, preserving its ID, creation
time and queue position. The request carries the prompt `message`, canonical
`targetAgentHandles`, `status` (`queued` or `failed`), and the exact `expectedUpdatedAt` string
returned by cancellation. The controller rechecks write access and ownership, serializes
restoration with reorder/drain, and rejects a stale cancellation version. Matching retries
acknowledge already-restored or dispatched work without reviving it. Cancel preserves a failed
entry's failed status. Studio leaves an unsuccessful restoration available for retry; it does
not create a second local fallback entry. Older controllers without queue-entry `updatedAt`
remain usable for sending, removing and reordering, but Studio blocks Edit before cancellation.

## Runtime Providers
- Docker provider is the default for local dev.
- Desktop runtime agents can run outside Docker (use `PROXY_BASE_URL=http://127.0.0.1:8789`).
- Hetzner allocator exists but VM bootstrap is incomplete; treat as experimental.

## Local Device Access
- Hardware access should be brokered by the shared local runtime/provider layer, not by the browser UI.
- `@instafy/sdk/hardware-provider` defines the first shared host-hardware contract for serial access (`hardware.serial`).
- `instafy hardware serial list` and `instafy hardware serial probe --device <path>` are the initial headless surface for USB/serial visibility and permission checks.
- Runtime-native IO is lazy and on-demand. Project-specific hardware observations belong in compact agent context cards, not in a runtime-wide inventory, skill file, or `.instafy/host-actions.json`; relevant cards can be injected into runtime prompts as soft hints.
- Project-scoped local hardware bindings are stored in `.instafy/hardware-bindings.json`, keyed by hardware provider id. This record is intentionally separate from `.instafy/provider-bindings.json`, which only grants provider access to project content.
- `instafy hardware bindings grant/show/revoke` is the CLI/headless approval path. Studio shows local devices inside the same project settings access card as provider file access, while reading and writing the separate hardware binding record.
- Desktop should layer richer approval UX over the same provider contract. Headless environments should grant/configure the same capability through CLI or project policy.
- Docker runtimes only see serial devices that are explicitly mapped into the container. macOS BLE/CoreBluetooth should use a host-native bridge because permissions are tied to the signed app/helper identity.

### Runtime agent images (flavors)

Runtimes can be provisioned with different runtime-agent container images (for example a small “base” image vs a heavier “webdev” image that includes Node/Playwright).

- For the exact canonical managed `instafy-cloud` provider, callers select only
  `metadata.runtimeFlavor: "webdev"`. The controller strips direct image and
  capability environment overrides and fail-closes request metadata/environment
  to an explicit product allowlist. Docker, Compose, BuildKit, process path,
  proxy, build-target, and force-build variables cannot cross the public or
  allocator boundary. The controller binds a protected launch attestation to
  the new lease generation, and the provider maps that attested flavor to its
  configured `RUNTIME_AGENT_WEBDEV_IMAGE`. Production deploys configure the
  registry-verified `repo@sha256:<manifest digest>` reference. The human-readable
  `webdev-<full commit SHA>` tag is informational and is never used as launch
  provenance because registry tags remain mutable.
- An active managed lease cannot change flavor in place; stop it and create a
  new provider generation. Runtime registration cannot spoof the protected
  `_instafySharedBrowserAgentConsent` capability. A space's own machine gets it,
  with a controller-written `browserHost` for its lease generation, only when it
  reports the lazy browser host and its lease carries the controller's
  browser-host attestation; `HOSTED_BROWSER_HOST` also gates its status field,
  its `browser/host*` proxy routes and Shared dispatch to it.
- A dispatch reconnect to a runtime that holds a live lease keeps that lease's
  settings: it asks for the lease's attested flavor, size and browser
  settings, so it reuses a live webdev runtime (or replaces a stale one with
  the same image) instead of being refused. If another start has replaced
  that lease by the time the reconnect reuses the runtime, the new lease keeps
  its own settings. A runtime with no live lease, such as one stopped for
  idling, relaunches at the standard size. It keeps the webdev image and its
  Shared Browser settings only when the launch attestation of its newest own
  launch proves a webdev launch; a stored or client-supplied `runtimeFlavor`
  does not count, and neither does a tenant lease another project attached,
  which launched nothing. The settings carried are the env keys a client may request itself
  (the browser session switch and viewer preferences such as the CDP
  screencast), which pass the request boundary again; resource limits and
  TURN credentials are injected fresh. Otherwise it relaunches with the base
  image. Its size, and so its Boost billing, is not carried. A requeue
  relaunch copies the metadata of the runtime's live lease or, without one,
  of its newest own launch; a tenant lease is never read.
- Custom and self-hosted providers retain their explicit metadata/image behavior.
- Hetzner user-data templates may include `{{RUNTIME_AGENT_IMAGE}}`; when present, the allocator will substitute `metadata.runtimeAgentImage` (or `runtime_agent_image`) into the cloud-init payload.
- Hetzner templates can also consume dynamic runtime env data via `{{RUNTIME_ENV_FLAGS}}` (shell `-e KEY='value'` segment) or `{{RUNTIME_ENV_EXPORTS}}` (`export KEY='value'` lines). This includes controller lease/origin env plus `metadata.env` overrides such as `INSTAFY_ENABLE_BROWSER_SESSION=1`.

## AI Proxy
All automation must route through the proxy. Do not call OpenAI/Anthropic directly.

Required envs:
- `PROXY_BASE_URL`
- `PROXY_SIGNING_SECRET`
- `DEV_PROVIDER_AUTH_TOKEN` (local provider health/runtime endpoints)
