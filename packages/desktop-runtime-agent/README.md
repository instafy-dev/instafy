# @instafy/desktop-runtime-agent

> Developer preview – utilities for launching the Instafy desktop runtime during local
> development and testing.

This package packages a thin Node.js wrapper around the existing Rust runtime agent
(found in `packages/runtime-agent/`). It exposes a programmatic API that can be used by
Playwright tests (or other Node scripts) to spawn/stop the desktop runtime.

## Status

- **Not published** – the package is marked `private` and is intended for local
  development/testing.

## Prerequisites

- Node.js 18+
- The Rust `runtime-agent` and `origin-http-server` binaries built locally (see
  `packages/runtime-agent` and `packages/origin-http-server`). By default the helpers
  look for the debug builds under those packages. You can override the paths via
  environment variables or explicit options.

## Programmatic API

```ts
import { startDesktopRuntime } from "@instafy/desktop-runtime-agent";

const handle = await startDesktopRuntime({
  projectId: "00000000-0000-0000-0000-000000000000",
  controllerUrl: "http://127.0.0.1:8788",
  controllerAccessToken: process.env.CONTROLLER_ACCESS_TOKEN,
  origin: {
    internalToken: process.env.RUNTIME_ACCESS_TOKEN ?? process.env.ORIGIN_INTERNAL_TOKEN,
  },
});

// later…
await handle.stop();
```

Refer to `src/index.ts` for the full list of options. The helper returns an object that
includes the spawned process IDs and exposes a `stop()` method for graceful shutdown.

The controller assigns a fresh runtime UUID during the token exchange. The launcher verifies the
signed identity, exports it to the Rust agent as `RUNTIME_ID`, uses the same value for the private
origin ID, and exposes it on the returned handle. An explicit `runtimeId` is only for reconnecting
an existing runtime already owned by the same authenticated user; a caller-selected unused UUID is
rejected. Studio can then target browser jobs at that exact desktop runtime. The optional `personalBrowser` capability
is exported as `INSTAFY_PERSONAL_BROWSER_CONTROL_URL`,
`INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN`, and `INSTAFY_PERSONAL_BROWSER_PROJECT_ID`. The launcher
strips those names from inherited and generic environment values, so only the explicit Electron
grant activates local browser control. The control URL must be loopback and the project id must
match the runtime project. It also sets `INSTAFY_RUNTIME_AGENT_BIN` to the resolved executable so
the browser skill can use the built-in RPC client without depending on Node.js or exposing the
bearer token in process arguments.

Self-hosted tunnels use `rathole`. Use `RATHOLE_BIN` / `RATHOLE_STATE_DIR` to point
at a specific binary and state dir, or let the helper download/cache it under `~/.instafy/rathole` (override via
`RATHOLE_CACHE_DIR` and `RATHOLE_VERSION`).
On macOS arm64, the helper falls back to `cargo install rathole` when no prebuilt binary is available.
Private local startup registers the controller-assigned runtime directly and then requests its
tunnel without a hosted allocator lease. Provider-managed runtimes continue to use explicit
lease-bound tunnel credentials.

### Building the runtime binaries

The helper expects the Rust runtime agent to be built locally. From the repository root:

```bash
cargo build --manifest-path packages/runtime-agent/Cargo.toml
```

By default the helper looks for `packages/runtime-agent/target/debug/runtime-agent`. Release
builds are also supported (`target/release/runtime-agent`) and can be forced by building with
`cargo build --release`.

## Next steps

- Hook the Playwright harness to optionally use this package when running end-to-end
  tests.
- Harden configuration + platform support ahead of packaging a distributable binary.
