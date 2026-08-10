# Developer Environment Guide

This guide is part of the [Instafy documentation hub](docs/README.md). Update it whenever the local workflow changes.

This guide walks through running Instafy Studio locally, exercising the controller-backed prompt
and filesystem loop, and validating public database migrations.

---

## 1. Prerequisites

Install the tooling below before you start:

- **Node.js** 18 or newer (ships with a compatible `npm`)
- **Supabase CLI** `>=1.165` (requires Docker when you run `pnpm supabase:up`, which wraps `supabase start`)
- **Git** and a terminal with `bash`/`zsh`
- *(Optional)* **Ollama** for local LLMs
- **Rust toolchain** (stable) for the controller and runtime binaries. The desktop shell is Electron.

> Tip: the project uses ES modules; ensure your Node install is recent enough to support them.

### Protected local environment files

Instafy can keep ignored local configuration outside the checkout. Set one absolute directory and
mirror each env file's repository-relative path below it:

```bash
export INSTAFY_ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/instafy/env"
umask 077
mkdir -p \
  "$INSTAFY_ENV_DIR/docker" \
  "$INSTAFY_ENV_DIR/packages/frontend" \
  "$INSTAFY_ENV_DIR/supabase"
chmod 700 \
  "$INSTAFY_ENV_DIR" \
  "$INSTAFY_ENV_DIR/docker" \
  "$INSTAFY_ENV_DIR/packages" \
  "$INSTAFY_ENV_DIR/packages/frontend" \
  "$INSTAFY_ENV_DIR/supabase"
```

For example, `.env.supabase` becomes `$INSTAFY_ENV_DIR/.env.supabase` and
`docker/.env.local` becomes `$INSTAFY_ENV_DIR/docker/.env.local`. The local launch, build,
Capacitor, Stripe, Hetzner, Playwright, and runtime-stack helpers resolve this convention
directly; no `direnv` installation is required. Keep the directory and each subdirectory mode
`0700`, each file mode `0600`, and do not use symlinks or hard links. The configured root must
already exist and pass those checks before any helper will use it. Run `pnpm env:check` after
migration. The check reads metadata only: it never reads or prints values, and it fails while a
legacy in-repository copy remains. It also checks generated credential-bearing files such as
`.env.supabase.local`, `.env.user`, and `packages/frontend/.env.local` whenever they exist;
the shared writers refuse unsafe destinations before writing.

---

## 1.5 Controller + Supabase quick start

Need to run the Rust controller (or the tunnel-enabled Playwright suite) locally? Use this loop:

1. Run `pnpm test:controller` to exercise the controller harness single-threaded. The wrapper auto-resolves `TEST_DATABASE_URL` from the local Supabase stack and starts Supabase for you when needed.
2. (Optional) Export the self-hosted tunnel broker env vars (`TUNNEL_BROKER_BASE_URL`, `TUNNEL_BROKER_TOKEN`, etc.) if you are running tunnel grant/desktop-origin tests.
3. When you are finished, `pnpm supabase:down` tears the containers down if you no longer need the local database.
4. Providers: the controller now loads runtime providers from the `runtime_providers` table (seeded by a migration). `pnpm stack:up` starts a local external_http provider (wrapping the docker allocator) unless you set `DEV_PROVIDER_ENDPOINT`; it seeds three provider rows (`runtime`, `instafy-cloud`, `self-hosted`) pointing at that endpoint with `DEV_PROVIDER_AUTH_TOKEN` (defaults to `dev-provider-token`). You can also seed manually with `pnpm providers:seed:default`. Admin API (service-role only): `GET /providers` (list) and `POST /providers` (upsert: `id`, `displayName`, `kind`, optional `ownerOrgId`, `allowedOrgIds`, `endpoint`, `authToken`, `metadata`). Metadata supports allocator-specific config (e.g. `dockerComposeFile`, `dockerService`, `dockerProjectPrefix`, `dockerRepoHost`, `dockerCodexRoot`, `hetznerToken`, `hetznerServerType`, `hetznerImage`, `hetznerLocation`, `hetznerNetworkId`, `hetznerFirewallId`, `hetznerUserData`).

---

## 2. Install Dependencies

```bash
pnpm install
```

This pulls both runtime dependencies (React, Supabase client, Zustand) and dev tooling (Vite, Tailwind, ESLint). The command also installs the Supabase CLI locally if you added it as a dev dependency.

