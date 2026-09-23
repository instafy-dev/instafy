# Runtime Agent (Rust)

Rust binary that runs inside the hosted runtime container. Responsibilities:

- Register a runtime (`/runtime/register`) and maintain leases/heartbeats.
- Renew that registration proactively: once half of the agent token's remaining
  lifetime has elapsed the agent re-registers with the runtime token minted by the
  previous register call, then swaps to the fresh tokens at the next idle point
  between jobs (an in-flight job is never interrupted). Waiting for a `401` on
  the lease call would be too late — the stored runtime token expires at the
  same time as the agent token, and re-registration would fail forever.
- Execute Codex workflows (headless) for each leased job.
- Collect Codex event logs and return artifacts via `/agent/complete`.
- Stop per-job heartbeat and secret-refresh requests when cleanup begins, including requests
  awaiting an HTTP response, so completed jobs cannot block the next lease poll.

## Current state

- The agent now embeds `codex-core` + `codex-exec` directly. We run conversations in-process, collect streaming events via the JSONL event processor, and surface the final assistant JSON without spawning the CLI.
- Plan / approval flows are unimplemented placeholders and will be wired once Codex events feed into progress reporting.
- Credits are still handled by the controller/proxy; the runtime will forward proxy metadata when those APIs land.

## Runtime images (base vs webdev)

The canonical `docker/runtime/Dockerfile` defines multiple runtime image targets so we can keep the default image small and opt into heavier toolchains only when needed:

- `runtime` (default / base): minimal Debian image with `runtime-agent` + `rathole`.
- `runtime-webdev`: Playwright image + `runtime-agent` + `rathole` + Node tooling (includes `npm/npx`, enables `corepack` for `pnpm`, and installs `@instafy/cli`).

Build locally:
- Base: `pnpm build:image:agent`
- Webdev: `pnpm build:image:agent:webdev`

The Debian base target explicitly refreshes gzip, PCRE2 and SQLite alongside
Chromium and checks committed minimum security versions. Installing only their
dependents can leave vulnerable packages inherited from the pinned base image.
The final image must still pass the publication vulnerability and secret scan;
version-floor checks are not a substitute for scanning.

## GHCR publication

The manual publication workflow builds both targets for `linux/amd64` and
`linux/arm64`. Deployments and hosted compose consumers must use the
`ghcr.io/instafy-dev/instafy-runtime-agent@sha256:...` reference reported in
the workflow summary. The `latest` and `webdev` convenience tags are only
updated when the human running the workflow explicitly requests it.

## Environment knobs

