# Runtime Controller Guide

This document explains how the Instafy runtime controller is structured and how to work with it while we migrate to a conversational, workspace-first workflow.

## Purpose
- Orchestrate conversations, runs, and artifacts against a per-project workspace on disk (either a local-canonical folder or a hosted materialized checkout).
- Act as the single entrypoint for Studio, runtime agents, and automation harnesses.
- Broadcast status and results via server-sent events so the UI stays in sync.
- Expose optional modules (GitHub builds, hosting, etc.) without hardcoding any single deployment path.

## Core Responsibilities
- **Workspace management**: every project lives under `<WORKSPACE_ROOT>/<project_id>`. `WORKSPACE_ROOT` is the controller/runtime root; each project gets its own child directory. File mutations are applied by a project origin (`/apply` via origin). The controller may expose read-only helpers for compatibility, but clients should prefer origin endpoints for listing/reading (`/entries`, `/files`, `/raw`). When multiple actors can touch the same workspace tree, run a watcher that emits `workspace.file_changed` events through `/events` so connected clients re-read files immediately after a save.
- **Conversation + run lifecycle**: `/dispatch-prompt` inserts conversations/runs, enqueues jobs, and tracks results in Postgres.
- **Runtime coordination**: `/runtime/register`, `/runtime/ensure`, and `/agent/*` coordinate agents that execute jobs (Codex, WebContainer driver, etc.).
- **Origin management**: every runtime launch upserts an `origin_instances` row, injects the origin env block for allocators, and tracks presence/endpoint updates from `POST /origin/register` + `POST /projects/:id/origin/presence/beat`.
- **Event streaming**: `/events` emits `ControllerEvent` payloads (run queued/progress/completed, preview updates, job output) scoped to project, session, or conversation channels.
- **Credits & policy enforcement**: `/credits` forwards ledger calls to Supabase and enforces sandbox credit seeds.
- **Conversation hydration**: leased jobs now include the latest conversation messages and agents should persist assistant replies back to the conversation via `/agent/complete`.
- **Apply vs respond**: when an agent finishes without changing files, the controller marks the run as `success` immediately so question/answer flows complete without a review gate.

## Concept Map
- **Project**: primary record keyed by UUID; links to Supabase orgs and the workspace directory.
- **Workspace**: files and artifacts under `<WORKSPACE_ROOT>/<project_id>`; controller guards path traversal before touching disk.
- **Conversation**: ordered sequence of prompts/messages for a project; runs reference a conversation when applicable.
- **Run**: a single automation attempt (prompt generation, deploy, module apply). Runs emit SSE and persist structured results retrievable at `/runs/:id/result`.
- **Runtime**: an execution environment (Codex agent, WebContainer, desktop driver). Agents authenticate via `/agent/login` and renew work with leases/heartbeats.
- **Events**: JSON payloads with shape `{ kind, project_id, session_id, conversation_id, run_id, job_id, data, timestamp }`. Channels include `session:<uuid>` and `conversation:<uuid>`.

## Typical Flow (Prompt/Deploy)
1. Studio raises a prompt such as "deploy this to a domain" and calls `/dispatch-prompt`.
2. Controller validates credits, ensures a runtime (`/runtime/ensure`), and enqueues a job for the agent.
3. Agent streams progress via `controller.events` and reports artifacts (files, logs) back to the workspace.
4. When finished, the controller writes the run result (preview URL, deployment metadata, etc.) and broadcasts `run.completed`.
5. UI fetches `/runs/:id/result` if it needs the final payload.

## Optional Integration Modules
- **Hosting & domains**: deploy prompts should create/update `preview_deployments` records and persist assigned domains inside the workspace.
- **Analytics/telemetry**: emit structured events (`kind: "deploy.telemetry"`, etc.) instead of embedding provider-specific logic in the controller core.

