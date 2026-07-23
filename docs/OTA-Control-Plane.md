# OTA Control Plane

This document turns the OTA rollout direction into concrete repo structure, schema, API, telemetry, and CI responsibilities.

Use this together with [OTA rollout](./OTA-Rollout.md).

## Goals

- Keep native builds in GitHub Actions
- Keep OTA bundle hosting on Instafy-managed infrastructure
- Make Instafy the source of truth for release metadata, rollouts, telemetry, and dashboards
- Keep OTA admin surfaces separate from the customer-facing Studio frontend

## Package Separation

Do not mix OTA control-plane code directly into the main Studio frontend.

Recommended structure:

- `packages/frontend`
  - customer-facing Instafy app
  - consumes OTA checks/events as a client
  - does not own OTA admin dashboards
- `packages/ota-contracts`
  - shared OTA JSON contracts and schema definitions
  - used by CI scripts, backend handlers, dashboards, and native/web clients
- private operations UI
  - separate internal app for release controls, telemetry, and operator tooling
  - should not be folded into the main Studio app
- `packages/runtime-controller`
  - first home for the OTA control-plane API in the backend
  - acceptable for v1 because we already have auth, projects, telemetry, and runtime state there
- `scripts/`
  - release packaging and CI publishing helpers

If the OTA API grows large enough, it can later be extracted from `packages/runtime-controller`
into a dedicated service without changing the shared contracts or operations UI.

## Recommended v1 Boundaries

### Backend

Put the OTA API into `packages/runtime-controller` for the first implementation.

Why:

- existing auth/session context already lives there
- we already have operational infrastructure around it
- it avoids introducing a new service before the data model is proven

For the first implementation, keep OTA operational state in Postgres instead of introducing a second service too early.

Scope the stored data tightly:

- releases
- channel assignments
- device state snapshots
- recent OTA lifecycle events

Do not treat this store as a long-term high-volume analytics warehouse yet. Keep the event stream lean enough for Postgres by limiting it to operational update telemetry.

### Shared contracts

Put all request/response/event schemas in `packages/ota-contracts`.

This prevents:

- frontend-only types becoming the accidental source of truth
- CI scripts inventing one JSON shape while backend uses another
- the future dashboard re-declaring payloads again

### Internal operator console

Keep internal operator UI in the private distribution, not `packages/frontend`.

Reason:

- OTA release operations are an administrative concern
- the main Instafy app should stay focused on customer workflows
- rollout analytics, telemetry, and release controls will likely grow into a fairly distinct internal product surface

## Automation Boundary

Use the Instafy CLI as the rollout interface for automation.

That means:

- human operators can call `instafy ota ...`
- AI agents can call `instafy ota ...`
- GitHub Actions should call the same CLI

Do not duplicate rollout behavior in one-off workflow shell scripts when a stable CLI command exists. The workflow should package artifacts, then hand off release registration and channel movement to the same command surface used everywhere else.

## Core Entities

### Release

One OTA release record per platform/channel-compatible bundle assignment.

Suggested canonical fields:

| Field | Type | Notes |
| --- | --- | --- |
| `release_id` | string | Stable internal identifier |
| `platform` | `ios` or `android` | Desktop stays separate for now |
| `channel` | string | `internal`, `beta`, `stable`, etc. |
| `bundle_version` | string | OTA bundle identifier |
| `git_sha` | string | Source revision |
| `native_version` | string | Intended native app version |
| `min_supported_native_version` | string | Compatibility gate |
| `artifact_url` | string | Immutable ZIP URL |
| `artifact_sha256` | string | Integrity check |
| `artifact_size_bytes` | integer | Useful for telemetry and UI |
| `artifact_type` | `zip` | Keep explicit for forward compatibility |
| `signature` | string or null | Signature payload or detached signature reference |
| `rollout_percentage` | integer | `0-100` |
| `status` | string | `draft`, `live`, `paused`, `rolled_back`, `archived` |
| `published_at` | timestamp | Release registration time |
| `published_by` | string | Actor or CI source |
| `notes` | string or null | Internal release notes |

### Device state

Useful fields for rollout and diagnostics:

