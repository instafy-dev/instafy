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

Hosted runtimes are git-canonical only when the remote reaches them. The controller needs
`GIT_REMOTE_BASE_URL`; it then adds `ORIGIN_GIT_REMOTE_URL=<base>/<project_id>.git` to each
runtime's launch metadata. The provider's Compose file must forward `ORIGIN_GIT_REMOTE_URL` into
the runtime container, as `docker/docker-compose.runtime.provider.yml` does. If either is
missing, the runtime's origin has no remote: files are written only to the node's disk, each save
after a turn is recorded as failed ("git remote is not configured for this project"), and the
files are lost when the node is replaced. See [Hosted Runtime Machines](Runtime-Machines.md#workspace-durability).

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
- Every git command the Workspace Gateway runs against the remote (fetch, push, ls-remote) is bounded, because it runs while the space's apply lock is held. Each command carries curl's low-speed check: a transfer that stays under 1000 bytes/s for 300 seconds fails with `Operation too slow`. This covers a remote that accepts the connection and never answers, one that sends headers and then goes quiet, and one that stops mid-transfer. One 300 second window applies to every command because the longest quiet phase of a healthy exchange is a push waiting for the remote, which replies only after its update hook has checked every changed path; that takes longer for large commits. The speed check does not run while curl is still connecting; an unanswered connect ends at curl's default 300 second connect timeout, sooner where the OS stops retrying. A remote that stops responding fails the current command after one window (about five minutes) instead of holding the lock indefinitely, and the sync returns that error. The bound is on silence, not on total duration: a remote that keeps sending faster than 1000 bytes/s, or that goes quiet for less than 300 seconds at a time, is not cut off. A failed background refresh releases the lock and keeps the existing checkout until the next sync.

Native environments can choose:
- **FS API** (same as Studio) via `/apply` (write) + `/git/sync` (commit/push), or
- **git client** directly (`clone/commit/push`), as long as `main` protections/hook policies are enforced.

### Embedded repositories and protected checkpoints

A model turn may edit a repository nested inside the canonical workspace. The model-facing job token must not mint origin write tokens or run `instafy git sync`. After the turn, the trusted runtime hands changed path descriptors to the protected checkpoint. The origin temporarily excludes nested `.git` metadata while staging those paths, restores it on every success/error path, then commits and pushes through the normal canonical credentials.

Which paths the checkpoint receives:

- **The files the model reported** in its final output. This is the normal source.
- **The `git status` delta, as a fallback.** The runtime takes a bounded `git status` snapshot before and after the turn only when the turn was expected to change files (`runtimeExpectations.workspaceFileChanges`) or is read-only. It uses the delta as the path list only when a turn that was expected to change files reported none. In that delta, an already-dirty tracked or untracked nested file still counts when its content changes during the turn. The snapshot needs a git checkout of the workspace: the canonical `.instafy/.git`, which the origin creates only when the space has a git remote, or the workspace's own `.git`. Without either there is no delta.
- **The files `/skills import` installed**, with or without `--start`, behind the gates a model turn's files pass: the job commits to the workspace, its write scope is not read-only, and it has a verified workspace token bound to its run. That token alone does not prove the run may write, because a job without the separate workspace token falls back to its controller token, so the controller checks write permission again when the checkpoint asks for a lease. The import records the checkpoint's outcome as an `origin/apply` artifact tagged `lane: "skills/import"`, or as `origin/apply-skipped` or `origin/apply-error`. A failed checkpoint does not fail the import.

A file a turn changed but did not report, and that no delta caught, stays unsaved until a later `/sync`. Two `/skills import` cases are not saved by its checkpoint either:

- `--overwrite` sends only the files the new copy wrote. Files that only the replaced copy had are removed from the node's disk but stay in the canonical repository, and a node replacement restores them into the skill folder. The import does not send deletions for them because it cannot tell which ones the repository tracks, and a deletion for an untracked path fails the whole save. A later `/sync` records the removals.
- An import that fails while moving skills into place reports the skills it already installed, but does not checkpoint them. A later `/sync` saves them.

Nested `.git` configuration is untrusted. Runtime and origin dirty-file discovery use an isolated temporary Git directory containing only a validated HEAD and copied index, pin the work tree inside the workspace, ignore system/global/repository configuration, reject gitfiles and symlink/out-of-workspace metadata, disable hooks/fsmonitor, and enforce bounded output and time. Fingerprints are private implementation data with file-count and byte budgets; they never appear in descriptors, messages, logs, or model context.

Regression coverage:

- `packages/frontend/tests/playwright/smoke/agent-embedded-git-repo.spec.ts` proves a protected checkpoint commits and pushes a model edit without turning the embedded repo into a gitlink.
- `packages/runtime-agent/src/jobs/workspace_change_detection.rs` covers canonical `.instafy/.git`, already-dirty same-status rewrites, metadata preservation, and fingerprint budgets.
- `packages/origin-http-server/src/untrusted_git.rs` covers configured process/filter isolation, `core.worktree` escape resistance, unusual filenames, and unsafe `.git` rejection.
- `packages/origin-http-server/src/git.rs` verifies embedded `.git` restoration and canonical sync behavior.
- `packages/origin-http-server/src/git.rs` also pins the low-speed values on every server git command and proves that fetch, push and ls-remote against a remote that accepts the connection and then stalls (silent, or headers then silence) fail with `Operation too slow` within a test-shortened window.

Recommended (no token copy/paste):

```bash
instafy login
git clone "<git-base>/<uuid>.git"
```

`instafy login` installs a git credential helper which mints short-lived scoped tokens automatically when Git asks for credentials.

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
