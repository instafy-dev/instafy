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
| POST | `/projects/:id/conversations/blank` | Creates a conversation. Private chats accept `initialParticipantUserIds` and return the IDs committed atomically with the conversation. |
| POST | `/conversations/:id/messages/record` | Records a user or assistant message; human metadata may include canonical `mentionedUserIds`. |
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
| GET | `/operator/credential-encryption/census` | Service-role only. Read-only count of stored secrets per table by the key that opens them. See [Rotating the credential encryption key](#rotating-the-credential-encryption-key). |
| POST | `/operator/credential-encryption/reencrypt` | Service-role only. Rewrites stored secrets still under a previous key with the primary key. |

Refer to `src/main.rs` for the complete list, including agent callbacks and admin endpoints (`/runtime/stop`, `/runtime/idle-reaper`).

### Invalidation signals on `/events`

Some changes are announced as bare signals so open clients refetch instead of polling. Each is
published only after the change's transaction commits, once per affected project stream, with a
payload of `{ "reason": ... }` and nothing else. Project viewers can include guests without org
or billing access, so a signal must never carry data a viewer could not fetch.

| Kind | Payload | Published for | Delivered to | Clients refetch |
| --- | --- | --- | --- | --- |
| `project.members_changed` | `{ "reason": "project_membership" }` | the project | every viewer of the project | `/projects/:id/members` |
| `project.members_changed` | `{ "reason": "org_membership" }` | every live project of the org | org members only; project guests' streams drop it | `/orgs/:id/members` |
| `credits.updated` | `{ "reason": "ledger" }` or `{ "reason": "subscription" }` | every live project of the org | every viewer of the project | `/credits/status`, `/credits/ledger` |

Delivery rechecks access per event, so a busy org's signals cost database work on every stream
that receives them. `credits.updated` is therefore spaced per org: each controller node publishes
it at most once every 2 seconds, and a change inside that interval is announced by one trailing
publish when it ends. Sweeps publish once per org per pass. A node's broadcast carries signals
only for projects one of its streams watches; the Redis bus still carries every project to the
other nodes. The Studio also folds signals into one refresh about 1.2 seconds after the first
and fetches nothing while its tab is hidden, catching up once it is visible.

`project.access_changed` is different: it targets the affected user only, so their open clients
refetch their own capabilities.

### Conversation recipients

Private creation accepts at most 32 UUID `initialParticipantUserIds`. Each target must already
have project access; the request fails atomically with HTTP 403 otherwise. Initial participants
require a private conversation and cannot be added with a scoped job credential. The successful
response includes the normalized committed IDs, allowing clients to fail closed against older
controllers that ignore this additive request field. Adding a participant later applies the same
project-access requirement and never grants project membership.

User-message metadata accepts at most 32 UUID `mentionedUserIds`, derived from selected human
mention identities rather than display text. Record-only and prompt-dispatch paths validate and
deduplicate the list; malformed metadata returns HTTP 400. The transactional notification producer
unions these IDs with the creator and participants, excludes the sender, and filters by current
conversation access. A private nonparticipant or a user without project access receives nothing.
See [Notifications](../../docs/Notifications.md) for preferences, visible automation replies,
recipient read state, and rollout requirements.

### Bug report submission limits

Customer submissions to `/support/reports` and `/bug-reports` share a per-user
ten-second cooldown and a durable rolling limit of 25 accepted reports per 24 hours.
A database advisory lock, indexed database count, and the database clock enforce both
limits across controller instances; an early retry receives HTTP 429 with the remaining
wait rounded up to whole seconds. Customer follow-ups have a separate durable limit of
250 accepted messages per account per 24 hours. Exact idempotent message replays do not
consume the allowance. Service and verified operator submissions are exempt.
Customer report creation accepts an optional UUID `clientRequestId`. Under the same
per-account database lock, an exact normalized retry returns the original report with HTTP 200;
reuse for different normalized/redacted content or attachments returns HTTP 409. The key and
request digest are private database fields and never appear in report DTOs.
Studio also sends `expectedUserId`; when present, the controller requires it to match the
authenticated account before validating diagnostics or persisting the report. This prevents a
draft captured under one account from being submitted under another account after a session
change.
Studio likewise sends `expected_user_id` on customer report-list requests. An account mismatch
returns HTTP 409 before any summaries are selected, preventing an in-flight read prepared under
one account from rendering another account's support inbox. The parameter remains optional for
backward-compatible CLI clients.
Customer PNG, JPEG, and WebP screenshots must have readable matching headers, dimensions no
larger than 8,192 pixels per side, and no more than 25 million pixels. Their accepted attachment
bytes share a database-serialized 32 MiB per-account rolling 24-hour limit. Exact report replays
are resolved before this quota and therefore do not consume or re-check it. Screenshot file names
also reject bidi and non-text control characters before they can reach an operator timeline.

Invalid or repeated attempts remain bounded separately: `/support/reports` accepts
at most five attempts per ten seconds, authenticated before buffering its larger
body, and `/bug-reports` accepts at most thirty attempts per ten seconds. Existing
authentication, project access, payload and screenshot limits still apply. These
limits do not expand service-role or operator access.

Initial customer `message` and `details` text rejects the same bidi and non-text control
characters as follow-up messages; ordinary newlines and tabs remain supported.

Customer diagnostics are sanitized again by the controller before persistence. Sensitive
object keys, stringified JSON, header-style values, token/JWT/private-key patterns, and
colon-delimited credentials are redacted. URL/DSN userinfo is removed and query strings and
fragments are stripped. Scanning is bounded per string. This server-side boundary applies even
when a client also provides a diagnostic preview.

### Support report conversations

Each customer report has a controller-projected, customer-visible message ledger:

- `GET /support/reports/:id/messages` lists the authenticated reporter's latest 100 messages.
- `POST /support/reports/:id/messages` adds a reporter follow-up.
- `GET /bug-reports/:id/messages` lists the same safe projection for a bug-report operator.
- `POST /bug-reports/:id/replies` publishes an explicit support reply.
- `POST /bug-reports/:id/messages/reviewed` durably acknowledges the exact customer activity
  snapshot supplied as `{ customerLastMessageAt }`; an exact retry returns HTTP 200 without
  changing its audit actor, while changed or inconsistent activity returns HTTP 409.

Posts accept `{ body, clientRequestId? }`; `clientRequestId` is an optional UUID and makes an
exact retry idempotent. Reusing it for different content or an actor type is a conflict. Bodies
are trimmed and limited to 4,000 Unicode characters and 16 KiB; spoofing bidi and non-text
control characters are rejected. Customer posts are additionally limited to 30 per minute
outside development mode. Operator replies require an interactive operator session and are
rejected if the customer-visible body contains a credential/token/private-key sentinel. They may
include `customerLastMessageAt` to atomically acknowledge exactly the snapshot being answered;
the snapshot must still be unreviewed, so competing replies to the same work item receive HTTP
409. Omitting it leaves the report in the response queue. A follow-up reopens a resolved report, while
the first support reply advances an open report to `in_progress`. These transitions and explicit
operator status changes append customer-visible system timeline entries.
Customer and support authors share a 5,000-message per-thread cap. Lifecycle events have a
separate bounded 1,000-row allowance. Once that allowance is full, authored messages and status
transitions continue without an extra timeline event, so a report can still be reopened or
resolved without allowing unbounded system rows.

Operator summary/detail DTOs include `customerLastReviewedAt` and `needsResponse`; customer DTOs
do not. `GET /bug-reports?needs_response=true` returns unseen customer activity oldest-first.
Stable pagination uses the previous row's paired `after_customer_activity_at` and
`after_customer_activity_id` query values. The cursor is independent of public replies, so an
operator or agent can explicitly mark a report reviewed even when no customer response is needed.
The general operator list is ordered by `createdAt` then report ID, both descending; pass paired
`before_created_at` and `before_created_id` values for deterministic older pages. A legacy
timestamp-only `before_created_at` request remains accepted. List items omit report details,
reporter identifiers, source IDs, metadata, and logs; their summary `message` is capped at 500
characters. The operator detail route retains the complete authorized record.
Resolving a customer report requires `expectedCustomerLastMessageAt` on the operator PATCH; a
missing or stale snapshot returns HTTP 409, and an exact snapshot is marked reviewed atomically
with resolution. This prevents a follow-up arriving during a fix from being silently closed.
Operator PATCH requests may additionally include `expectedUpdatedAt`; when supplied, any
intervening triage update returns HTTP 409 instead of overwriting labels or other fields.
New operator clients use `PATCH /bug-reports/:id/triage`, which requires a nonempty
`expectedUpdatedAt` from the report they inspected. Missing/null or stale versions return HTTP
409. Resolving a customer report also requires the matching `expectedCustomerLastMessageAt`.
The separate route prevents an older controller from silently ignoring concurrency fields:
it returns HTTP 404, and clients must not retry against the legacy PATCH endpoint. The legacy
`PATCH /bug-reports/:id` remains available for existing integrations with its optional version
guard. Deploy the migration and updated controllers before exposing the new operator clients.
The returned `updatedAt` concurrency version is generated by the controller and advances on
every support-thread or triage mutation. A legacy request `updatedAt` value is accepted and
validated for wire compatibility but is no longer used as the stored version. `resolvedAt` is
likewise validated for compatibility but ignored: the controller derives it only from status
transitions. Explicit JSON `null` clears nullable assignee, duplicate, and GitHub-link fields;
omitting one preserves it.

Customer report lists are ordered by newest customer-visible activity. Items expose `activityAt`,
and list responses add `hasMore` plus `nextCursor: { activityAt, id }`. Pass that cursor back as
paired `before_activity_at` and `before_activity_id` query values to fetch older reports. Message
responses likewise add `hasMore` and `nextCursor: { createdAt, id }`; pass paired
`before_created_at` and `before_message_id` to fetch the next older page. Each page remains in
chronological display order, so older pages can be prepended without reordering.
For backward compatibility, customer report-list requests that pass only the legacy
`before_created_at` cursor continue to filter and order by report creation time. When another page
exists, that mode returns `nextCursor: { createdAt, id }` so callers can continue with paired
`before_created_at` and `before_created_id` values without changing ordering modes.

Customer summaries and details include `resolvedAt`, `hasUnreadSupportActivity`, and
`hasUnreadResolution`. The list envelope also includes `unreadCount`, `unreadResolutionCount`, and
`unnotifiedResolutionCount` across all of the account's reports, independently of pagination.
After detail and the visible timeline have both loaded, the customer can send
`POST /support/reports/:id/acknowledge` with `{ seenThrough }`, using the report's observed support
activity timestamp. The cursor advances monotonically; a stale acknowledgement cannot hide newer
support activity, and a report owned by another account returns the same not-found boundary as
other customer report reads.

Updated Studio uses the [durable notification platform](../../docs/Notifications.md) for
customer-visible replies and resolution transitions, and disables the legacy resolution toast.
The notification recipient's read state is independent of the report's support-activity cursor.

Older clients can claim a newly resolved report for an in-app alert by sending
`POST /support/resolution-alerts/claim` with `{ expectedUserId }`. The expected identity is required
and must match the authenticated session; a mismatch returns HTTP 409 without claiming anything.
The durable notification migration reserves this legacy claim for each new resolution transition
in the same transaction as its event and delivery jobs, so an older client cannot also toast that
resolution. It leaves the support seen cursor untouched; eligible earlier resolutions retain the
legacy fallback described below.
One conditional database update atomically claims all
currently unread, not-yet-announced resolutions for that account, returning their count and newest
report. Concurrent tabs/devices therefore produce one alert, while the separate seen cursor keeps
the profile unread badge visible until the report timeline is actually viewed. Historical support
activity and resolutions are backfilled as seen/announced only when these columns are first added;
rerunning the migration never consumes later activity.

All customer and operator bug-report route responses include `Cache-Control: no-store`.

The `bug_report_messages` table contains customer-visible text only. Internal notes, agent
reasoning, logs, workspace data, and private runtime context must never be written there. Direct
`anon` and `authenticated` table privileges are revoked; browser clients go through the
report-owner routes. Customer report details expose the affected project as context but do not
expose source runtime, run, or conversation identifiers.

## Configuration
Key environment variables (see `AppConfig::from_env` for defaults):
- `DATABASE_URL` — Postgres connection for controller state (required).
- `DATABASE_POOL_SIZE` — max Postgres connection pool size (defaults to `4`). Keep this low when using the Supabase session pooler.
- `SUPABASE_PROJECT_URL` — base URL for the Supabase project; we derive the JWKS endpoint from this unless `SUPABASE_JWKS_URL` is provided.
- Tunnels:
  - `TUNNEL_BROKER_BASE_URL`, `TUNNEL_BROKER_TOKEN` — self-hosted tunnel broker (Hetzner/PDNS). When `TUNNEL_BROKER_HOOK_SECRET` is set, credits are burned via the broker ACL hook and the controller skips the pre-burn for self-hosted tunnels.
  - `TUNNEL_BROKER_HOOK_SECRET` — shared bearer secret for broker callbacks (`/tunnel-broker/hooks/acl` and `/tunnel-broker/hooks/events`).
- `SUPABASE_JWKS_URL` — optional override for JWKS discovery (defaults to `<SUPABASE_PROJECT_URL>/auth/v1/.well-known/jwks.json`). The key set it serves decides which Supabase access tokens the controller accepts, so the URL, configured or derived, is validated at startup and the controller refuses to start when it fails: it must use `https` (plain `http` only to `localhost` or a loopback address, under `DEV_MODE` or with a loopback Supabase project URL, as the local Supabase CLI serves), must be `/auth/v1/.well-known/jwks.json` under the project URL, must not carry credentials, a query string or a fragment, and must be on the project URL's host and port. JWKS fetches never follow redirects and time out after 10 seconds. Error messages name the rule, never the configured value.
- `SUPABASE_JWKS_URL_ALLOW_OTHER_HOST` — set to `1` (or `true`, `yes`, `on`) only when your deployment serves the same Supabase Auth under a host other than the project URL's, such as the project domain behind a custom domain, or an internal gateway. It relaxes the host and port rule alone; the scheme and path rules still apply. An `http` JWKS URL on a non-loopback host, such as `http://kong:8000` on a private network, is refused either way: put TLS in front of it, or run the controller against a loopback address.
- `SUPABASE_JWKS_REFRESH_SECONDS` — interval for refreshing the JWKS cache (defaults to 300 seconds; minimum 30). One refresher task, started with the controller, makes every JWKS fetch after the startup load; requests never fetch. If that task panics, the controller logs an error and restarts it, with the same URL, after 1 second, doubling to at most 60 seconds while it keeps panicking; until it is back, requests with an unknown key id are refused without waiting.
- `SUPABASE_JWKS_ON_DEMAND_INTERVAL_SECONDS` — minimum time between the start of one JWKS fetch and a fetch that a request asks for (defaults to 30 seconds; values under 5 mean the default). An access token whose key id the cache does not hold, such as one signed with a key Supabase has just rotated in, signals the refresher and waits up to 2 seconds for its fetch. Signals coalesce, so any number of such tokens causes at most one fetch per interval; inside the interval they are refused without waiting, and the fetch they asked for happens when the interval ends.
- `CONTROLLER_INTERNAL_TOKEN` — internal bearer token required for privileged automation.
- `USER_TOKEN_SECRET` — HS256 key that signs the controller session tokens issued by `POST /auth/session`. Any token that verifies against it is accepted as a session for the user it names, so outside `DEV_MODE` (enabled only by `1`, `true`, `yes` or `on`, in any case) the controller refuses to start when it is unset, shorter than 32 bytes, or the development value published in this repository. Generate it with `openssl rand -hex 32`. The controller checks a session token's signature, audience and expiry, not when it was issued, so a token signed with a leaked value can carry any expiry: replacing the secret is what invalidates it, not waiting out `USER_TOKEN_TTL_SECONDS`. With `CREDENTIAL_ENCRYPTION_KEY` set, rotating it only signs every user out.
- `CREDENTIAL_ENCRYPTION_KEY` — base64-encoded 32-byte key that encrypts the stored secrets in `user_credentials`, `project_secrets`, `user_oauth_tokens`, `project_browser_profiles` and `github_device_auth_sessions`. Required outside `DEV_MODE`. Generate it with `openssl rand -base64 32` and keep it in your secret store. Replacing it outright makes those rows unreadable; change it by following [Rotating the credential encryption key](#rotating-the-credential-encryption-key). Before upgrading a controller that ran without it, see [Upgrading a controller without explicit secrets](#upgrading-a-controller-without-explicit-secrets).
- `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` — optional, comma-separated base64-encoded 32-byte keys the controller only decrypts with, so rows sealed under an earlier `CREDENTIAL_ENCRYPTION_KEY` stay readable during a rotation. New values are always encrypted with `CREDENTIAL_ENCRYPTION_KEY`. The controller refuses to start when an entry is malformed, repeated or equal to `CREDENTIAL_ENCRYPTION_KEY`, or when more than 8 are listed, and warns on every start while one of them is the key derived from the published development value. The controller recognises that key by its one-way key id only; it does not know the key and never decrypts with it unless it is configured here or as `CREDENTIAL_ENCRYPTION_KEY`. It is a secret like the primary key: keep it out of runtime and agent environments.
- `AGENT_LOGIN_KEY` — shared secret agents use to mint scoped tokens via `/agent/login`.
- `WORKSPACE_ROOT` — runtime/controller root directory containing per-project workspaces. In local-canonical desktop mode, the source-of-truth folder can live outside this hosted layout. In git-canonical hosted mode, this root holds the materialized working copies.
- `PROXY_BASE_URL`/`PROXY_SIGNING_SECRET` — optional AI proxy envelope support.
- `MANAGED_AI_ENABLED` — enables the platform-managed AI lane. The proxy a runtime calls must be able to complete a credential-less turn: either it holds static credentials itself, or this controller serves the managed credential lease (`MANAGED_AI_OPENAI_API_KEY`).
- `MANAGED_AI_OPENAI_API_KEY` (falls back to `OPENAI_API_KEY` in the controller environment) — controller-owned OpenAI API key for the managed lane. The controller serves it through the proxy credential-lease route under the fixed id `4d414e41-4745-4441-8949-4e5354414659` (the proxy's `MANAGED_AI_CREDENTIAL_ID`), so a per-runtime proxy sidecar with no `OPENAI_API_KEY` or `auth.json` of its own (`remote_dynamic`) still serves managed turns. The key stays on the controller; runtime containers never see it. Unset keeps the static-proxy path unchanged: managed turns then need every proxy a runtime calls to hold static credentials. Rollout order matters: every provider host must already run a proxy image built from this change (`RUNTIME_PROXY_IMAGE` in `docker/docker-compose.runtime.provider.yml`) before this key is set on the controller. Setting the key is what makes the controller advertise managed AI and charge for managed turns, and an older sidecar still rejects those turns with `proxy token missing credential_id for BYOC request`.
- `MANAGED_AI_MODEL_ID` sets the upstream model id used for managed AI turns (defaults to `gpt-6-luna`; bring-your-own ChatGPT logins and API keys default to `gpt-5.6-sol` separately).
- `MANAGED_AI_MODEL_LABEL` sets the managed model name shown in the UI (defaults to `GPT-6 Luna`).
- `MANAGED_AI_INPUT_USD_MICROS_PER_1K`, `MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K`, `MANAGED_AI_OUTPUT_USD_MICROS_PER_1K` set the managed AI rates users are charged (defaults `100` / `10` / `500`, the GPT-6 Luna standard-tier list prices of `$0.10` / `$0.01` / `$0.50` per 1M tokens). Change them together with `MANAGED_AI_MODEL_ID`.
- `MANAGED_AI_STARTUP_CHECK` — when `true`, controller boot fails unless `PROXY_BASE_URL/healthz` answers and either reports `requiresCredential=false` (the proxy has static credentials such as `OPENAI_API_KEY` or `auth.json`) or `MANAGED_AI_OPENAI_API_KEY` is set (a `remote_dynamic` proxy leases it). Defaults to on outside `DEV_MODE`. The check probes only the controller's own proxy; hosted runtimes call their per-runtime sidecar, which is why the managed credential lease exists.
- `RUNTIME_LIMIT_RECLAIM_IDLE_SECONDS` — when an organization's hosted runtime limit refuses a launch, the controller stops an idle runtime in another space of the same organization and gives the slot to the waiting space. A runtime only qualifies when it is settled, has no leased or queued work and no open run, and has seen no agent or user activity for this many seconds (default `120`). `0` disables the reclaim and restores the plain `runtime_limit_reached` refusal. A refused space with queued agent work is retried in the background with backoff, and its work fails with a reason after 30 minutes on the limit (see "Waiting on the runtime limit" in `docs/Runtime-Machines.md`).
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
  - `OPERATOR_CONSOLE_ORG_ID` / `OPERATOR_CONSOLE_ALLOWED_USER_IDS` — owners/admins of that organization, or the comma-separated user UUIDs, pass every operator gate (OTA, desktop updates, telemetry, edge downloads, `/operator/*`, bug-report triage) except `/operator/credential-encryption/*`, which reads or rewrites every user's stored secrets and accepts only the service-role bearer.
  - `BUG_REPORTS_OPERATOR_USER_IDS` — comma-separated user UUIDs granted the operator projection and `PATCH` triage on `/bug-reports` only; the list grants nothing on any other operator route.
- Push notifications:
  - `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY` / `WEB_PUSH_VAPID_SUBJECT` — enable PWA Web Push (service-worker based) notifications.
  - `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY` (or `APNS_PRIVATE_KEY_B64`) / `APNS_USE_SANDBOX` — enable native iOS push via APNs.
  - Tip: generate VAPID keys via `npx web-push generate-vapid-keys` (outputs base64url `publicKey`/`privateKey`).

Additional fields include Redis settings for cross-controller `/events` fanout (`REDIS_URL`, optional `REDIS_NAMESPACE`, optional `REDIS_EVENTS_CHANNEL`), agent token TTLs, and GitHub workflow metadata. Keep environment-specific values in your orchestration layer (e.g., AWS ECS task definitions).

### Upgrading a controller without explicit secrets

Earlier releases started without `USER_TOKEN_SECRET` by falling back to a development value
published in this repository, and without `CREDENTIAL_ENCRYPTION_KEY` by deriving the key from
`USER_TOKEN_SECRET`. Both fallbacks now apply only under `DEV_MODE`, so a controller that relied
on either refuses to start after the upgrade. Earlier releases already use both variables when
they are set, so provision them on the release you run now and roll out the new release last:

1. Work out which key encrypted your stored secrets. If `CREDENTIAL_ENCRYPTION_KEY` was already
   set, keep it. Otherwise it was derived from the `USER_TOKEN_SECRET` the controller ran with
   (the published `dev-user-token-secret` when that was unset):

   ```bash
   printf '%s%s' 'instafy:credential-encryption-key:v1:' "$PREVIOUS_USER_TOKEN_SECRET" \
     | openssl dgst -sha256 -binary | base64
   ```

   Use that output as `CREDENTIAL_ENCRYPTION_KEY` so existing rows stay readable. A controller
   with no stored secrets can use a freshly generated key instead.
2. Generate a new `USER_TOKEN_SECRET`.
3. Set both values in one change and deploy it on the release you already run. Never set
   `USER_TOKEN_SECRET` alone on an earlier release: it would derive a different key and make every
   stored secret unreadable. With the key pinned, the earlier release decrypts exactly as before
   and logs nothing about it.
4. Verify: sign in again (sessions signed with the old secret stop working) and use a stored
   credential or project secret to confirm the rows still decrypt.
5. Roll out the new release. It checks both values at startup and, while the configured key is
   the one derived from the published development value, logs a warning on every start. Earlier
   releases never log that warning, so its absence before this step says nothing about the key.

If the controller ever served a network others could reach while `USER_TOKEN_SECRET` was unset,
anyone could sign a session for any user, with any expiry. Treat every session it accepted as
untrusted; replacing `USER_TOKEN_SECRET` in step 3 is what invalidates those tokens.

If the key was derived from the published value, anyone who can read the encrypted rows can
decrypt them, through a service-role key, a database role, a backup or any other SQL read path.
Pinning the key keeps them readable to the controller but does not protect them: re-encrypt them
under a freshly generated key by [rotating the credential encryption key](#rotating-the-credential-encryption-key),
or revoke those credentials and have their owners reconnect them. While the published key is
configured, as `CREDENTIAL_ENCRYPTION_KEY` or in `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`, the rotation
census counts the rows it opens, which is how you prove none remain before removing it.

### Rotating the credential encryption key

`CREDENTIAL_ENCRYPTION_KEY` encrypts the stored secrets in `user_credentials`, `project_secrets`,
`user_oauth_tokens`, `project_browser_profiles` and `github_device_auth_sessions` (AES-256-GCM, a
random nonce per value). The controller encrypts every new value with it and decrypts with it or
with any key in `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`, so a rotation keeps every stored secret
readable at every step. Rotate when the key may have been exposed, including when it is the key
derived from the published development value.

1. Generate a new key with `openssl rand -base64 32`.
2. Deploy `CREDENTIAL_ENCRYPTION_KEY=<new key>` and `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS=<old key>`
   to every controller that shares the database. A controller that knows only the old key cannot
   read values written under the new one, so if old and new controllers serve traffic at the same
   time during your rollout (a rolling or blue/green deploy), first deploy
   `CREDENTIAL_ENCRYPTION_KEY=<old key>` with `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS=<new key>`
   everywhere, then swap the two. Both steps need a release that supports
   `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`. Provision it the way you provision
   `CREDENTIAL_ENCRYPTION_KEY`: from your secret store, into the controller's environment only. If
   your deployment tooling allowlists or audits the variables a controller may receive, add
   `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` there before this deploy, or it will be dropped or refused.
3. Take a census with the service-role bearer (`CONTROLLER_INTERNAL_TOKEN` or the Supabase
   service-role key). It only reads:

   ```bash
   curl -fsS -H "Authorization: Bearer $CONTROLLER_INTERNAL_TOKEN" \
     "$CONTROLLER_URL/operator/credential-encryption/census"
   ```

   For each table and in `totals` it reports `rows`, how many the primary key opens (`primary`),
   how many each previous key opens (`previous`, in `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` order),
   how many no configured key opens (`undecryptable`), and `underPublishedDevelopmentKey`: rows
   the key derived from the published development value opens, while that key is configured as the
   primary or a previous key. It is `null` when that key is not configured: the controller
   recognises the key by its one-way id only and never decrypts with a key it is not configured
   with, so rows still under it after it is removed count as `undecryptable`. Each key in
   `primaryKey` and `previousKeys` appears only as a one-way `keyId`, with
   `publishedDevelopmentKey: true` on the published one.
4. Re-encrypt:

   ```bash
   curl -fsS -X POST -H "Authorization: Bearer $CONTROLLER_INTERNAL_TOKEN" \
     "$CONTROLLER_URL/operator/credential-encryption/reencrypt"
   ```

   Each row that only a previous key opens is rewritten under the primary key in its own
   transaction, under a row lock, after the new ciphertext is checked to decrypt to the same
   value. Rows already under the primary key and rows no configured key opens are never written,
   and nothing else about a row changes, except that a trigger updates `user_credentials.updated_at`.
   The response counts `scanned`, `alreadyPrimary`, `reencrypted`, `undecryptable` and `vanished`
   (deleted during the pass) per table. `batchSize` (rows listed per page, default 100, at most
   1000) and `maxRows` (stop after rewriting that many) are optional query parameters; a response
   with `"complete": false` stopped at `maxRows`, so run it again. The pass is safe to repeat and to
   run while the controller serves traffic; if a proxy in front of the controller cuts a long request
   off, rows already rewritten stay rewritten, so pass `maxRows` and repeat. Neither route logs or
   returns secret values or keys.
5. Take the census again. Continue only when every count in `totals.previous` is `0` and, if the old
   key was the published development key, `totals.underPublishedDevelopmentKey` is `0` (it is only
   reported while that key is still listed, so check it before step 6). A non-zero
   `undecryptable` means rows under a key that is not configured at all: the pass leaves them
   alone, and removing a previous key cannot make them readable. Find their key first.
6. Deploy without the old key in `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` and take one more census:
   `undecryptable` must not have grown. Once no previous key is left, remove the variable from your
   secret store and from any environment allowlist you added it to. Then destroy the old key.
   Database backups taken before the pass still hold values under it, so treat those backups as
   readable by anyone who holds it.

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
2. Set the required env vars (at minimum `DATABASE_URL`, `SUPABASE_PROJECT_URL`, `CONTROLLER_INTERNAL_TOKEN`, `WORKSPACE_ROOT`, and an Ed25519 keypair via `RUNTIME_SIGNING_PRIVATE_KEY` / `RUNTIME_SIGNING_PUBLIC_KEY`). Outside `DEV_MODE`, also set `USER_TOKEN_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`; a bare `cargo run` for local work needs both values, or `DEV_MODE=1` on a machine nobody else can reach, because `DEV_MODE` signs sessions with the published development value.
3. Use the provided scripts: `pnpm controller:up` to boot Supabase + the controller, and the matching `*:down` command when finished. It generates a per-checkout `USER_TOKEN_SECRET` (`tmp/user-token-secret`) and `CREDENTIAL_ENCRYPTION_KEY` (`tmp/credential-encryption-key.b64`) unless you export your own. Avoid backgrounding the controller manually; orphaned listeners block Playwright.
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