| Field | Type | Notes |
| --- | --- | --- |
| `device_id` | string | Stable OTA client id |
| `platform` | string | `ios` or `android` |
| `channel` | string | Assigned update channel |
| `native_version` | string | Current installed native version |
| `current_bundle_version` | string or null | Current OTA bundle identity, independent from the binary version |
| `current_git_sha` | string or null | Current bundle source |
| `last_seen_at` | timestamp | Last OTA check / app heartbeat |
| `last_check_at` | timestamp or null | Last OTA decision check |
| `last_event_type` | string or null | Most recent recorded OTA lifecycle event |
| `last_event_at` | timestamp or null | When that lifecycle event occurred |
| `last_release_id` | string or null | Release resolved from the device's latest bundle |
| `last_session_id` | string or null | Most recent client session marker |
| `last_user_id` | string or null | User id when known |
| `last_space_id` | string or null | Space id when known |

### Storage model

The current controller implementation persists OTA operational data in Postgres tables:

- `ota_releases`
- `ota_channel_assignments`
- `ota_channel_history`
- `ota_device_states`
- `ota_events`

## Version model

Treat the native binary version and the OTA bundle identity as separate values.

- The native binary version is the App Store / TestFlight / Play build version shipped inside the app shell.
- The OTA bundle identity is the currently applied web bundle. It does not need to be semantic versioning; a timestamped hash-like identifier is fine and is simpler operationally.

Diagnostics, bug reports, and operator tooling should always capture both values. A publish or rollback decision without both pieces of metadata is incomplete.

This is intentionally not the same thing as full product analytics.

Current rule:

- keep only operational OTA telemetry in Postgres
- defer high-volume session/usage analytics to a later purpose-built pipeline
- keep the recent events table bounded for rollout/debugging rather than indefinitely growing it

## API Shape

The first version does not need a huge API surface. Keep it tight.

### Operator API

These routes are for release registration and admin operations.

#### `POST /ota/releases`

Create or register a release.

Payload:

```json
{
  "release_id": "ios-stable-2026-03-18T120000Z-e7c0e985",
  "platform": "ios",
  "channel": "stable",
  "bundle_version": "2026.03.18-e7c0e985",
  "git_sha": "e7c0e985b8b4d4f6c0f8b6b3c9f6a6b0f5d5e8a1",
  "native_version": "1.0.0",
  "min_supported_native_version": "1.0.0",
  "artifact_url": "https://artifacts.example.com/mobile/2026.03.18-e7c0e985.zip",
  "artifact_sha256": "6c0d0d1f4ddf0e9f7f6c6ef9a246f73468d08e9d0d131e5b7b5d62a2d8d4a0e2",
  "artifact_size_bytes": 10485760,
  "artifact_type": "zip",
  "signature": null,
  "rollout_percentage": 100,
  "status": "draft",
  "published_at": "2026-03-18T12:00:00.000Z",
  "published_by": "github-actions",
  "notes": "Initial beta OTA release"
}
```

#### `GET /ota/releases`

List registered releases.

#### `GET /ota/channels`

List current channel assignments.

#### `GET /ota/channels/:platform/:channel/history`

List recent activate and rollback events for one channel.

Supported query params:

- `limit`

#### `GET /ota/device-states`

List tracked device state snapshots.

Supported query params:

- `limit`
- `platform`
- `channel`
- `query`
- `attention_only`
- `before_seen_at`

#### `GET /ota/events`

List recently ingested OTA telemetry events.

Supported query params:

- `limit`
- `platform`
- `channel`
- `event_type`
- `query`
- `before_occurred_at`

#### `POST /ota/channels/:platform/:channel/activate`

Move a channel to a release or change rollout percentage.

Payload:

```json
{
  "release_id": "ios-stable-2026-03-18T120000Z-e7c0e985",
  "rollout_percentage": 25,
  "activated_by": "admin@example.com"
}
```

#### `POST /ota/channels/:platform/:channel/rollback`

Repoint the channel to a previous healthy release.

Payload:

```json
{
  "release_id": "ios-stable-2026-03-10T090000Z-cd0ad5ab",
  "activated_by": "admin@example.com"
}
```

`release_id` is optional. If omitted, the controller rolls back to the previously active release for that platform/channel.

### Administrative authorization

Release-registration and channel-mutation routes require a protected server-side identity plus an
explicit administrator authorization check. Normal users and OTA devices must not gain access
through project membership alone, and a browser must never receive a service-role credential.
Each deployment owns its administrator bootstrap and automation identity.

### Device API

These routes are for apps checking and reporting OTA state.

#### `POST /ota/check`

App asks for the latest allowed release for its platform/channel/native version.

Payload:

```json
{
  "device_id": "7c9f3c3a-1d94-4b7e-9b68-964bf289e9c4",
  "platform": "ios",
  "channel": "stable",
  "native_version": "1.0.0",
  "current_bundle_version": "2026.03.10-cd0ad5ab",
  "current_git_sha": "cd0ad5ab2d4a6f905e3a06d5f302b8f7dd1e0f52"
}
```

