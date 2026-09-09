# Instafy Studio Desktop App (Electron)

This package wraps the Instafy Studio web app in an Electron shell.

## Desktop-only features (minimal parity)

- **Notifications**: the Studio UI can call `window.instafyDesktop.notify(...)`.
- **BYOC (Bring Your Own Credentials)**: in the Credits panel, the desktop app can import your local `~/.codex/auth.json` and upload it to the controller (`POST /me/credentials/codex`).
- **Local voice host lifecycle**: the desktop app now treats the shared local speech service and local provider host as an explicit per-machine capability. After the user enables `Enable on this Mac`, Desktop starts and supervises that host automatically. Normal desktop voice use should not require a separate `pnpm dev:speech-service`.
- **Managed transcription install**: on a clean machine, Desktop now auto-installs `uv`, Python, and the transcription runtime into Instafy-managed app data the first time the opted-in local voice host needs them. Desktop now also ships the pinned `uv` installer inside the app bundle, then keeps that installer plus the uv package cache inside the same speech-home so repairs and reinstalls stay app-owned instead of leaning on global caches. The in-app `Repair Desktop host` action remains as the explicit fallback if that managed setup ever drifts.
- **Managed transcription removal**: when Desktop hosting is turned off, the same shared speech card now offers `Remove downloaded runtime` so users can delete the managed uv/Python/whisper/ffmpeg toolchain from Instafy app data instead of leaving it behind.
- **Local voice host smoke**: `pnpm --filter @instafy/desktop-app smoke:voice:host` now proves that launching Desktop is enough to bring the local speech host online.
- **Self-hosted runtime**: the “Self-host a runtime” help dialog includes a start/stop button when running inside the desktop app.
  - The first time you start a runtime, the app may prompt you to select the `runtime-agent` binary (or set `INSTAFY_RUNTIME_AGENT_BIN`).

## Run locally

1. Start the frontend in another terminal:

```bash
pnpm dev:prod
```

2. Launch Electron:

```bash
pnpm --filter @instafy/desktop-app start
```

On macOS, the launcher now opens a patched temporary app bundle so Bluetooth scans can use a
real app-bundle `Info.plist` instead of the stock Electron bundle metadata.

If you want to point the desktop app at production (no local server needed):

```bash
INSTAFY_APP_URL=https://prod.instafy.dev pnpm --filter @instafy/desktop-app start
```

If you need to disable desktop-managed local voice hosting during debugging:

```bash
INSTAFY_DESKTOP_DISABLE_LOCAL_VOICE_HOST=1 pnpm --filter @instafy/desktop-app start
```

When you want to prove the Desktop-managed local voice host without launching the full Studio dev stack, run:

```bash
pnpm --filter @instafy/desktop-app smoke:voice:host
```

That command:

- builds the desktop app
- launches an isolated Electron instance against a tiny local fixture page
- waits for the preload bridge to report both Desktop voice services healthy
- verifies the actual local speech and provider health endpoints
- then shuts the app down cleanly

When you want to prove the clean first-run install path specifically, run:

```bash
pnpm --filter @instafy/desktop-app smoke:voice:host:bootstrap
```

That command:

- launches an isolated Electron instance with a fresh managed speech home
- forces the local speech host to use only the managed toolchain
- waits for Desktop itself to install and warm the managed runtime
- proves the local voice host becomes healthy without a manual repair click

For Chromium/Playwright debugging, extra Electron flags now pass through `start`:

```bash
INSTAFY_APP_URL=https://instafy.dev/studio pnpm --filter @instafy/desktop-app start -- --remote-debugging-port=9337
```

For automation or smoke runs, launch an isolated instance so it does not conflict with a normal
desktop session:

```bash
INSTAFY_APP_URL=https://instafy.dev/studio \
INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES=1 \
INSTAFY_DESKTOP_USER_DATA_DIR=/tmp/instafy-desktop-smoke \
pnpm --filter @instafy/desktop-app start -- \
  --allow-multiple-instances \
  --remote-debugging-port=9337
```

Product-specific native integrations are statically composed by private
distributions. The public desktop package contains only the generic extension
registry and IPC method; it does not discover plugins or require private
integration source during a public build.

You can override the URL Electron loads:

```bash
INSTAFY_APP_URL=https://prod.instafy.dev pnpm --filter @instafy/desktop-app start
```

## Building behind a proxy

Desktop builds download the bundled speech bootstrap installers through `HTTP_PROXY`,
`HTTPS_PROXY`, and `NO_PROXY` when configured (lowercase names take precedence).
Without proxy configuration they connect directly. This works on Node 20 without a
global fetch override or Node startup flags; normal TLS verification and the checked-in
installer SHA-256 trust anchors remain required. The downloader closes its own connections
on success or failure and does not change networking for the running Desktop app.

The focused downloader tests run with `node --test test/speech-bootstrap-proxy.test.mjs`
from this package. They need OpenSSL to generate an ephemeral local HTTPS certificate;
all proxy fixtures use loopback connections and need no external service or credentials.

## Building the runtime binary (dev)

The desktop runtime launcher expects a locally-built `runtime-agent` binary:

```bash
cargo build --manifest-path packages/runtime-agent/Cargo.toml
```

If the desktop app can’t find it automatically, set `INSTAFY_RUNTIME_AGENT_BIN` or select it when prompted.
