# OTA Contracts

This package is the shared contract boundary for the Instafy OTA control plane.

It exists so that:

- GitHub Actions publishing scripts
- backend OTA handlers
- future native/web clients
- the internal operator console

all speak the same release, update-check, and telemetry shapes.

The package currently stores:

- machine-readable JSON schemas
- shared TypeScript payload definitions for workspace packages
- documentation references

Files:

- `src/index.ts`
- `schemas/release-registration.schema.json`
- `schemas/device-update-check.schema.json`
- `schemas/update-event.schema.json`

Keep this package small and boring. It should not absorb app-specific UI logic.

`required_native_build` optionally guards a release with the exact installed native build.
Checks, events, and device snapshots carry `native_build`; available responses repeat the guard
for client-side verification. Missing/null guards retain legacy marketing-version routing.
Missing or different device builds cannot consume guarded releases. Build strings are opaque,
1–64 ASCII digits with optional dot-separated numeric components; do not trim, coerce, or compare
them as semantic versions. See [the compatibility model](../../docs/OTA-Control-Plane.md#version-model)
for rollout and migration requirements.