- `CONTROLLER_BASE_URL` — controller root URL (defaults to `http://host.docker.internal:8788`).
- `CONTROLLER_JWKS_URL` — controller JWKS endpoint used to verify controller-issued agent tokens. Defaults to `<CONTROLLER_BASE_URL>/.well-known/jwks.json`.
- `CODEX_DISABLED` — set to `1`/`true` to disable Codex automation (useful for smoke tests that stub job execution).
- `CODEX_MODEL`, `CODEX_MODEL_PROVIDER` — optional overrides for the model slug or provider id used by Codex.
- `CODEX_RUNTIME_REASONING_EFFORT` — explicit reasoning effort for runtime runs (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; choose a value supported by the selected model and proxy). A valid setting takes precedence over job heuristics, including feature jobs and retries. When unset or invalid, the runtime retains the job's effort selection or defaults to `low`. A controller-supplied `CODEX_AGENT_REASONING_EFFORT` override remains authoritative.
- `CODEX_PROFILE` — optional profile from the runtime home's `config.toml` used when loading configuration.
- Runtime configuration is loaded from `CODEX_HOME` when explicitly configured, otherwise from the workspace's `.codex` directory. Desktop jobs do not implicitly load the computer owner's Codex configuration, plugins, or MCP connections. Configure runtime integrations in that runtime home.
- `CODEX_SANDBOX_MODE` — choose `read-only`, `workspace-write` (default), or `danger-full-access` when overriding the sandbox.
- `CODEX_LINUX_SANDBOX_EXE` — optional path to the hardened sandbox binary (mirrors the CLI flag).
- `CODEX_BASE_INSTRUCTIONS` — inline override for Codex base instructions.
- `CODEX_INCLUDE_PLAN_TOOL`, `CODEX_INCLUDE_APPLY_PATCH_TOOL`, `CODEX_INCLUDE_VIEW_IMAGE_TOOL`, `CODEX_SHOW_RAW_AGENT_REASONING`, `CODEX_ENABLE_WEB_SEARCH` — boolean toggles (`true`/`false`). Plan/apply_patch/view_image default to `true` when unset so the runtime exposes the full toolbelt out of the box.
- `ORIGIN_ID`, `ORIGIN_LEASE_ID`, `RUNTIME_ACCESS_TOKEN` (also exported as `ORIGIN_INTERNAL_TOKEN` for compatibility), `ORIGIN_MODE`, `ORIGIN_PROTOCOLS`, `ORIGIN_METADATA` — supplied by the controller so the agent can register the filesystem origin via `/origin/register`. These are required for every runtime launch.
- `ORIGIN_MODE`, `ORIGIN_PROTOCOLS`, `ORIGIN_ENDPOINT`, `ORIGIN_DEVICE_ID`, `ORIGIN_METADATA` — optional hints forwarded to the controller when registering the origin instance. Defaults mirror the desktop runtime (`mode=desktop`, `protocols=http`).
- `INSTAFY_PERSONAL_BROWSER_CONTROL_URL`, `INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN`, `INSTAFY_PERSONAL_BROWSER_PROJECT_ID` — an all-or-nothing, short-lived capability supplied by the Electron host to its desktop runtime. When present for a Personal Browser turn, the runtime exposes only the native browser's token-authenticated high-level MCP tools (`status`, `snapshot`, `navigate`, `click`, `type`, `press`, `scroll`, and `request_human_input`) instead of Playwright/CDP. Manual-input handoff revokes this capability and requires a fresh turn after the user finishes. Never log or persist the token. Hosted runtimes must not receive these values.
- `INSTAFY_RUNTIME_AGENT_BIN` — absolute path to the current runtime-agent executable, set by the desktop launcher for its packaged Personal Browser client path; the model-facing turn uses the bounded MCP server rather than shell commands.
- Owner-local browser observation (optional, self-hosted Linux hosts only): run the runtime agent as a non-root account with empty inherited, permitted, effective, and ambient Linux capability masks, then set `INSTAFY_LOCAL_BROWSER_ENABLED=1` together with absolute paths in `INSTAFY_LOCAL_BROWSER_PLAYWRIGHT_PATH`, `INSTAFY_LOCAL_BROWSER_CHROMIUM_PATH`, and `INSTAFY_LOCAL_BROWSER_EGRESS_PROXY_PATH`. `INSTAFY_LOCAL_BROWSER_NODE_PATH` is optional when `node` is on `PATH`. The host owner must provision all configured code/executables and their ancestors as root-owned and not group- or world-writable; the Playwright package and Chromium directory are checked recursively and may not contain symlinks. The runtime advertises `localBrowser` and installs the read-only `instafy_local_browser.observe` MCP tool only after every required path validates. It re-enters the already-running runtime image through `/proc/self/exe`, launches a fresh sandboxed headless browser per call, forces all Chromium traffic through the hardened public-network egress proxy, and can save PNGs only below the active workspace's `artifacts/browser/` directory. It has no stored login state or interaction/arbitrary-JavaScript tools and is not Shared Browser. These checks protect the observer from direct modification by an ordinary unprivileged account; they do not turn a self-hosted runtime with passwordless sudo, a root-equivalent container socket, or another privilege-escalation path into a host sandbox.
- Tunnel helpers:
  - `RATHOLE_BIN`, `RATHOLE_STATE_DIR` — rathole executable + state directory for self-hosted tunnels.
  - `RATHOLE_USE_SUBCOMMANDS` — set to `1` to force legacy `rathole client -c` CLI (defaults to auto-detect/new style).
  - Hosted runtime images include `rathole` in `/usr/local/bin` so self-hosted tunnels work out of the box.

Proxy routing (burn/refund) still relies on the shared runtime proxy. Set the proxy variables documented in `docs/Architecture.md` to steer Codex traffic through it.

