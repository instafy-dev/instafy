# Git Service (Git-canonical workspaces)

## What it is
**Git-canonical** means space files are **durably stored as bare git repos** in an Instafy git service. Everything else (runtimes, origins, checkouts) can evaporate and be rebuilt from git.

This is **not GitHub**: we host the git servers and expose standard git remotes so any git client can `clone/push/fetch`.

## What runs (names)
- **Runtime Controller**: auth + scopes; issues access tokens; tracks repo metadata (which shard holds which space repo).
- **Git Edge** (`git-edge`): stateless HTTPS front door for git traffic (auth + routing).
- **Git Shards** (`git-shard-*`): stateful nodes that store bare repos on attached volumes and serve git protocol.
- **Workspace Gateway** (Origin HTTP API): serves `/entries`, `/files`, `/raw`, `POST /apply`, and `POST /git/sync` by materializing a checkout cache of a ref.
- **Runtime Agents**: compute that runs Codex/tools; uses local checkout(s) and pushes branches/commits back to the git service.

## Where files live at rest
- **At rest**: `git-shard` volume(s) store bare repos, e.g. `/var/lib/instafy-git/repos/<project_id>.git`.
- **Not at rest**: workspace gateway and runtime checkouts (cache/working copies on ephemeral disk).
- **Backups**: shard volume snapshots plus periodic encrypted copies to independent durable
  storage. Replication is a later upgrade.

## What code a “git node” runs
We implement git transport as **Git Smart HTTP** by wrapping git’s own backend (see `packages/git-service`):