### Build supporting binaries

The Playwright test harness now launches the **desktop runtime agent** by default. Build the Rust
runtime agent once after cloning the repository, then build the Node wrapper so Playwright can
invoke it:

```bash
cargo build --manifest-path packages/runtime-agent/Cargo.toml
pnpm --filter @instafy/desktop-runtime-agent build
```

> If you rebuild the Rust agent with `--release`, the wrapper automatically falls back to the
> release binary.

### Mobile (Capacitor) push notifications

When you add/update Capacitor plugins (for example `@capacitor/push-notifications`), resync the native projects:

```bash
pnpm -C packages/frontend cap:sync
```

Remote iOS push also requires enabling the Push Notifications capability in Xcode and configuring APNs credentials (see `.env.supabase.example` for controller-side env vars).
>
> Need to exercise the CLI-managed desktop runtime (with tunnel download + Supabase token minting)?
> Export `PLAYWRIGHT_DESKTOP_RUNTIME_MODE=cli` before running Playwright and the harness will
> call `pnpm --filter @instafy/cli dev -- runtime start …` instead of the helper. This path
> mirrors the developer-facing CLI and ensures the smoke test covers the same workflow.
> You can also smoke the CLI tunnel directly with `pnpm test:cli:tunnel` (requires `TUNNEL_BROKER_BASE_URL` + the local stack up via `pnpm controller:up`), or run `pnpm test:cli:tunnel:e2e` to boot the local broker + controller automatically.

#### Desktop runtime flow (CLI + mobile)

If you want to start a project from a local folder and chat against that desktop runtime (including from another device):

```bash
# 1) Login / obtain a Supabase session token (or Studio access token)
export SUPABASE_ACCESS_TOKEN=...   # or INSTAFY_ACCESS_TOKEN=...

# 2) Create/link a space and write .instafy/space.json in your folder
pnpm --filter @instafy/cli dev -- space init --path /path/to/workspace --server-url http://127.0.0.1:8788 --access-token "$SUPABASE_ACCESS_TOKEN"

# 3) Start the desktop runtime with tunnel (requires tunnel broker configured on the server)
pnpm --filter @instafy/cli dev -- runtime start --space "$(cat /path/to/workspace/.instafy/space.json | jq -r .spaceId)" --server-url http://127.0.0.1:8788 --supabase-access-token "$SUPABASE_ACCESS_TOKEN"

# 4) Open Studio on desktop or mobile, sign in with the same account; the server will prefer the desktop runtime for that space.
```

Notes:
- `space init` and `runtime start` also expose programmatic exports if you want to call them from other tooling instead of shelling out.
- The CLI mints scoped runtime/origin tokens from your Supabase/controller session; no service-role tokens are needed in clients.
- The CLI logs state to `~/.instafy/cli-runtime-state.json`; it is cleared automatically in tests but you can `instafy runtime stop` to reset it manually.

---

## 3. Environment Variables

### Frontend `.env`

Copy the example file and update with your Supabase project credentials when you are ready to connect to a real backend.

```bash
cp packages/frontend/.env.example packages/frontend/.env
# edit packages/frontend/.env to add VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
```

### Server and test env

The local stack generates its ignored server configuration under `docker/`. Keep controller,
proxy, service-role and provider credentials in server-only env or a secret manager; never
prefix them with `VITE_`. The retired Supabase Edge Function and workflow-dispatch env template
is not part of the public distribution.

> Do **not** commit `.env`, `.env.dev.local`, or production secrets. They are already gitignored.

### Tunnel broker env (self-hosted tunnels)

Instafy uses a self-hosted tunnel broker (rathole + DNS/Traefik ingress) for tunneled desktop/origin endpoints.

To enable tunnel issuance locally:

1. Start the local broker ingress stack:
   ```bash
   pnpm -C packages/tunnel-broker ingress:up
   ```
2. Point the controller at it:
   ```bash
   export TUNNEL_BROKER_BASE_URL=http://127.0.0.1:8082
   export TUNNEL_BROKER_TOKEN=dev-token
   ```
3. (Optional) tweak runtime tunnel refresh:
   - `ORIGIN_TUNNEL_REFRESH_MARGIN_SECONDS` (default `60`)

