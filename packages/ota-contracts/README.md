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