## HTTP Surface (selected)
| Method | Route | Notes |
| --- | --- | --- |
| POST | `/dispatch-prompt` | Main entrypoint for conversations and module runs on an authorized existing project. Only service-role callers may bootstrap a missing project. Returns `{ runId, promptId, ... }`. |
| POST | `/progress-callback` | Receives build/job progress (ephemeral JWT). Broadcasts progress events and updates runs. |
| GET | `/events` | SSE stream; filters by `projectId`, `sessionId`, `conversationId`, `runId`, or `kinds`. |
| GET | `/runs` | List runs for a project/session. |
| GET | `/runs/:run_id/result` | Fetch stored result JSON (fallback if SSE missed). |
| POST | `/runtime/ensure` | Guarantee a runtime record exists (creates idle agents when missing). |
| POST | `/agent/login` | Exchange shared key for agent token, lease/heartbeat URLs, and proxy envelope. |
| POST | `/agent/lease` | Claim work with a signed runtime ID bound to an eligible registered runtime and its current generation, including when `STRICT_MODE=false`. |
| POST | `/agent/secrets` | Resolve granted secrets only for the signed runtime's exact active, unexpired job lease and current runtime generation, including when `STRICT_MODE=false`. |
| POST | `/credits` | Apply authenticated credit-ledger operations through the controller. |
| POST | `/projects/:id/git/access_token` | Mint project Git tokens. `git.delete` is a 60-second, service-auth-only, single-scope cleanup capability. |
|  |  | Controller no longer serves `/fs/*`; clients should use project origin endpoints (`/entries`, `/files`, `/raw`). |
| POST | `/projects/:id/origin/presence/beat` | Project-scoped presence updates from an origin. |

Refer to `src/main.rs` for the complete list, including agent callbacks and admin endpoints (`/runtime/stop`, `/runtime/idle-reaper`).

### Bug report submission limits

Customer submissions to `/support/reports` and `/bug-reports` share a per-user
ten-second cooldown. Reports spaced at least ten seconds apart are accepted without
a daily count limit. A database advisory lock and the database clock enforce this
spacing across controller instances; an early retry receives HTTP 429 with the
remaining wait rounded up to whole seconds.

Invalid or repeated attempts remain bounded separately: `/support/reports` accepts
at most five attempts per ten seconds, authenticated before buffering its larger
body, and `/bug-reports` accepts at most thirty attempts per ten seconds. Existing
authentication, project access, payload and screenshot limits still apply. These
limits do not expand service-role or operator access.

## Configuration
Key environment variables (see `AppConfig::from_env` for defaults):
- `DATABASE_URL` — Postgres connection for controller state (required).
- `DATABASE_POOL_SIZE` — max Postgres connection pool size (defaults to `4`). Keep this low when using the Supabase session pooler.
- `SUPABASE_PROJECT_URL` — base URL for the Supabase project; we derive the JWKS endpoint from this unless `SUPABASE_JWKS_URL` is provided.
- Tunnels:
  - `TUNNEL_BROKER_BASE_URL`, `TUNNEL_BROKER_TOKEN` — self-hosted tunnel broker (Hetzner/PDNS). When `TUNNEL_BROKER_HOOK_SECRET` is set, credits are burned via the broker ACL hook and the controller skips the pre-burn for self-hosted tunnels.
  - `TUNNEL_BROKER_HOOK_SECRET` — shared bearer secret for broker callbacks (`/tunnel-broker/hooks/acl` and `/tunnel-broker/hooks/events`).
