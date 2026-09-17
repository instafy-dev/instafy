# OTA Rollout

This document describes the recommended over-the-air update path for Instafy across iOS, Android, and desktop.

The recommendation is intentionally biased toward long-term ownership of release metadata, telemetry, and rollout controls while still reusing the existing GitHub Actions build pipeline.

Implementation details live in [OTA control plane](./OTA-Control-Plane.md).

## Decision

Use the Capawesome Live Update plugin in a self-hosted-bundle setup, but make Instafy the source of truth for:

- bundle metadata
- channel assignments
- rollout percentages
- update telemetry
- rollback state
- operational visibility

This combines the earlier "stage 1" and "stage 2" into the initial implementation:

- Stage 1: self-host update bundles and wire OTA into the app
- Stage 2: own release metadata and telemetry in Instafy from day one

We are explicitly not choosing Appflow because it is being sunset, and we do not want to build a new delivery path on top of a platform that is shutting down.

## Why This Shape

Instafy already has:

- GitHub Actions for native builds and release automation
- portable bundle-building and signing helpers
- a product direction that requires custom telemetry and distribution logic

Because of that, the main value we need from the OTA layer is the client-side update primitive, not a hosted control plane.

We want to own:

- which bundle is live for each channel
- which devices see which update
- how rollout and rollback decisions are made
- how update adoption is measured
- how OTA events tie into Instafy orgs, users, spaces, runtimes, and sessions

## Constraints

### iOS

OTA updates must stay within Apple's review constraints. Treat OTA as web-layer/app-shell updates, not a way to bypass App Review for major native or product-scope changes.

### Android

Use OTA for web-layer changes. Keep native binary updates on the Play Store path.

### Desktop

Desktop binaries should continue to use the Electron updater / installer flow. The OTA bundle path described here is primarily for the Capacitor app shell.

See [Desktop updater](./Desktop-Updater.md) for the separate desktop release track.

## What We Are Building

### 1. Client updater

Use the Capawesome Live Update plugin in the Capacitor app.

Responsibilities:

- check for updates
- download bundle ZIPs
- verify signatures
- install and apply updates
- report lifecycle events back to Instafy

### 2. Bundle hosting

Host OTA bundles on immutable HTTPS object storage, optionally behind a CDN or custom domain.

Each published bundle should be immutable and addressable by a stable release identifier.

Example:

```text
https://artifacts.example.com/mobile/ios/stable/2026-03-18T120000Z-<git_sha>.zip
https://artifacts.example.com/mobile/android/stable/2026-03-18T120000Z-<git_sha>.zip
```

### 3. Instafy OTA control plane

Instafy backend should own release metadata instead of delegating that to a vendor dashboard.

Responsibilities:

- register a release
- attach bundle URL, checksum, signature, platform, and native compatibility
- map channels to releases
- define rollout percentage and targeting rules
- expose "latest allowed release for this device" to the app
- record update events
- support rollback by flipping the channel pointer

### 4. Telemetry

Telemetry is part of the first version, not a later add-on.

Track at minimum:

- update check requested
- update available
- download started
- download completed
- install succeeded
- install failed
- app reloaded into new bundle
- rollback triggered
- current native version
- current bundle version
- active usage time
- session start / session end

All OTA events should be attributable to:

- platform
- app version
- bundle version
- channel
- git SHA
- org / user / space when available

## What We Are Not Building Yet

- a full public-facing OTA admin product
- experiment tooling
- deep cohort analytics
- desktop OTA through the same channel system
- delta-update infrastructure beyond what the plugin already supports

Those can come later once the basic release and telemetry loop is proven.

## Release Data Model

Instafy should define its own canonical OTA release model from day one.

Suggested fields:

```text
release_id
platform                # ios | android
channel                 # internal | beta | stable
native_version
min_supported_native_version
bundle_version
git_sha
artifact_url
artifact_sha256
signature
rollout_percentage
status                  # draft | live | paused | rolled_back | archived
published_at
published_by
notes
```

Suggested device state fields:

```text
device_id
platform
native_version
current_bundle_version
current_git_sha
channel
last_seen_at
last_update_status
last_update_error
```

## GitHub Actions Flow

We should continue to use GitHub Actions as the build and publish engine.

Initial release flow:

1. Build the web bundle from `packages/frontend`
2. Create an OTA artifact ZIP
3. Sign the artifact with `OTA_SIGNING_PRIVATE_KEY`
4. Upload the artifact to Instafy-hosted storage
5. Register the release in the Instafy OTA metadata store
6. Move the desired channel pointer or rollout percentage

This keeps CI stable and makes the OTA system replaceable without changing how builds are produced.

Use `pnpm ota:signing:keygen` to generate the RSA keypair. Keep the private key only in the
deployment's CI secret store and embed the corresponding public key in native builds.

### Public release lane operations