See `TODO.md` for upcoming work: streaming progress, implementing plan/approval, and tying into credit accounting.

## Routing evidence

Ordinary routing receives sanitized current-conversation history. Required prior-context
retrieval and fresh workspace observations are tracked independently from successful command
receipts. The existing bounded recovery attempt preserves permissions and output format while
retaining evidence from the first attempt. See [Execution Evidence and Recovery](../../docs/Multi-Agent-Evaluation.md#execution-evidence-and-recovery)
for receipt limitations and compatibility behavior.

## Realistic browser-skill simulation (local Codex auth)

Use this when iterating browser skills before release. It runs a live runtime-agent apply job through the local proxy, loading credentials from `~/.codex/auth.json`.

```bash
cd packages/runtime-agent
RUST_MIN_STACK=33554432 \
	RUN_LIVE_BROWSER_SIM_TEST=1 \
	LIVE_BROWSER_SIM_PROMPT='Open a browser session and go to example.com' \
	LIVE_BROWSER_SIM_RUNTIME_FLAVOR=webdev \
	LIVE_BROWSER_SIM_EXPECT_PLAYWRIGHT_CLI=1 \
	CODEX_RUN_TIMEOUT_SECONDS=600 \
	cargo test codex_proxy_live_browser_prompt_simulation -- --nocapture
	```

Useful env toggles:

	- `LIVE_BROWSER_SIM_RUNTIME_FLAVOR=base|webdev` — test runtime-flavor-specific behavior.
	- `LIVE_BROWSER_SIM_PROMPT='...'` — exact user prompt to simulate.
	- `LIVE_BROWSER_SIM_EXPECT_PLAYWRIGHT_CLI=1` — assert at least one Playwright CLI command execution was emitted.
	- `LIVE_BROWSER_SIM_EXPECT_PROVIDER='playwright-browser-session-direct'` — assert selected provider path.
- `LIVE_BROWSER_SIM_EXPECT_HANDOFF=1` — require one `request_browser` card when running without an interactive browser attached (use `LIVE_BROWSER_SIM_RUNTIME_FLAVOR=base`). Use `LIVE_BROWSER_SIM_EXPECT_LOCATION=device|workspace` when testing an explicit location choice; otherwise it expects `auto`. This checks a real model's capability handoff, not browser execution or the Studio button.
- `CODEX_DEBUG_REQUEST_TOOLS=1` — print the exact tool names sent to the model.
- `CODEX_DEBUG_MCP_PREFLIGHT=1` / `CODEX_DEBUG_BROWSER_EVENTS=1` — log MCP startup + browser turn events.

When the run fails, the test logs structured failure artifacts (including `codex/run-log` tail events) to make skill iteration concrete.

Direct Codex probe (outside `run_apply_job`) for isolating MCP wiring vs orchestration behavior:

```bash
cd packages/runtime-agent
RUST_MIN_STACK=33554432 \
RUN_LIVE_BROWSER_DIRECT_PROBE_TEST=1 \
LIVE_BROWSER_DIRECT_EXPECT_PLAYWRIGHT_CLI=1 \
LIVE_BROWSER_DIRECT_RUNTIME_FLAVOR=webdev \
LIVE_BROWSER_DIRECT_TIMEOUT_SECONDS=600 \
CODEX_RUN_TIMEOUT_SECONDS=600 \
cargo test codex_proxy_live_browser_prompt_direct_codex_client_probe -- --nocapture
```

Optional toggles:

- `LIVE_BROWSER_DIRECT_RUNTIME_FLAVOR=base|webdev`
- `LIVE_BROWSER_DIRECT_EXPECT_PLAYWRIGHT_CLI=1`
- `LIVE_BROWSER_DIRECT_PROMPT='...'` — override the default strict browser prompt.

Quick strict probes (from repo root):

```bash
pnpm test:runtime:browser:strict
pnpm test:runtime:browser:direct
```

Both commands assert that at least one Playwright CLI command execution is emitted (detected via `connectOverCDP` in `command_execution` events).
If they fail with `playwright_cli_calls=0`, the runtime currently has browser wiring/auth/provider behavior that still needs fixing.