- `SUPABASE_JWKS_URL` — optional override for JWKS discovery (defaults to `<SUPABASE_PROJECT_URL>/auth/v1/.well-known/jwks.json`).
- `SUPABASE_JWKS_REFRESH_SECONDS` — interval for refreshing the JWKS cache (defaults to 300 seconds; minimum 30).
- `CONTROLLER_INTERNAL_TOKEN` — internal bearer token required for privileged automation.
- `AGENT_LOGIN_KEY` — shared secret agents use to mint scoped tokens via `/agent/login`.
- `WORKSPACE_ROOT` — runtime/controller root directory containing per-project workspaces. In local-canonical desktop mode, the source-of-truth folder can live outside this hosted layout. In git-canonical hosted mode, this root holds the materialized working copies.
- `PROXY_BASE_URL`/`PROXY_SIGNING_SECRET` — optional AI proxy envelope support.
- `MANAGED_AI_ENABLED` — enables the platform-managed AI lane when the proxy is available with static credentials.
- `MANAGED_AI_MODEL_ID` — upstream model id used for managed AI turns (defaults to `gpt-5.6-sol`).
- `MANAGED_AI_STARTUP_CHECK` — when `true`, controller boot fails unless `PROXY_BASE_URL/healthz` reports `requiresCredential=false` (that is, the proxy has static credentials such as `OPENAI_API_KEY` or `auth.json`). Defaults to on outside `DEV_MODE`.
- Shared Browser managed TURN (optional; unset the TURN values to disable):
  - `CONTROLLER_BROWSER_TURN_URLS` — comma-separated `turn:`/`turns:` URLs advertised to WebRTC clients (maximum 4; credentials must not be embedded in a URL).
  - `CONTROLLER_BROWSER_TURN_SHARED_SECRET` — coturn REST `static-auth-secret` (32–4096 bytes). Keep this controller-only and store it as an orchestration secret.
  - `CONTROLLER_BROWSER_TURN_CREDENTIAL_TTL_SECONDS` — derived credential lifetime, default `3600`, allowed range `300`–`86400` seconds. The URLs and shared secret are required together; setting only the TTL is invalid.
  - `CONTROLLER_BROWSER_WEBRTC_PROJECT_IDS` — comma/whitespace-separated project UUID allowlist (maximum 256). Empty/unset allows no hosted WebRTC projects; `*` is the deliberate all-project rollout value.

  The controller validates that browser grants target the selected project's online runtime origin. It derives an expiring HMAC-SHA1 coturn credential bound to that project/runtime on every proxied capabilities and offer request, while the allocator's initial metadata remains only a boot-time safety configuration. Managed sessions overwrite provider ICE data, require authenticated TURN, and negotiate relay-only ICE in both Studio and the runtime sender. The shared secret is redacted from controller debug output and is never sent to the provider, runtime, origin, or Studio.
- `PROGRESS_CALLBACK_SECRET` — HMAC for verifying GitHub/webhook callbacks.
- `SANDBOX_CREDIT_SEED_AMOUNT` & `SANDBOX_CREDIT_SEED_LIMIT` — initial credit grants for new sandboxes.
- `GITHUB_DEFAULT_*` variables — legacy defaults for `/build/dispatch`; omit when running without GitHub integration.
- `RUNTIME_SIGNING_PRIVATE_KEY` / `RUNTIME_SIGNING_PUBLIC_KEY` / `RUNTIME_SIGNING_KEY_ID` — env names for the Ed25519 key pair + optional kid used to sign controller-issued origin and runtime agent tokens.
  - If your orchestration layer can’t pass multiline PEM values (e.g., `--env-file`), use `RUNTIME_SIGNING_PRIVATE_KEY_B64` / `RUNTIME_SIGNING_PUBLIC_KEY_B64` (base64-encoded PEM).
  - Set `RUNTIME_SIGNING_TOKEN_TTL_SECONDS` to control token lifetime (seconds).
- `ORIGIN_INTERNAL_TOKEN` — reused as the bearer credential desktop agents/origins send when registering themselves via `POST /origin/register`.
- Operator access (all unset by default; the service-role bearer always qualifies):
  - `OPERATOR_CONSOLE_ORG_ID` / `OPERATOR_CONSOLE_ALLOWED_USER_IDS` — owners/admins of that organization, or the comma-separated user UUIDs, pass every operator gate (OTA, desktop updates, telemetry, edge downloads, `/operator/*`, bug-report triage).
  - `BUG_REPORTS_OPERATOR_USER_IDS` — comma-separated user UUIDs granted the operator projection and `PATCH` triage on `/bug-reports` only; the list grants nothing on any other operator route.
- Push notifications:
  - `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY` / `WEB_PUSH_VAPID_SUBJECT` — enable PWA Web Push (service-worker based) notifications.
  - `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY` (or `APNS_PRIVATE_KEY_B64`) / `APNS_USE_SANDBOX` — enable native iOS push via APNs.
  - Tip: generate VAPID keys via `npx web-push generate-vapid-keys` (outputs base64url `publicKey`/`privateKey`).

Additional fields include Redis settings for cross-controller `/events` fanout (`REDIS_URL`, optional `REDIS_NAMESPACE`, optional `REDIS_EVENTS_CHANNEL`), agent token TTLs, and GitHub workflow metadata. Keep environment-specific values in your orchestration layer (e.g., AWS ECS task definitions).

