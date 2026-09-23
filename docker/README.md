# docker/ — Runtime images & local parity

This folder hosts files related to the **runtime container** that executes agent work. The default image is headless: `runtime-agent` orchestrates and the Codex libraries (codex-core/codex-exec) perform the edits. An optional VS Code image (openvscode-server + extension) can be layered on later for premium users.

> You can run a local runtime for parity. Production infrastructure is managed separately; this
> directory documents the portable containerized controller, proxy, Git, origin, and runtime
> services.

## What belongs here

- Dockerfiles for the **codex-runner** image (runtime-agent + embedded Codex crates).
- Optional Dockerfiles/compose overlays for the premium VS Code experience.
- `$INSTAFY_ENV_DIR/docker/.env.local` for local-only environment values. The legacy
  in-checkout path is supported only when `INSTAFY_ENV_DIR` is unset.
- This README and operational docs.

## Quick start (headless codex-core)

1. Ensure your local Supabase (Postgres/auth) is running (`pnpm supabase:up`) and the Rust runtime controller/proxy are available (`pnpm dev:controller`, `pnpm dev:proxy`).
2. Configure an absolute protected env root, then copy the base env file:
   ```bash
   export INSTAFY_ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/instafy/env"
   umask 077
   mkdir -p "$INSTAFY_ENV_DIR/docker"
   chmod 700 "$INSTAFY_ENV_DIR" "$INSTAFY_ENV_DIR/docker"
   install -m 600 docker/.env.example "$INSTAFY_ENV_DIR/docker/.env.local"
   ```
   Edit the external file with values for your environment:
   ```env
   EDGE_URL=http://host.docker.internal:8788
   AGENT_REGISTER_URL=/runtime/register
   CODEX_API_ENDPOINT=http://host.docker.internal:8789/api  # proxy URL
   CODEX_SANDBOX_MODE=workspace-write
   SPACE_ID=<uuid-for-your-test-space>
   RUNTIME_REPO_HOST=$PWD/tmp/runtime-sandbox/$SPACE_ID
   RUNTIME_CODEX_VOLUME=$PWD/tmp/runtime-sandbox/.codex
   SUPABASE_ANON_KEY=<anon key from `supabase status --output env`>
   SUPABASE_SERVICE_ROLE_KEY=<service role key (optional for local dev)>
   ```
   `pnpm stack:up` and direct Compose invocations resolve this path from
   `INSTAFY_ENV_DIR`.
   Validate the complete Compose interpolation using only the committed example:
   ```bash
   pnpm test:self-host:config
   ```
3. Start via helper script (brings up Supabase if needed):
   ```bash
   pnpm stack:up
   # (equivalent to pnpm controller:up)
   ```
4. Submit a prompt (or run `pnpm runtime:test`) to watch the runtime container register and process
   a job. Logs should show **register → lease → codex (embedded) → complete**.

Stop everything with `pnpm runtime:down`, which tears down the controller stack. Check status with `pnpm controller:status` (wraps `docker compose ps` plus `supabase status`).


## Security

- The container holds no long-lived secrets. It receives short-lived agent/proxy tokens from the controller and uses them only against the Axum services.
- GitHub actions remain proxied by Supabase Edge using the GitHub App installation token; the runtime container never talks to GitHub directly.

## Deployment and self-hosting

- `docker/runtime/Dockerfile` is the only runtime-agent image definition. The
  `runtime` and `runtime-webdev` targets can be built for amd64 and arm64.
- Pin hosted/provider launches to an immutable OCI manifest reference, for example
  `RUNTIME_AGENT_IMAGE=<registry>/<organization>/instafy-runtime-agent@sha256:<digest>` and
  `RUNTIME_PROXY_IMAGE=<registry>/<organization>/instafy-openai-proxy-server@sha256:<digest>`.
  `docker/docker-compose.runtime.provider.yml` intentionally has no mutable
  fallback image for either service.
- Local development remains source-built through
  `docker/docker-compose.runtime.yml` and its
  `instafy-runtime-agent:webdev-local` tag.
- A registry account is not required to build the public images. From a clean checkout,
  `pnpm build:images` builds the controller, both runtime flavors, proxy, provider service,
  speech host, tunnel broker, Git edge/shard and origin gateway locally. Individual
  `build:image:*` commands build only the named service. Commands ending in `:push` require
  an explicit reviewed destination tag and are release operations; no build command pushes
  implicitly.
- Use your own infrastructure tooling to provision the controller/proxy, optional warm pool, and
  Git-canonical services.
- Supply server-only Supabase and proxy credentials through your orchestrator's secret store.
  The controller image also requires `USER_TOKEN_SECRET` (`openssl rand -hex 32`) and
  `CREDENTIAL_ENCRYPTION_KEY` (`openssl rand -base64 32`) and refuses to start without them
  outside `DEV_MODE`. When upgrading a controller that ran without them, follow
  [the controller upgrade steps](../packages/runtime-controller/README.md#upgrading-a-controller-without-explicit-secrets)
  first so stored credentials stay readable.
  `PROXY_CREDENTIAL_LEASE_TOKEN` is a controller-to-proxy credential only; never place it in a
  runtime/agent environment.
- Keep runtimes ephemeral (evaporate anytime); canonical workspace state lives in git-canonical (or local-canonical for opt-out users).
