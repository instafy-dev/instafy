# Desktop Updater

This document keeps the desktop release path separate from mobile OTA on purpose.

## Decision

Do not route desktop updates through the Capacitor/Capawesome OTA control plane.

Use a standard Electron binary updater flow instead:

- signed desktop binaries
- installer-compatible targets
- channel-aware release feed
- `electron-updater` on the app side

## Why

Mobile OTA and desktop binary updates solve different problems:

- mobile OTA updates the web bundle inside a shipped native shell
- desktop updates replace the shipped application binary

Trying to force both through one system would create the wrong operational model and weaken the safety story.

## Current gap

The desktop packaging is now aligned with updater-friendly targets in [packages/desktop-app/package.json](../packages/desktop-app/package.json):

- macOS: `dmg`, `zip`
- Windows: `nsis`
- Linux: `AppImage`

The desktop main process now initializes `electron-updater` against the stable downloads feed in [updater.ts](../packages/desktop-app/src/updater.ts).

## Feed shape

GitHub Actions now publish desktop artifacts to two locations:

- versioned artifacts under `desktop-app/<tag>/...`
- the current updater feed under `desktop-app/<channel>/...`

That keeps direct downloads stable while giving `electron-updater` a fixed per-channel feed URL.

## Release channels

Desktop has two operational destinations:

- `internal` for unsigned/manual engineering builds on macOS, Windows, and Linux;
- `stable` for signed macOS and Windows tag builds.

A stable pointer can only be written by a fresh `desktop-app-v*` tag build; the
promotion workflow cannot copy an unsigned internal artifact into stable.

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

GitHub Actions should:

1. build desktop binaries
2. sign them
3. publish channel-specific metadata and artifacts
4. attach release notes and git sha

The stable tag must equal `desktop-app-v<package-version>`, and its commit must
be reachable from the current `origin/main`. The packaged runtime manifest and
public `latest.json` both record the full source commit.
Release verification recalculates updater SHA-512 entries and extracts or
mounts the final installer/archive to verify the bundled runtime from shipped
bytes, not only from electron-builder's unpacked directory.

### App client

The Electron app should:

1. check the configured channel feed
2. prompt before downloading the next binary update
3. install on quit / restart
4. expose lean updater status in the desktop shell for future telemetry/diagnostics

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