The CLI/desktop runtime will auto-download `rathole` when it is not available on `PATH` (cached under
`~/.instafy/rathole`, override with `RATHOLE_CACHE_DIR` / `RATHOLE_VERSION`). To force a specific build, set
`RATHOLE_BIN=/absolute/path/to/rathole`.

---

## 4. Pick Your Backend Mode

Instafy Studio now always targets a real Supabase instance (hosted or local). Configure the option that fits what you need to test:

### 4.1 Hosted Supabase project

1. Provision a Supabase project and run the migrations / functions (see `docs/Local-Dev.md`).
2. Populate `$INSTAFY_ENV_DIR/.env.supabase` with your project credentials:
   ```bash
   VITE_SUPABASE_URL=https://<your-project>.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOiJI...
   ```
   Copy the **anon** key from Supabase Dashboard → Project Settings → API → Project API keys (don’t mint your own JWT).
3. Start the app with `pnpm dev` — the Studio will talk to the hosted project.
4. Run Playwright against the hosted stack:
   ```bash
   pnpm test:e2e
   ```
   The helper expects `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to be present in the environment when it runs.

### 4.2 Self-hosted Supabase (Docker)

1. Launch the local stack via the helper (it mirrors migrations and prints the recommended controller-test command):
   ```bash
   pnpm supabase:up
   ```
   Run `pnpm supabase:down` when you’re finished to stop the containers.
3. Copy the generated URL/key into `.env` (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`).
4. Seed a development org (optional, helpful once RLS is on):
   ```bash
   # Find the local database URL
   npx supabase status --local
   # Copy the `DB_URL` value and run:
   psql "$DB_URL" -f supabase/scripts/seed_dev_org.sql
   ```
5. Start the app with `pnpm dev`.
6. Run the Playwright suite (the helper boots Supabase + controller automatically and tears them down afterwards):
   ```bash
   pnpm --filter @instafy/frontend test:e2e
   ```
   Under the hood Playwright calls `node scripts/run-e2e-dev.mjs controller:start`. If you only need the database (for `cargo test`, for example), run `pnpm supabase:up` instead of the full stack helper:
   ```bash
   pnpm stack:up               # Supabase + controller (+ proxy)
   ```
   
   **Testing the Studio BYOC onboarding flow locally**
   
   By default `pnpm stack:up` starts the proxy in controller-backed BYOC mode. It leaves `~/.codex/auth.json` on your machine for the Studio/Desktop per-user credential flow, and `/healthz` reports `backend=remote_dynamic` with `requiresCredential=true`.
   
   Start the normal onboarding flow with:
   ```bash
   pnpm stack:down
   pnpm stack:up
   pnpm dev
   ```
   The proxy uses the isolated `tmp/proxy-codex-byoc/` directory and does not mirror the machine credential. Connect the existing Codex login through the visible credential onboarding UI.

   For isolated legacy debugging only, opt into a machine-wide static proxy explicitly:
   ```bash
   pnpm stack:down
   RUNTIME_PROXY_STATIC_AUTH=1 pnpm stack:up
   ```
   Static mode may use `OPENAI_API_KEY` or mirror `~/.codex/auth.json` into `tmp/proxy-codex/`; do not use it for multi-user or onboarding validation.
   
   If you already have a default AI credential connected for your dev user, the chat won’t show the onboarding gate; revoke it in Profile settings (AI credentials) or sign in as a fresh user to test first-run onboarding.

   Run `pnpm runtime:down` when you’re finished; it tears down the controller stack and Supabase services started by `pnpm stack:up`. Set `KEEP_RUNTIME_STACK=1` before running the tests if you want to skip teardown for iterative debugging.

### 4.3 Controller integration tests

Need to exercise the runtime-controller Rust tests against a real Postgres? Run:

```bash
pnpm test:controller
pnpm test:controller conversation_message_routes_preserve_inline_reference_content -- --nocapture
```

The wrapper auto-populates `TEST_DATABASE_URL` from the local Supabase stack and will start Supabase for you if it is not already running. If you are exercising tunnel issuance, export `TUNNEL_BROKER_BASE_URL` and `TUNNEL_BROKER_TOKEN` first. Stop the stack afterwards with `pnpm supabase:down` if you no longer need it.

---

## 5. Controller APIs (workspace + conversations)

The Studio now talks to the **runtime controller** for prompt runs, SSE, and workspace files. Set the controller base URL in your `.env`:

```bash
VITE_CONTROLLER_URL=https://controller.dev.your-domain.com
```

Hosted browser builds treat that configured URL as the controller authority and ignore controller
URL overrides from the page query, browser globals, and session storage. Localhost/development and
native harnesses may use a custom `controllerUrl` only when they also provide an explicit
`controllerAccessToken`; a custom controller never receives the signed-in user's ambient Supabase
session. Studio sends that token in the `Authorization` header, including for `/events`, rather than
putting it in a request URL. A controller URL and credential are bound together for the lifetime of
the page; changing or rejecting an override scrubs its query parameters and reloads before any new
controller request can start.

Personal Browser requires the normal ambient signed-in session and is unavailable while a fixed or
custom controller credential is active. Desktop runtimes remember whether their launch credential
was fixed or ambient. Only a packaged first-party build connected to the pinned production
controller may refresh an ambient credential, and that refresh remains bound to the same user;
fixed credentials are never replaced from the visible browser session.
Desktop's native runtime and speech-tunnel bridges enforce that controller boundary again before
using any renderer-supplied bearer: packaged builds accept only the pinned production controller,
while unpackaged development builds accept only origin-only loopback controllers.

In local development you can run the controller via `cargo run` (see `packages/runtime-controller/README.md`) or point
at a shared dev instance. Large artifacts (images/logs) should be written to the shared workspace (local dir/EFS) and
fetched through the controller `/fs/*` endpoints rather than Supabase Storage. When running the controller locally,
set `WORKSPACE_ROOT=/absolute/path/to/workspaces` so each project maps to `<WORKSPACE_ROOT>/<project_id>`.

### Desktop runtimes & origins

- Desktop agents always boot the filesystem origin server. The controller injects `ORIGIN_ID`, `ORIGIN_LEASE_ID`,
  `ORIGIN_MODE`, `ORIGIN_PROTOCOLS`, and `ORIGIN_METADATA` into the container so the agent can register itself through
  `POST /origin/register`.
- Provide `RUNTIME_ACCESS_TOKEN` (minted via `POST /projects/:id/runtime/token`) and ensure the controller is started with
  `RUNTIME_SIGNING_PRIVATE_KEY` / `RUNTIME_SIGNING_PUBLIC_KEY` so access tokens can be minted when Studio or Playwright calls
  `/projects/:id/access_token`.
- The `instafy-desktop` helper mints short-lived runtime tokens via
  `POST /projects/:id/runtime/token`. Export `CONTROLLER_ACCESS_TOKEN` (or pass
  `--controller-access-token`) to exchange a Supabase/Instafy bearer token for the runtime/origin credential automatically.
- Playwright’s desktop origin harness no longer spins up a shim binary. It calls `/runtime/ensure`, waits for the
  controller to report the origin endpoint, and drives presence beats via `/projects/:id/origin/presence/beat`. Make sure
  your `.env` exposes `PLAYWRIGHT_CONTROLLER_URL` and a `SUPABASE_SERVICE_ROLE_KEY` so the helper can mint tokens.
- `rathole` is downloaded automatically per platform into `~/.instafy/rathole/<version>` (set
  `RATHOLE_CACHE_DIR` / `RATHOLE_VERSION` to override). Supply `RATHOLE_BIN` if you want to force a specific build.

> Supabase edge functions for generation, build dispatch, GitHub sync, and suggestions have been removed. The runtime controller now owns prompt runs and publish flows outright, and credits are exposed directly via `/credits`.

---

## 6. Web App

```sh
pnpm dev
```

Vite dev server on http://localhost:5173

Hot reload enabled

## 7. Browser Editing with WebContainers (optional but recommended)

1. Install the API dependency (already checked in, but rerun if you reset `node_modules`):
   ```bash
   pnpm add -D @webcontainer/api
   ```
2. Ensure cross-origin isolation so WebContainers can boot. In `vite.config.ts`:
   ```ts
   export default defineConfig({
     server: {
       headers: {
         'Cross-Origin-Opener-Policy': 'same-origin',
         'Cross-Origin-Embedder-Policy': 'require-corp'
       }
     }
   });
   ```
   Mirror the same COOP/COEP headers on the production Studio origin.
3. Enable the driver:
   ```bash
   VITE_USE_WEBCONTAINERS=1
   ```

