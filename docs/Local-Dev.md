# Local Development

## Start the stack
- Full stack (Supabase + controller + proxy + provider + git-canonical services): `pnpm stack:up`
- Stop everything: `pnpm stack:down`
- The stack stops only the controller and provider it started, by the pids it recorded in
  `tmp/.controller.pid` and `tmp/.provider.pid` (and their process groups' listeners). It never looks a
  process up by name, so another checkout's or project's controller keeps running, even on the same port.
  A recorded pid counts only while it is still that process: one that started after the pid file was
  written holds a reused pid (possibly another project's controller) and is left running.
  A provider already on the port when the stack starts is used as it is and left running on `stack:down`.
- A first `pnpm stack:up` builds the controller and the provider service with Cargo before it starts them,
  which can take several minutes. The wait that follows times only their startup: the controller gets
  `RUNTIME_CONTROLLER_BOOT_ATTEMPTS` one-second attempts (120, or 300 in CI).

### A second stack beside another
A second checkout (a worktree, for example) can run its own Supabase, proxy and provider beside another
stack. The stack never falls back to the default stack's ports for them, but the rest of the machine is
shared unless you move it too.

- Supabase: before anything starts in that checkout, give its `supabase/supabase/config.toml` its own
  `project_id` and its own ports (`[api]`, `[db]` and the others). Keep the edit local and never commit it
  (CI pins the file's hash), and keep it until after that checkout's `pnpm stack:down`, which stops the
  project the file names. Write the ports there as plain numbers: the stack reads only `port = <number>`
  lines, not the CLI's `SUPABASE_*_PORT` variables or `env()` values. The stack, the controller's database
  and the provider seed use the file's `[api]` and `[db]` ports unless `SUPABASE_PROJECT_URL`,
  `SUPABASE_URL`, `DATABASE_URL` or `TEST_DATABASE_URL` name others; for `pnpm dev`, see
  [Frontend](#frontend). Without `psql` on the host, the provider seed runs it in that project's
  database container (`supabase_db_<project_id>`) and refuses a database on another port unless
  `SUPABASE_DB_CONTAINER` names the container.
- Proxy: `PROXY_PORT` (8789 by default) moves the host proxy. A `PROXY_BASE_URL` you set must use the same
  port.
- Provider: `PROVIDER_PORT` (9090 by default) moves the provider service, which the stack starts with
  `BIND_ADDR=0.0.0.0:<PROVIDER_PORT>`. A `BIND_ADDR` you set must be `0.0.0.0`, `127.0.0.1` or `[::]` on that
  port. `pnpm stack:up` refuses a value that is not a port before it starts anything.
- Shared unless you move it:
  - Startup prunes every compose project named `instafy-runtime-*`: set `RUNTIME_PRUNE_ON_UP=0`, or your
    own `DOCKER_PROJECT_PREFIX`.
  - Redis, the git services and the static-auth proxy run in the compose project `instafy-runtime`, which
    `pnpm stack:down` removes. Set your own `COMPOSE_PROJECT_NAME` (not starting with `instafy-runtime-`)
    and `REDIS_PORT`, and `GIT_CANONICAL=0`, since the git services expect the controller on 8788.
  - There is one tunnel broker per machine: set `RUNTIME_SKIP_TUNNEL_BROKER=1`.
  - A controller already serving on `CONTROLLER_PORT` (8788) is used, whoever started it. Moving it takes a
    fresh `docker/.env.local`.
  - With `INSTAFY_ENV_DIR` set, every checkout shares `docker/.env.local` and the other env files: leave it
    unset, or give each checkout a directory of its own.
  - Image tags such as `runtime-agent:local` are shared.

For example, with no other controller on 8788:

```bash
RUNTIME_PRUNE_ON_UP=0 COMPOSE_PROJECT_NAME=instafy-second REDIS_PORT=16379 GIT_CANONICAL=0 RUNTIME_SKIP_TUNNEL_BROKER=1 PROXY_PORT=18789 PROVIDER_PORT=19090 pnpm stack:up
```

Give `pnpm stack:check`, `pnpm runtime:status` and `pnpm stack:down` the same settings.

## Git-canonical (local git service)
Git-canonical services (git-edge + git-shard-0 + origin-gateway) are on by default; set
`GIT_CANONICAL=0` to opt out:
- `GIT_CANONICAL=0 pnpm stack:up`

Defaults:
- `git-edge`: `http://127.0.0.1:8080` (override with `GIT_EDGE_PORT`)
- `origin-gateway`: `http://127.0.0.1:54333` (override with `ORIGIN_GATEWAY_PORT`)
- Repos stored under `tmp/git-repos/` (override with `GIT_REPO_VOLUME`)
- `git-edge` auth is enabled by default (`GIT_EDGE_SKIP_AUTH=0`); run `instafy login` to set up git auth (credential helper) for clone/push, or set `GIT_EDGE_SKIP_AUTH=1` for insecure local-only debugging.
- `git-shard` enforces repo hygiene by default (`GIT_MAX_BLOB_BYTES=20971520`, denies common churn paths like `node_modules/`; see `docs/Git-Service.md`).
- `origin-gateway` is the stateless multi-tenant gateway: it keeps no working copy, and each save is a commit pushed to the space's `main` through `git-edge`. Its root is `tmp/origin-gateway-workspaces/` (override with `ORIGIN_GATEWAY_WORKSPACE_VOLUME`), where it keeps a disposable mirror cache in `.git-cache/` (deleting it only costs a fetch; `ORIGIN_CACHE_MAX_BYTES` caps it, 20 GiB by default). It touches nothing else in that root.
- Runtime checkouts live in a folder of their own, `tmp/runtime-checkouts/<space id>` (override with `DOCKER_REPO_HOST`), not in the gateway's root. Each time the stack starts the provider service (`pnpm stack:up` does so before it starts the gateway), it moves the runtime checkouts an earlier local stack kept in the gateway's root to that folder, with the provider's stamp and eviction folders. A space whose runtime container still exists (running or stopped), or whose checkout the new folder already has, stays where it is with a warning, and so does every space when the containers cannot be listed. When the stack reuses a provider that is already running instead, nothing moves, since that provider may be one started before runtime checkouts had a folder of their own: every checkout in the gateway's root stays, with a warning to stop the provider and start again, which moves them.

## Frontend
- Install deps: `pnpm install`
- Run Studio: `pnpm dev`
- `pnpm dev` takes Studio's Supabase URL and anon key from the first of `docker/.env.local`,
  `.env.supabase.local` and `packages/frontend/.env.local` that names either. `pnpm stack:up` writes
  `docker/.env.local` with an anon key and no URL. When the file it takes names no URL, or none names
  either, Studio gets the `[api]` port in this checkout's `supabase/supabase/config.toml` (54321 as
  committed). `pnpm dev` does not read `SUPABASE_URL` or `SUPABASE_PROJECT_URL` from the shell.

## Local production preview
Use this when you want to dogfood production-mode frontend behavior locally without redeploying every UI change.

- Fast production-mode loop with HMR: `pnpm dev:prod`
- Static production build + local preview server: `pnpm preview:prod`
- Backend target: browser-safe values from your ignored local env files
- Local backend target: `DEV_PROD_SUPABASE_SOURCE=local pnpm preview:prod`
- Alternate port: `pnpm preview:prod -- --port 4174`

`preview:prod` serves built assets, so it is closer to a deployed frontend than `dev:prod`. These frontend commands only pass browser-safe Supabase values into Vite; keep service-role keys in server/test env files and do not commit them.

## Supabase (local)
- Start only Supabase: `pnpm supabase:up`
- Apply new migrations to the running stack: `pnpm supabase:migrate`
- Rebuild the running database from `supabase/migrations` (deletes its data): `pnpm supabase:reset`
- Stop Supabase: `pnpm supabase:down`
- The Supabase CLI reads migrations only from its ignored copy in `supabase/supabase/migrations`. These
  commands and `pnpm stack:up` refresh that copy from `supabase/migrations` first and stop when they cannot
  (the `pnpm supabase:*` commands exit with code 3); a raw `supabase start` or `supabase db reset` reads
  whatever copy is there.

## Supabase release paths

`pnpm dev:supabase:release` is intentionally limited to isolated non-production projects. Hosted
production migration approval and execution belong to the deployment operator and are not part of
this local-development guide.

For an isolated non-production Supabase project only:

- Link project: `npx supabase link --project-ref <ref>`
- Sync secrets: `npx supabase secrets set --env-file supabase/.secrets.deploy`
- Apply migrations: `pnpm dev:supabase:release` (the current public tree contains no Edge
  Functions)

## Runtime Notes
- Do not background `pnpm dev:controller`; use `pnpm controller:up` and `pnpm controller:down`.
- `pnpm controller:up` keeps a generated session signing secret in `tmp/user-token-secret`, a credential key in `tmp/credential-encryption-key.b64` and the author pseudonym keyring (`INSTAFY_AUTHOR_PSEUDONYM_KEYS`; without it saves keep the origin's own git identity) in `tmp/author-pseudonym-keys`, so local sessions are never signed with the published development value. A bare `pnpm dev:controller` needs exported `USER_TOKEN_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`, or `DEV_MODE=1` on a machine nobody else can reach, because `DEV_MODE` signs sessions with that published development value.
- For desktop runtimes, set `PROXY_BASE_URL=http://127.0.0.1:8789`, with the stack's `PROXY_PORT` in place of
  8789 when it sets one.
- Local proxy startup defaults to controller-backed `remote_dynamic` BYOC. It does not copy `~/.codex/auth.json` into the proxy; connect that login through the Studio/Desktop credential onboarding flow so it is encrypted and scoped to the signed-in user.
- Legacy static proxy auth is only for isolated debugging and requires an explicit opt-in: `RUNTIME_PROXY_STATIC_AUTH=1 pnpm stack:up`. This mode may use `OPENAI_API_KEY` or mirror `~/.codex/auth.json` into `tmp/proxy-codex/`; do not use it for multi-user validation.
- After changing runtime-agent, git-service, or origin-gateway code, run `pnpm stack:refresh`; it rebuilds both runtime variants and all local git-canonical service images while keeping Supabase running.
- A site that opens on your computer but fails from a local runtime (`instafy web read`: "Client network socket disconnected before secure TLS connection was established"; Instafy's browser: `ERR_CONNECTION_CLOSED`) is usually the network path, not the runtime. Containers on Docker Desktop usually have no IPv6, so they reach every site over IPv4 through the host. Where the IPv4 path carries smaller packets than 1500 bytes (1452 behind an IPv4-in-IPv6 tunnel, for example) and the router does not clamp the TCP MSS, a site that accepts a larger MSS resets the connection on the first full-size segment. Chrome and Node built with OpenSSL 3.5 or later (Node 24, for example) send a post-quantum key share (X25519MLKEM768), so their TLS ClientHello no longer fits in one packet; `curl` on macOS and the host's browser over IPv6 still work. To check, from the host, with a Node whose `node -p process.versions.openssl` is 3.5 or later: `node -e 'require("https").get({host:"<site>",family:4,ecdhCurve:"X25519"},r=>console.log(r.statusCode))'` answers, and the same call without `ecdhCurve` is reset. Fix it on the network (MSS clamping on the router, or IPv6 for Docker Desktop); until then, local research and browser turns cannot read that site.

## GitHub import (private repos)
Studio can import a GitHub repo into a space. Public repos work without auth; private repos use GitHub device-code login.
- Set `GITHUB_DEVICE_AUTH_CLIENT_ID` in the controller environment to enable GitHub device login.
- Local dev tip: copy `.env.github-oauth.example` to `.env.github-oauth` and fill in the client id; `pnpm controller:up` will load it.
- Optional: `GITHUB_DEVICE_AUTH_SCOPE` (defaults to `repo`).

This import path is repo-onboarding only: it copies GitHub contents into the Instafy workspace and records integration metadata. It does not imply shipped issue/PR workflow automation.

GitHub import idempotency receipts have a supported replay window of at least
30 days after completion. They are currently retained indefinitely; no
automatic deletion is enabled. Any future retention job must delete only
terminal (`succeeded` or `failed`) receipts older than that window, in bounded
batches. It must never age-prune `pending` or `applied` operations because
those rows are recovery checkpoints for an in-flight or already-written
workspace mutation.