## Local Development

### Startup service identity

`SERVICE_RUNTIME_USER_ID` optionally supplies the controller's service-runtime
user UUID (plain or base64-encoded). When it is absent and a server-side
`SUPABASE_SERVICE_ROLE_KEY` is available, startup looks up or creates the service
user through the Supabase admin API. `SERVICE_RUNTIME_USER_EMAIL` selects that
identity (default `service-runtime@instafy.dev`); `SERVICE_RUNTIME_USER_PASSWORD`
optionally supplies the password used only when creating it.

Configuration loading performs blocking HTTP calls, so async startup runs it on
a blocking worker before initializing the database pool. An explicit service
UUID skips admin bootstrap. Without an admin key, or if bootstrap fails, the
existing database lookup fallback remains available. Service-role keys and the
service user's password stay controller-side; they are not browser settings.

The startup regression suite launches the real controller with a cleared
environment and an inert loopback Auth server. It needs neither Docker nor a
database and never uses an existing Supabase account:

```bash
cargo test --locked --manifest-path packages/runtime-controller/Cargo.toml --test startup
```

### Running the controller

1. Ensure Postgres + Supabase stack are running locally with the expected schema (see `packages/runtime-controller/migrations/`).
2. Set the required env vars (at minimum `DATABASE_URL`, `SUPABASE_PROJECT_URL`, `CONTROLLER_INTERNAL_TOKEN`, `WORKSPACE_ROOT`, and an Ed25519 keypair via `RUNTIME_SIGNING_PRIVATE_KEY` / `RUNTIME_SIGNING_PUBLIC_KEY`).
3. Use the provided scripts: `pnpm controller:up` to boot Supabase + the controller, and the matching `*:down` command when finished. Avoid backgrounding the controller manually; orphaned listeners block Playwright.
4. Run `cargo test` inside `packages/runtime-controller` for unit coverage.
5. Trigger flows from the Studio or harness to observe `/events` and verify run output.

Controller user/session and service-role credentials must be sent as
`Authorization: Bearer <token>`. Standard controller API endpoints do not authenticate those
credentials from query parameters or JSON request bodies. Scoped tokens accepted by these APIs
use the same header; endpoint-specific origin capability transports remain documented separately.
The runtime-token endpoint accepts only the controller's built-in runtime-machine scopes:
`agent.lease`, `agent.heartbeat`, `agent.message`, `agent.complete`, `agent.stop`,
`origin.register`, `origin.presence`, `origin.apply`, `git.read`, `git.write`,
`telemetry.write`, `git.token.mint`, `workspace.lease.read`, and `personal_browser.control`.
Omitting `scopes` issues the standard bundle; empty or unknown scope sets are rejected, and
`personal_browser.control` requires the explicit `personalBrowser: true` request flag.
`ttlSeconds` must be between 60 and 3600 seconds inclusive; omitting it or sending `null`
uses 3600 seconds, independently of the origin-token TTL configuration.

Ordinary callers must create projects through authenticated `POST /orgs/:org_id/projects`
before dispatch.
Dispatch checks existing project permissions before initializing organization, subscription,
or credit records. An already provisioned sandbox retains its session-based access policy.

`pnpm controller:up` inherits the current shell environment. For a local TURN test, export the
three `CONTROLLER_BROWSER_TURN_*` values before starting it; do not put the coturn shared secret
in `$INSTAFY_ENV_DIR/docker/.env.local`, which configures runtime containers rather than the
controller.

## Contribution Guidelines
- Keep new features conversational: expose them as prompt-driven runs that operate on the workspace, then surface metadata via `/events` and `/runs/:id/result`.
- Avoid introducing provider-specific logic into controller routes; instead, persist module configuration (GitHub repo, hosting provider, domain) inside the workspace so agents can reuse it.
- When deprecating legacy endpoints (e.g., `/build/dispatch`), update documentation and TODO items to reflect the new flow before removing code.
- Attach structured logs with `request_id`, `project_id`, and `run_id` when adding new instrumentation so downstream tooling can correlate events.

For deeper integration notes (runtime providers, WebContainers, billing), see `docs/Architecture.md`.