- `git-shard` runs an HTTP server (Rust `axum`/`hyper` is fine) and, for each request under `/<repo>.git/...`, executes `git http-backend` with the correct CGI env:
  - `GIT_PROJECT_ROOT=/var/lib/instafy-git/repos`
  - `PATH_INFO=/.../<repo>.git/git-upload-pack` (or `git-receive-pack`)
  - `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `REMOTE_USER` (optional)
  - streams request body → stdin, streams stdout → HTTP response
- `git-shard` also owns **server-side policy** via hooks/config:
  - `main` is **fast-forward only** (reject non-FF / force pushes)
  - blob/path limits (deny common churn like `node_modules/`, cap per-blob size)
  - optional `git.push.received` webhook emission (`GIT_EVENTS_WEBHOOK_URL`)

This avoids re-implementing git protocol and keeps correctness high.

### Repo hygiene knobs
Policy runs on the `git-shard` via a server-side `hooks/update` script (runs for every pushed ref):
- `GIT_MAX_BLOB_BYTES` (default `20971520` = 20 MiB): reject large blobs (helps avoid accidental binary/caches as canonical)
- `GIT_DENY_PATHS` (optional, comma-separated glob patterns): additional blocked paths (e.g. `*/vendor/*,*.zip`)
- `GIT_POLICY_DISABLED=1`: disable checks (local-only debugging; unsafe)

### Push event hooks
`git-shard` can emit best-effort JSON webhooks after successful `git-receive-pack` requests:
- `GIT_EVENTS_WEBHOOK_URL` (optional): destination URL.
- `GIT_EVENTS_WEBHOOK_TOKEN` (optional): bearer token for the destination.
- `GIT_EVENTS_WEBHOOK_TIMEOUT_MS` (default `3000`): request timeout per event.

Payload schema is `instafy.git-service.event.v1` with `kind=git.push.received`, repo name, optional `projectId`, `defaultBranch`, and the pushed ref updates. Controller can consume these via `/git/hooks/events` and fan out `workspace.commit` SSE events so Studio refreshes quickly after external pushes.

## Load balancing + sharding (how it actually scales)
### Load balancing
- Put **Git Edge** behind a normal L7 load balancer (`<git-host>` → many `git-edge`).
- `git-edge` is **stateless**, so any LB strategy works (round-robin is fine).
- `git-edge` routes each request to the correct shard using only the URL path (no stickiness required).

### Sharding
- Each repo belongs to exactly one primary shard: `{project_id → shard_id}`.
- Recommended: controller-owned shard mapping (cached in `git-edge`) so we can add/move shards without changing a hash ring.
  - `git-edge` can call `GET /projects/:project_id/git/shard` (service-auth) to resolve a repo’s shard URL.
  - Fallback mode: deterministic hash of the repo name (`fnv1a % shard_count`) when controller routing is disabled.
- Shards are **not** behind a single random LB for writes; routing must be deterministic per repo.
- Adding capacity: add new shards and assign new repos there; moving repos is an explicit operation (copy bare repo + swap mapping).

## FS API vs git transport
Browsers should not speak git for normal editing. The “phone UI” flow is:
- `Studio → Controller (auth/token) → Workspace Gateway (/entries,/files,/raw,/apply,/git/sync)`
- Workspace Gateway uses git under the hood (fetch/checkout cache). File writes land via `POST /apply`; persisting them to the canonical remote is an explicit sync step via `POST /git/sync` so agents can choose commit boundaries/messages and handle conflicts intentionally.

Native environments can choose:
- **FS API** (same as Studio) via `/apply` (write) + `/git/sync` (commit/push), or
- **git client** directly (`clone/commit/push`), as long as `main` protections/hook policies are enforced.

### Embedded repositories and protected checkpoints

A model turn may edit a repository nested inside the canonical workspace. The model-facing job token must not mint origin write tokens or run `instafy git sync`; after the turn, the trusted runtime compares bounded pre/post workspace snapshots and hands only changed path descriptors to the protected checkpoint. The origin temporarily excludes nested `.git` metadata while staging those paths, restores it on every success/error path, then commits and pushes through the normal canonical credentials. An already-dirty tracked or untracked nested file still counts when its content changes during the turn.

Nested `.git` configuration is untrusted. Runtime and origin dirty-file discovery use an isolated temporary Git directory containing only a validated HEAD and copied index, pin the work tree inside the workspace, ignore system/global/repository configuration, reject gitfiles and symlink/out-of-workspace metadata, disable hooks/fsmonitor, and enforce bounded output and time. Fingerprints are private implementation data with file-count and byte budgets; they never appear in descriptors, messages, logs, or model context.

Regression coverage:

- `packages/frontend/tests/playwright/smoke/agent-embedded-git-repo.spec.ts` proves a protected checkpoint commits and pushes a model edit without turning the embedded repo into a gitlink.
- `packages/runtime-agent/src/jobs/workspace_change_detection.rs` covers canonical `.instafy/.git`, already-dirty same-status rewrites, metadata preservation, and fingerprint budgets.
- `packages/origin-http-server/src/untrusted_git.rs` covers configured process/filter isolation, `core.worktree` escape resistance, unusual filenames, and unsafe `.git` rejection.
- `packages/origin-http-server/src/git.rs` verifies embedded `.git` restoration and canonical sync behavior.

Recommended (no token copy/paste):

```bash
instafy login
git clone "<git-base>/<uuid>.git"
```

`instafy login` installs a git credential helper which mints short-lived scoped tokens automatically when Git asks for credentials.

Advanced (mint token + clone):

```bash
instafy api post "/projects/<uuid>/git/access_token" --access-token "$INSTAFY_ACCESS_TOKEN" --json '{"scopes":["git.read","git.write"],"ttlSeconds":600}'
# copy the `token` field from the response:
git -c "http.extraHeader=Authorization: Bearer <token>" clone "<git-base>/<uuid>.git"
```

### Controller-only disposable repository cleanup

Trusted backend automation can remove an exact disposable project repository without SSH access
to a shard. This capability is intentionally separate from human and runtime Git access:

1. Use an unscoped controller-internal or Supabase service-role bearer to call
   `POST /projects/<uuid>/git/access_token` with
   `{"scopes":["git.delete"],"ttlSeconds":60}`.
2. Send the returned token as a bearer credential on exact
   `DELETE <git-base>/<uuid>.git`.

`git.delete` must be the only requested scope, always mints with a fixed 60-second lifetime, and
cannot be minted by a human session or any scoped runtime, job, or origin token. Git Edge requires
authentication for this operation even when the local-only `GIT_EDGE_SKIP_AUTH` switch is enabled.
A successful
deletion returns `204 No Content`; an already-absent repository returns `404 Not Found`, which
callers may treat as an idempotent cleanup result only with the matching acknowledgement below.

Git Shard independently verifies the signed bearer against `GIT_JWKS_URL` and `GIT_AUDIENCE`
(the same values used by Git Edge), then requires the exact project binding, protocol, sole scope,
and absence of runtime/origin/lease/run bindings. This keeps rolling upgrades fail-closed if a new
shard briefly receives traffic through an older edge.

New shards attach a fixed, status-bound acknowledgement which Git Edge validates and preserves:

- `204 No Content` with `X-Instafy-Git-Delete-Result: deleted-v1`
- `404 Not Found` with `X-Instafy-Git-Delete-Result: absent-v1`

For a delete request, Git Edge turns every missing, duplicated, mismatched, or unexpected upstream
acknowledgement/status into `502 Bad Gateway`. This prevents an older shard's ordinary Smart HTTP
`404` from being mistaken for deletion during a rolling upgrade. Cleanup automation must require
the exact header/status pair; an initial cleanup normally observes `deleted-v1`, and a second exact
`DELETE` provides readback proof as `404` plus `absent-v1`.

The route has no compatibility variants: a query string, trailing slash, Smart HTTP subpath,
non-canonical UUID, or different HTTP method does not authorize deletion. The private shard repeats
the exact-root validation; refuses symlinks, non-direct children, non-directories, cross-filesystem
entries (including nested mounts), and directories that do not have the structural markers of a
bare Git repository; and never auto-initializes a repository while handling `DELETE`.

## Concurrency (human-style)
- Agents/runtimes work on branches or local commits.
- To update `main`, they: `fetch main → rebase/merge → push` (FF-only).
- If push is rejected, they retry; on conflicts they resolve (AI) or ask the user.
- No global merge queue service; the git ref update is the serialization point.

## Local dev (what we should wire into `pnpm stack:up`)
- Start `git-shard-0` + `git-edge` in Docker (compose file), storing repos in a local docker volume.
- Dev convenience: `git-shard` can auto-init and seed `<project_id>.git` on first access (`GIT_AUTO_INIT=1`).
- Run Origin in git mode by setting:
  - `ORIGIN_GIT_REMOTE_URL=http://git-edge:8080/<project_id>.git`
  - `ORIGIN_GIT_BRANCH=main`

Why `<project_id>.git`?
- Instafy already keys everything by `project_id` internally (JWT claims, workspace paths, controller APIs). Using it as the repo name avoids a second identifier during v0.
- In the local dev harness, `scripts/run-e2e-dev.mjs` generates `SPACE_ID` into
  `$INSTAFY_ENV_DIR/docker/.env.local` (or the legacy in-checkout fallback when the variable
  is unset) so the controller/runtime/origin/git service all point at the same sandbox space.
  This is local-only state, not an external “global registry”.

## Self-hosted deployment sketch

- Run a small stateless `git-edge` pool behind an L7 load balancer and firewall.
- Run each stateful `git-shard` with a persistent volume mounted at
  `/var/lib/instafy-git`; expose shards only to the private service network.
- Keep routing deterministic per repository as described above.

## Backups

Back up `/var/lib/instafy-git/repos` with an encrypted, incremental tool such as restic. Keep
backup credentials in the deployment platform's secret store, retain multiple snapshots, and use
an offsite backend independent from the shard volume. Regularly restore one bare repository into
an isolated directory, clone it, and run `git fsck`; a backup without a tested restore path is not
durable storage.

## What we need to build next
- Controller-owned shard mapping + repo move tooling (hash-free growth).
- Blob/path limits + ignore policy enforcement (prevent “agent churn” becoming canonical).
- Push webhooks are in place; next step is optional batching/retry queue for guaranteed delivery.
- Production hardening: TLS, quotas, GC/pack tuning, backups/restore runbooks.
