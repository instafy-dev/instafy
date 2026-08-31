# Desktop Updater

This document keeps the desktop release path separate from mobile OTA on purpose.

## Decision

Do not route desktop updates through the Capacitor/Capawesome OTA control plane.

Use a standard Electron binary updater flow instead:

- signed desktop binaries where a signing lane is available
- installer-compatible targets
- channel-aware release feed
- `electron-updater` on the app side

## Why

Mobile OTA and desktop binary updates solve different problems:

- mobile OTA updates the web bundle inside a shipped native shell
- desktop updates replace the shipped application binary

Trying to force both through one system would create the wrong operational model and weaken the safety story.

## Current implementation

The desktop packaging is now aligned with updater-friendly targets in [packages/desktop-app/package.json](../packages/desktop-app/package.json):

- macOS: `dmg`, `zip`
- Windows: `nsis`
- Linux: `AppImage`

The desktop main process initializes `electron-updater` against the stable downloads feed in
[updater.ts](../packages/desktop-app/src/updater.ts). The web installer page reads the stable
`latest.json` alias; neither surface invents a download when the stable manifest is absent.

The web Studio exposes a **Get Desktop** action in the wide workspace tab bar and an
**Install Instafy** account-menu fallback. Both are hidden in Electron and Capacitor shells
and fail closed until a strict stable manifest is available. Acquisition links open
`/install#desktop` in a new tab so an active Studio task is not replaced.

## Feed shape

A deployment release pipeline publishes desktop artifacts to two locations:

- versioned artifacts under `desktop-app/<tag>/...`
- the current updater feed under `desktop-app/<channel>/...`

That keeps direct downloads stable while giving `electron-updater` a fixed per-channel feed URL.
For stable releases, `desktop-app/latest.json` aliases
`desktop-app/stable/latest.json`, while updater YAML and immutable tag-scoped artifacts remain
available for in-progress downloads.

## Release channels

Desktop has two operational destinations:

- `internal` for unsigned/manual engineering builds on macOS, Windows, and Linux;
- `stable` for signed and notarized macOS builds plus currently unsigned Windows tag builds.

The Windows installer is still verified from its final packaged bytes and covered by the updater
metadata checks, but it must not be described as code-signed until a Windows signing identity is
wired into the release lane.

A stable pointer can only be written by a fresh `desktop-app-v*` tag build; the
promotion workflow cannot copy an unsigned internal artifact into stable.
Stable-to-internal diagnostic promotion first reads that private pointer and
then copies only its selected immutable tag; it never trusts the mutable stable
compatibility objects as release authority.

Stable macOS filenames carry their build architecture explicitly (`mac-arm64`
or `mac-x64`), and `latest.json` makes the installer page label it accurately.
Linux AppImage publication remains internal until an artifact
signing and final-installer verification path is in place; stable metadata must
not advertise a Linux download before then.

Desktop artifacts remain a separate domain model from mobile OTA bundles even when both use the
same configurable public artifact host. Storage topology, deployment credentials, and publication
policy belong to the deployment operator.

## Minimal architecture

### Build and publish

A deployment release pipeline should:

1. build desktop binaries
2. sign and notarize the macOS binaries
3. verify the final packaged macOS and unsigned Windows installers and the local Electron SHA-512 metadata
4. upload immutable tag-scoped payloads, blockmaps, updater YAML, and strict `latest.json`
5. maintain non-authoritative channel compatibility copies for operations tooling
6. verify the complete immutable candidate through `https://downloads.instafy.dev`
7. select stable with one monotonic `stable-release.json` pointer write
8. verify both live aliases and feeds through `https://downloads.instafy.dev`

The object-store release selected by `stable-release.json` is the distribution authority. The
Git tag identifies the source, but the pipeline does not create a GitHub Release or use GitHub
release assets as a second download surface.

The stable tag must equal `desktop-app-v<package-version>`, and its commit must
be reachable from the current `origin/main`. The packaged runtime manifest and
public `latest.json` both record the full source commit.
Release verification recalculates updater SHA-512 entries and extracts or
mounts the final installer/archive to verify the bundled runtime from shipped
bytes, not only from electron-builder's unpacked directory.

The post-publication gate is
[`scripts/verify-desktop-publication.mjs`](../scripts/verify-desktop-publication.mjs).
It uses cache-busting HTTPS requests and fails the publication job unless all
of the following are true:

- the channel, version, tag, full source SHA, feed URL, architecture, and
  artifact names in `latest.json` match the workflow build
- for stable, `desktop-app/latest.json` exactly matches
  `desktop-app/stable/latest.json`
- stable manifest and platform-YAML responses report the expected immutable tag
  in `X-Instafy-Desktop-Release`
- every channel and immutable tag-scoped platform YAML is byte-identical,
  reports the expected version, and contains complete SHA-512/size entries
