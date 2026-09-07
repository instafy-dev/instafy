# @instafy/desktop-runtime-agent

> Developer preview – utilities for launching the Instafy desktop runtime during local
> development and testing.

This package packages a thin Node.js wrapper around the existing Rust runtime agent
(found in `packages/runtime-agent/`). It exposes a programmatic API that can be used by
Playwright tests (or other Node scripts) to spawn/stop the desktop runtime, and ships a
matching CLI (`instafy-desktop`) for interactive usage.

## Status

- **Not published** – the package is marked `private` and is intended for local
  development/testing.
- **Developer preview** – the CLI can ensure a `rathole` tunnel client is available, mint runtime access tokens from a controller access token, and powers the VS Code extension. Expect rapid iterations as we polish the UX.

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

## CLI

```bash
pnpm --filter @instafy/desktop-runtime-agent dev -- --space-id <uuid> \
  --controller-url http://127.0.0.1:8788 \
  --controller-access-token-file ~/.instafy/controller.token
```

The CLI is a thin wrapper around the same helper. It is primarily intended for
manual testing. Pass `--workspace` if you want to override the default workspace directory
(`./.instafy/workspace`). Provide a controller access token (via `--controller-access-token`,
`--controller-access-token-file`, or `CONTROLLER_ACCESS_TOKEN`) and the CLI will mint a short-lived
runtime/origin token automatically. If you already have a token (for example from the controller UI)
you can pass `--origin-token` / `ORIGIN_INTERNAL_TOKEN` / `RUNTIME_ACCESS_TOKEN` instead.

Self-hosted tunnels use `rathole`. Use `--rathole-bin` / `--rathole-state` (or `RATHOLE_BIN` / `RATHOLE_STATE_DIR`) to point
at a specific binary and state dir, or let the helper download/cache it under `~/.instafy/rathole` (override via
`--rathole-cache` / `RATHOLE_CACHE_DIR` and `--rathole-version` / `RATHOLE_VERSION`).
On macOS arm64, the helper falls back to `cargo install rathole` when no prebuilt binary is available.
Private local startup registers the controller-assigned runtime directly and then requests its
tunnel without a hosted allocator lease. Provider-managed runtimes continue to use explicit
lease-bound tunnel credentials.

You no longer need to copy the controller's service token locally. Provide a Supabase session (via
`--supabase-access-token`, `--supabase-access-token-file`, or `SUPABASE_ACCESS_TOKEN`) and the CLI will mint both the
controller user token and the runtime/origin access token automatically, persisting them inside the selected profile until
they expire.

Rathole management helpers are also available:

```bash
# Inspect cached binaries / remove stale versions
instafy-desktop rathole list
instafy-desktop rathole purge --version 0.5.0

# Verify the active binary (falls back to the cache or PATH)
instafy-desktop rathole doctor
```

### Profiles & token exchange

The CLI persists configuration in `~/.instafy/desktop-cli.json`. Use the new profile helpers to
avoid retyping controller URLs and tokens:

```bash
# Inspect or switch profiles
instafy-desktop config list
instafy-desktop config use dev

# Update a profile (values are trimmed; pass an empty string to unset)
instafy-desktop config set --profile dev \
  --space-id 00000000-0000-0000-0000-000000000000 \
  --controller-url http://127.0.0.1:8788 \
  --supabase-access-token "$(cat ~/.instafy/supabase.session)" \
  --clear-origin-token
```

When a Supabase session is stored (or provided via `--supabase-access-token`), the CLI now mints a
runtime/origin token automatically and caches it inside the profile until it expires. Controller
access tokens still work as before. You can inspect the resolved values via
`instafy-desktop config show --profile <name>`.

### Doctor command

Need to confirm your configuration before launching the runtime? Run:

```bash
instafy-desktop doctor --space-id <uuid> --controller-url http://127.0.0.1:8788 \
  --controller-access-token-file ~/.instafy/controller.token
```

The doctor prints the resolved controller URL, token status, and `/health` check so you can
spot missing env vars quickly.

### Runtime lifecycle helpers

Whenever you launch the runtime through `instafy-desktop`, the CLI records the PID and a log file
under `~/.instafy`. You can now manage that process without hunting for it manually:

```bash
# Show the recorded PID, space id, controller URL, and log file
instafy-desktop status

# Gracefully stop the runtime (add --force to fall back to SIGKILL)
instafy-desktop stop [--force]

# Print (or follow) the captured logs
instafy-desktop logs --follow
```

Studio/VS Code integrations can also call `instafy-desktop status --json` for structured output.

### Structured event log

Every `instafy-desktop` run now emits JSON events under `~/.instafy/desktop-events.jsonl`, making it easier for the VS
Code extension (or other tooling) to display progress:

```bash
instafy-desktop events           # pretty-print the latest run
instafy-desktop events --follow  # stream JSON lines in real time
```

### Building the runtime binaries

The helper expects the Rust runtime agent to be built locally. From the repository root:

```bash
node scripts/runtime-cargo.mjs build --locked --manifest-path packages/runtime-agent/Cargo.toml --bins
```

By default the helper looks for `packages/runtime-agent/target/debug/runtime-agent`. Release
builds are also supported (`target/release/runtime-agent`) and can be forced by building with
adding `--release` to that command. Keep the matching `codex-code-mode-host`
executable beside `runtime-agent` for code-mode tool execution.

## Next steps

- Hook the Playwright harness to optionally use this package when running end-to-end
  tests.
- Harden configuration + platform support ahead of packaging a distributable binary.
- Bundle signed binaries for the CLI itself so VS Code can launch it without a dev toolchain.