Response when update is available:

```json
{
  "update_available": true,
  "reason": "update_available",
  "release_id": "ios-stable-2026-03-18T120000Z-e7c0e985",
  "bundle_version": "2026.03.18-e7c0e985",
  "git_sha": "e7c0e985b8b4d4f6c0f8b6b3c9f6a6b0f5d5e8a1",
  "artifact_url": "https://artifacts.example.com/mobile/2026.03.18-e7c0e985.zip",
  "artifact_sha256": "6c0d0d1f4ddf0e9f7f6c6ef9a246f73468d08e9d0d131e5b7b5d62a2d8d4a0e2",
  "artifact_size_bytes": 10485760,
  "artifact_type": "zip",
  "signature": null,
  "rollout_percentage": 25
}
```

Response when no update is available:

```json
{
  "update_available": false,
  "reason": "already_active"
}
```

#### `POST /ota/events`

Client reports lifecycle events for telemetry and dashboards.

Payload:

```json
{
  "event_id": "b47bbd1f-907a-4d0f-9f66-5e7651f23577",
  "event_type": "download_completed",
  "occurred_at": "2026-03-18T12:04:10.000Z",
  "device_id": "7c9f3c3a-1d94-4b7e-9b68-964bf289e9c4",
  "platform": "ios",
  "channel": "stable",
  "native_version": "1.0.0",
  "bundle_version": "2026.03.18-e7c0e985",
  "git_sha": "e7c0e985b8b4d4f6c0f8b6b3c9f6a6b0f5d5e8a1",
  "space_id": null,
  "user_id": null,
  "session_id": null,
  "properties": {
    "download_duration_ms": 921
  }
}
```

## Telemetry Events

Start with a tight event vocabulary:

- `update_check_requested`
- `update_available`
- `update_not_available`
- `download_started`
- `download_completed`
- `download_failed`
- `install_started`
- `install_completed`
- `install_failed`
- `app_reloaded`
- `rollback_triggered`
- `session_started`
- `session_ended`
- `usage_heartbeat`

Keep `properties` extensible, but do not make event names fuzzy.

## Operations UI boundary

Release administration belongs outside the customer-facing Studio frontend.

It should answer:

- which release is live on each channel
- how many devices are on each bundle
- adoption curve over time
- download/apply failure rate by release
- rollback count by release
- active usage time by native version and bundle version

Keep that UI separate even if the first version is minimal.

## GitHub Actions Release Path

The CI flow should be:

1. Build `packages/frontend`
2. Create an immutable OTA ZIP artifact
3. Sign the ZIP with the OTA private key
4. Generate a machine-readable bundle manifest including checksum and detached signature
5. Generate one or more release registration payloads using the shared contracts
6. Upload artifacts to GitHub and optionally publish them to object storage
7. Register the release in the Instafy control plane

This keeps build logic in GitHub Actions while the release metadata model remains Instafy-owned.

Public implementation primitives:

- bundle builder: `scripts/build-ota-bundle.mjs`
- release payload renderer: `scripts/render-ota-release-payload.mjs`
- signing key generator: `pnpm ota:signing:keygen`
- rollout CLI:
  - `instafy ota releases register`
  - `instafy ota channels activate`
  - `instafy ota channels rollback`

Signing flow:

1. Generate an RSA keypair with `pnpm ota:signing:keygen`
2. Store the private key only in the deployment's CI secret store
3. Embed the corresponding public key in native builds
4. Let CI sign the generated OTA ZIP and carry the signature into the manifest and release payload

CI must fail closed when signing material is unavailable. A deployable channel may reference only
a signed artifact, even if a deployment permits unsigned draft registration for local debugging.

## Mobile Verification Boundary

The mobile app must verify signed artifacts, not just trust controller metadata.

Current repo wiring:

- Capacitor config reads `CAPACITOR_LIVE_UPDATE_PUBLIC_KEY` in `packages/frontend/capacitor.config.ts`
- Capawesome Live Update performs the client-side signature verification before applying the bundle

That means:

- the controller remains the source of truth for release metadata and rollout
- the client remains the enforcement point for artifact integrity
- unsigned artifacts may exist as drafts for debugging, but should not be promoted onto operator-facing channels

## Data Ownership Rule

Even if we temporarily use any managed release tooling later, Instafy must still own:

- release identity
- channel mapping
- device state
- event telemetry
- deployment-owned dashboards

That rule avoids vendor lock-in and keeps future migration cheap.