The Studio now ships with a prebuilt React/Vite snapshot (deps + template). On first run we expand it inside WebContainers, cache the exported tree in `localStorage`, and reuse it on subsequent runs so installs are skipped. Each prompt overwrites `App.tsx`, runs `pnpm run generate` + `pnpm run build`, and streams logs into the chat. If the runtime can’t start, a toast appears and we fall back to the Supabase edge driver automatically.

See `docs/Architecture.md` for WebContainer architecture details and follow-up tasks (snapshot persistence, richer logging).

Secrets never live in the browser container. Use only public data (e.g. Supabase anon key).

## 8. Module-driven Content

Instafy keeps project content intentionally open-ended. Modules define their own schema via `packages/frontend/src/data/modules.ts`, then map settings into the generic `state.content` object using `contentPath`.

- Add or edit module settings in that file; avoid hard-coding industry-specific fields in global types.
- When reading from `state.content`, use optional chaining or sensible fallbacks (e.g. `content.heroImage ?? defaultImage`).
- Preview components and tests should tolerate missing fields, since modules populate them lazily.

This pattern lets new verticals ship as module packs without touching shared typings.

## 9. AI Providers

Studio sends model work through the runtime controller and AI proxy. Managed-AI configuration is
server-side (`MANAGED_AI_MODEL_ID` plus the proxy configuration); provider credentials must never
be placed in Vite variables. Users can connect supported BYOC credentials through Studio or the
Desktop credential flow.

The old Ollama/OpenAI Supabase Edge Function generation lane has been removed; its legacy env
template is not exported and those variables are not read by the controller-backed path.


## 10. GitHub Version Control (optional)

1. Create a GitHub App with repository permissions for the organisation where Instafy should provision code.
2. Add the credentials to `supabase/.env.dev.local`:
   ```bash
   GITHUB_APP_ID=...
   GITHUB_APP_PRIVATE_KEY=<paste the GitHub App private key from your password manager or secret store>
   GITHUB_APP_CLIENT_ID=...
   GITHUB_APP_CLIENT_SECRET=...
   ```
3. Version Control currently runs in local-only mode; GitHub sync is disabled until conversational modules own that flow.

---



## 11. Troubleshooting

| Issue | Fix |
| ----- | ---- |
| `supabase start is not running` | Run `pnpm supabase:up` (wraps `supabase start --debug`) or inspect `pnpm supabase:down && pnpm supabase:up` for fresh logs. |
| `Ollama API error` | Ensure `ollama serve` is running and the model is pulled; verify `OLLAMA_API_URL`. |
| `GitHub link failed` | Confirm the GitHub App credentials and that the app has access to the target organisation. |
| `Credits panel disabled` | Ensure `VITE_CONTROLLER_URL` is set and the controller is running; sign in so the browser can fetch a Supabase session token for `/credits/status`. |
| Dev server port conflict | Pass `--host`/`--port` to `vite` or set `PORT` env variable. |
| Missing packages | Re-run `pnpm install`; the repo relies on ESM-compatible versions of dependencies. |

---

## 12. Credits, Billing & Domains

Org credits live behind the runtime controller’s `/credits` API. The Studio UI reads that state directly from the controller, and `/billing/checkout` now supports multiple processors:

- `dev` shortcut for free plans (immediate redirect to your success URL).
- `stripe` processor that creates Stripe Checkout Sessions.

### Stripe setup (local)
1. Copy `.env.stripe.example` to `$INSTAFY_ENV_DIR/.env.stripe` with mode `0600`.
2. Fill in `STRIPE_SECRET_KEY`, `STRIPE_API_BASE_URL` (usually the default), a `STRIPE_PRICE_ID_<PLAN>` entry for every paid SKU (e.g., `STRIPE_PRICE_ID_PRO=price_123`), and `STRIPE_WEBHOOK_SECRET` so the controller can verify Stripe events.
3. The local stack and Stripe helpers read `$INSTAFY_ENV_DIR/.env.stripe`; export the same
   server-only values in the controller environment when launching the controller separately.
4. Create a Stripe webhook endpoint that points at `https://<controller-host>/billing/webhooks/stripe` and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
   - Local dev (recommended): use Stripe CLI forwarding:
     - Set `STRIPE_PRODUCT_ID_PRO` / `STRIPE_PRODUCT_ID_SCALE` in the external `.env.stripe`.
     - `pnpm stripe:sync-env` (updates that external file when `INSTAFY_ENV_DIR` is set)
     - `pnpm stripe:listen` (forwards Stripe events to `http://127.0.0.1:8788/billing/webhooks/stripe`)
     - Alternative: expose your controller with `pnpm tunnel:webhook --port 8788` and use the printed URL in the dashboard.
   - Events to enable: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.