- both channel and immutable installer/archive bytes match those YAML
  checksums and sizes
- every channel blockmap is byte-for-byte equal to its immutable tag-scoped
  copy by computed SHA-512 and size
- an immutable artifact answers a `bytes=0-0` request with a valid `206`,
  `Content-Range`, one-byte body, and `Accept-Ranges: bytes`

The checks retry boundedly for edge propagation. A failed gate blocks the
GitHub release. Do not replace immutable tag objects to repair a failure; fix
the worker or publication configuration and rerun the same tag only when the
already-published bytes are identical.

Before tagging, run a non-publishing readiness build that exercises the same
macOS signing/notarization, unsigned Windows packaging, final-artifact verification,
and packaged Personal Browser canary as the release build. Deployment-specific
workflow wiring and credentials stay outside the public core. Do not run a
packaged drain-aware canary until migration `20260000000064` and its matching
controller behavior have been verified in that deployment.

An operator can run the same gate independently when diagnosing a release:

```bash
DOWNLOADS_BASE_URL=https://downloads.instafy.dev \
DESKTOP_DOWNLOADS_PREFIX=desktop-app \
DESKTOP_PUBLICATION_CHANNEL=stable \
DESKTOP_PUBLICATION_VERSION=0.2.0 \
DESKTOP_PUBLICATION_TAG=desktop-app-v0.2.0 \
DESKTOP_PUBLICATION_SOURCE_SHA=<full-tag-commit-sha> \
node scripts/verify-desktop-publication.mjs
```

### App client

The Electron app should:

1. check the configured channel feed
2. prompt before downloading the next binary update
3. install on quit / restart
4. expose lean updater status in the desktop shell for future telemetry/diagnostics

#### Job-aware quit and update invariant

Installing an update, restarting, and an ordinary application quit all use the
same coordinated shutdown path. Before presenting the final choice, Electron
asks the controller to place the exact active private runtime in `draining`.
Only that runtime's immutable attested owner can create or renew the fence. The
controller then refuses new job leases for that runtime while existing jobs may
continue heartbeat, completion, origin, and tunnel operations.

The drain is a renewable 90-second lease stored in
`runtimes.drain_expires_at`, not a permanent status. While waiting, Electron
renews it and reads the authoritative count of leased jobs. The user can:

- wait for current work to finish and then quit/restart;
- explicitly quit/restart anyway, which may interrupt the run; or
- cancel, keep the app open, and require a confirmed `resume` response.

A second quit/restart request while waiting offers Keep waiting, Quit/Restart
anyway, and Cancel quit. If activity cannot be authenticated or verified, the
default is to keep the app open; an explicit destructive choice is required.
If a cancel cannot confirm `resume`, the app remains open and explains that the
renewable fence will expire automatically. JWT refresh and every controller
request are bounded so a long-running job cannot silently bypass or hang this
decision.

On the actual shutdown path, Electron must first prove the complete local
runtime process tree is stopped and only then tell the controller to dispose the
runtime and requeue interrupted work. The parent-managed runtime agent must not
independently reverse that order. If tree termination cannot be proved, quit
fails closed and the controller fence is not released.

Migration `20260000000064_runtime_drain_leases.sql` and the controller code for
contract version `1` are one deployment cutover unit. Verify both are live
before running or publishing a packaged Desktop build that calls
`drain`/`resume`. Never publish the Desktop caller first, and do not overlap old
and new controller generations for this incompatible boundary.

The generic Electron provider sets `useMultipleRangeRequest: false`. Its
differential downloader therefore issues sequential single byte-range requests,
which the downloads worker serves directly from the configured object store (R2 in the hosted
deployment). The stable pointer and those objects—not GitHub release assets—are authoritative.
The worker supports bounded,
open-ended, and suffix single ranges; returns `416` plus
`Content-Range: bytes */<size>` for an unsatisfiable single range; and ignores
unknown, malformed, or multipart range forms by returning the full `200`
representation. Do not enable multipart range requests without implementing
and testing `multipart/byteranges` responses at the edge.

### Telemetry

Desktop update telemetry should stay lean at first:

- update available
- download started
- download completed
- update ready
- install applied
- update error
- current desktop app version
- current channel

Use a separate desktop control-plane model for feeds, device states, events, and release history.
Any administrative UI belongs outside the customer-facing Studio application.

It intentionally does not reuse the mobile bundle schema.

## Promotion boundary

Stable metadata must point only to a fresh artifact built, signed, and verified from the matching
source tag. A channel-copy operation must never manufacture a stable release from an unsigned
engineering artifact. Deployment-specific promotion automation and credentials are maintained
separately.

## Remaining work

1. real runtime desktop update telemetry from packaged builds
2. decide whether to auto-download silently or keep the current opt-in download prompt
3. link release history back to its source revision and build record