`.github/workflows/mobile-ota-release.yml` runs steps 1-4 when the release bot pushes a tag named
`ota-v<sha12>`. Only that tag push publishes. The workflow_dispatch trigger (`tag`) is always a dry
run: it builds, signs and verifies the main head it was started for and publishes nothing. Every job
checks out `github.sha`, so a dispatch can only name a tag that is absent or peels to that main head.
Steps 5 and 6 stay with the operator-authenticated control plane caller.

Set things up in this order:

1. Add tag rulesets for `refs/tags/ota-v*` before any secret exists: only the release bot may
   create these tags, and nobody, including the bot, may bypass the update or delete rules. The
   `ota-release` environment's tag policy is not a security boundary on its own. Without the
   ruleset, anyone with write access could tag an unmerged commit, and that commit's own copy of
   the workflow, with its checks removed, would receive the signing key and the R2 token.
2. Create the `ota-release` environment with deployment policies tag `ota-v*` and branch `main`
   (the dry run in step 3 is a main dispatch and is refused at sign without the branch policy), then
   add its secrets and the `CAPACITOR_LIVE_UPDATE_PUBLIC_KEY` variable.
3. Dispatch a dry run (`--ref main -f tag=ota-v<sha12 of the main head>`) to prove that the signing key matches the
   shipped trust anchor.

The downloads origin (`https://downloads.instafy.dev`), the bucket and the `mobile`/`desktop-app`
prefixes are pinned in the workflow and in `browser-safe-config.mjs`. Repository variables cannot
override them.

Recovery:

- Dry runs share a concurrency group with each other, and each release tag has its own group, so
  a dry run never cancels a pending release. A release cannot be started by dispatch; recover a tag
  push run by re-running it (it keeps its tag commit as `github.sha`).
- Publication is one-shot. authorize requires the GitHub Release and both R2 objects to be absent.
  If publish fails after the R2 upload, use **Re-run failed jobs** on the original run while the
  signed artifact is retained (30 days). This reuses authorize's outputs, and `put-immutable.sh`
  accepts a byte-identical re-put. **Re-run all jobs** fails at authorize once any object is
  public, and a dispatch never publishes. Past the retention window, release a new commit under a new tag.
- If the tag push never started a run (GitHub dropped the event, or a bulk tag push did not
  trigger), or the run is gone with nothing left to re-run, that tag cannot be published: dispatch
  is a dry run only and nothing else may start a release. Recovery is the same as past the
  retention window: land a new commit on main and push a new `ota-v<sha12>` tag for it. Leave the
  unpublished tag in place; it names no Release and no R2 object.
- If `gh release create` was interrupted and left a draft Release, delete the draft by hand and
  then re-run the failed publish job. A draft does not count as a published Release.
- A run or re-run is accepted only when `github.triggering_actor` is the release bot. authorize
  checks it, and because **Re-run failed jobs** skips a succeeded authorize, sign and publish check
  it again as their first shell step, before any step that reads a secret.

## Initial Channel Model

Keep the first version simple:

- `internal`
- `beta`
- `stable`

Rules:

- `internal` is for dev/test devices only
- `beta` is for pre-release rollout
- `stable` is public production

Rollout can start as one simple percentage gate per channel.

## Rollback Model

Rollback should be metadata-only whenever possible.

Preferred rollback action:

- mark current release unhealthy
- repoint the affected channel to the previous good release

No artifact deletion should be required for rollback.

## Operational visibility

The control-plane API should make it possible to answer:

- which release is live on each channel
- how many devices are on each bundle
- adoption curve over time
- failure rate by release
- rollback count by release
- average active usage time by bundle version

The presentation layer is deployment-specific and does not belong in the customer-facing Studio
application.

## Recommended Implementation Order

### Step 1

Add the Capawesome Live Update plugin to the Capacitor app and define the bundle format.

### Step 2

Create the Instafy OTA metadata schema and a small protected API for:

- list releases
- create release
- set channel release
- resolve latest release for a device
- ingest update events

### Step 3

Wire GitHub Actions to:

- build
- sign
- upload
- register

### Step 4

Add lean client telemetry and minimal operational visibility.

Keep the first telemetry slice operational only:

- session started / ended
- update check requested
- update available / not available
- download or install lifecycle events once the updater primitive is fully wired

Do not start with high-volume usage analytics or heartbeat streams. Keep the first store small enough to fit comfortably in Postgres.

### Step 5

Validate release selection, signature enforcement, and rollback with disposable test devices.
Live channel-promotion policy is deployment-specific.

## Open Questions

- Whether OTA artifacts should share a general artifact host or use a dedicated mobile-update host
- Whether rollout logic should be per-app, per-org, or per-user/device cohort from the first version
- Whether Electron should later reuse parts of the same Instafy release metadata model even if binary delivery stays separate

## Summary

The recommended path is:

- Capawesome plugin for the client updater
- GitHub Actions for builds
- provider-neutral immutable hosting for bundle artifacts
- Instafy backend as the OTA control plane
- Instafy telemetry as the source of truth for adoption and usage

That keeps artifact storage replaceable, fits the current repository shape, and preserves ownership
of release metadata and telemetry.