#### Stripe E2E (optional, recommended before launch)
This verifies the full flow our app relies on: checkout session creation → webhook confirmation → org credits update.

1. Start the local stack: `pnpm stack:up` (or `pnpm live:up` if you also want tunnel broker ingress available).
2. Enable and run the Stripe Playwright test:
   `PLAYWRIGHT_STRIPE_E2E=1 pnpm --filter @instafy/frontend exec playwright test tests/playwright/payments`
3. In your own CI, configure the required Stripe test values through its protected secret store; do not commit or script-upload a live `.env.stripe`.

Notes:
- The controller needs a **Price ID** (`price_...`) for the Pro plan. A Stripe **Product ID** (`prod_...`) is not sufficient.
- The Stripe payments suite also verifies the “Manage subscription” flow by opening a real Stripe Billing Portal session when a subscription is active.
- To test real Stripe → local webhook delivery without Stripe CLI, expose your controller with `pnpm tunnel:webhook --port 8788` and use the printed URL as the webhook destination.

#### Webhook tunnel (local dev)
If the webhook sender cannot reach `127.0.0.1`, expose the local controller via the self-hosted tunnel stack:

```bash
LIVE_KEEP_UP=1 pnpm test:live
# In another shell:
SERVICE_ROLE_KEY=... pnpm tunnel:webhook --port 8788
```

Use the printed URL as the webhook destination (e.g. `https://<tunnel-host>/billing/webhooks/stripe`). Tear down with `pnpm -C packages/tunnel-broker ingress:down` and `pnpm stack:down` when done.

When running in hosted environments, store the controller secrets in your orchestrator’s secret manager (Fly, Render, AWS, etc.) instead of plain files.

Domain purchase/availability helpers also moved out of Supabase Edge; keep registrar-specific automation in your own service and surface the results back through the controller or Studio as needed.

---

## 12. Useful Scripts

| Command | Description |
| ------- | ----------- |
| `pnpm dev` | Start the React/Vite frontend |
| `pnpm build` | Production build of the frontend |
| `pnpm preview` | Preview the Vite production build |
| `pnpm lint` | Lint TypeScript/React sources |
| `pnpm dev:supabase:release` | Apply SQL migrations to an isolated, non-production linked Supabase project |

Happy building! If you add migrations or scripts, mirror their setup steps here so the rest of the team can iterate quickly.

> **Migration note:** the release script relies on Supabase CLI migrations under `supabase/migrations/`. Convert any ad-hoc SQL in `supabase/sql/` into versioned migrations before shipping.

## 13. Apply Credit Ledger Schema

This repo ships with `supabase/migrations/20250919121107_credit-ledger.sql`. Apply it to your project with:

```bash
npx supabase db push
```

If you need to evolve the schema, generate a follow-up migration:

```bash
npx supabase migration new credit-ledger-update
# edit the generated file with your changes, then push again
npx supabase db push
```

Credits are served by the runtime controller's authenticated `/credits` API; there is no public
`credits` Edge Function to deploy.

> RLS policies for the credit tables are still pending — restrict access to project/org owners before going live.

### Tests

End-to-end UI checks use Playwright. After completing the steps above, run:

```bash
pnpm test:e2e
pnpm test:e2e:supabase
```

`pnpm test:e2e` boots Vite automatically and reuses the server between tests. Use `pnpm test:e2e:headed` for visual debugging.

If a run gets stuck (or you launched it from an IDE and lost the terminal), you can check/kill it via `pnpm test:e2e:status` and `pnpm test:e2e:stop` (the runner writes a pidfile to `tmp/test-e2e.pid`).

`pnpm test:e2e:supabase` resets the local Supabase database, primes the local Supabase URL + anon key + service-role key into the Playwright build/test env, and then delegates to the same root `pnpm test:e2e` runner so schema regressions surface against a fresh local stack.

If the runtime stack is already up (check with `pnpm runtime:status` or `pnpm stack:check`), Playwright now reuses it and skips teardown automatically, so you can iterate quickly without extra flags.
