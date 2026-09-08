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

## Canonical Workspace Modes
There are two supported canonical filesystem modes:

- **Local-canonical (BYO folder)**: a user-provided folder is the source of truth (desktop/self-host). The Origin runs next to it.
- **Git-canonical** (hosted): an Instafy-hosted git repo is the source of truth; origins/runtimes materialize checkouts as needed and persist changes by commit + push.

We do **not** treat “shared-folder canonical” as a first-class product mode. A shared filesystem (EFS/NFS) can still exist inside hosted infrastructure, but only as private implementation plumbing for origins/runtimes. It should not be the user-facing source-of-truth model.

This does **not** require a dedicated public file server. Private storage stays inside the compute network; clients reach files through the Origin HTTP API (direct/reverse-proxy or a tunnel).

### Git-canonical Notes
- Files are at rest in the git service as bare repos; checkouts on origin/runtime nodes are cache/working copies.
- The git service is intended to be load-balancable: `git-edge` (stateless) routes to `git-shard-*` (stateful repo storage). See `docs/Git-Service.md`.
- Studio and agents still use the Origin filesystem API; git is an implementation detail for persistence + reconciliation.
- Concurrency follows git semantics: allow concurrent branches, protect `main` (fast-forward only; no force pushes), and let runtimes rebase/merge + retry when pushes are rejected.

### Choosing A Mode
- Use **local-canonical** when one person's laptop or workstation should be the source of truth.
- Use **git-canonical** for hosted or shared collaboration, including self-hosted deployments.
- Avoid inventing a third "shared mount as truth" story when one of the two modes above already fits.

## Event Streaming
- Studio subscribes to controller SSE at `/events` for run updates. Browser clients use an
  authenticated `fetch` stream and send bearer credentials in the `Authorization` header; access
  tokens must never be placed in the event-stream URL. The client requires the SSE media type and
  bounds individual lines and accumulated event data before parsing JSON.
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
  model turn. Steering never aliases to conversation-wide cancellation.
- A **stash** is owner-private draft state. It is not conversation history and cannot enter the
  job or send-queue state machines. Per-owner/conversation row and serialized-byte quotas bound
  both storage and list responses.

Client-generated send and stash IDs make retries idempotent. Target lane identity, active-job
checks, queue ownership, and stash ownership are controller decisions; browser-supplied handles
are hints rather than authority. Provider-specific active-turn mechanics stay behind runtime
capabilities.

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
  `_instafySharedBrowserAgentConsent` capability.
- Custom and self-hosted providers retain their explicit metadata/image behavior.
- Hetzner user-data templates may include `{{RUNTIME_AGENT_IMAGE}}`; when present, the allocator will substitute `metadata.runtimeAgentImage` (or `runtime_agent_image`) into the cloud-init payload.
- Hetzner templates can also consume dynamic runtime env data via `{{RUNTIME_ENV_FLAGS}}` (shell `-e KEY='value'` segment) or `{{RUNTIME_ENV_EXPORTS}}` (`export KEY='value'` lines). This includes controller lease/origin env plus `metadata.env` overrides such as `INSTAFY_ENABLE_BROWSER_SESSION=1`.

## AI Proxy
All automation must route through the proxy. Do not call OpenAI/Anthropic directly.

Required envs:
- `PROXY_BASE_URL`
- `PROXY_SIGNING_SECRET`
- `DEV_PROVIDER_AUTH_TOKEN` (local provider health/runtime endpoints)
