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
- `git-shard` also owns **server-side policy** (see [Repository policy](#repository-policy)):
  - `main` is **fast-forward only** (reject non-FF / force pushes)
  - blob/path limits (deny common churn like `node_modules/`, cap per-blob size)
  - object checks on every push, a push size bound, and protected salvage refs
  - optional `git.push.received` webhook emission (`GIT_EVENTS_WEBHOOK_URL`)

This avoids re-implementing git protocol and keeps correctness high.

### Repository policy
At startup `git-shard` writes an `update` and a `post-receive` hook to
`<GIT_REPO_ROOT>/.instafy-hooks/`. It writes each to a temporary file and renames it into place, so
a push never runs a partial script. Every request then runs `git http-backend` with command-scope
configuration (`GIT_CONFIG_COUNT`, git 2.31 or later), which outranks every config file:

- `core.hooksPath` points at the shared hooks directory. A repository's own `hooks/` directory or
  `core.hooksPath` setting is never used, so hooks that older shards wrote into each repository
  are inert.
- `http.receivepack=true` enables pushes without writing repository config.
- `receive.fsckObjects=true` and `transfer.fsckObjects=true` check every received object. A
  malformed object, a tree entry named `..` or `.git` (including case and filesystem aliases), or
  an unsafe `.gitmodules` refuses the whole push before any ref moves, and none of its objects
  are kept.
- `receive.maxInputSize` bounds the pack a single push may send (`GIT_MAX_PUSH_BYTES`).

Requests never write hook files, change repository config or run `git config`. Before it serves,
the shard checks that the hooks can execute and that its `git` applies the command-scope
configuration; it refuses to start otherwise, because git would silently accept every push
unchecked (for example on a `noexec` repo root, or with git older than 2.31). The built-in deny list
is `REPO_POLICY_DENY_PATTERNS` in `packages/git-service/src/policy.rs`. The hook is rendered from
it, and other packages can import the same list instead of copying it. The hook also refuses
deleting a denied path, so the list holds build output and caches, not file patterns such as
secrets.

The hook checks every pushed ref:

- **Letter case.** On a case-insensitive filesystem (macOS, or a bind mount of one)
  `refs/heads/MAIN` and `refs/heads/main` are the same file, so protected names are compared in
  lower case. In a repository git marked `core.ignorecase` when it created it, ref names must also
  be ASCII, because some other letters fold onto ASCII ones there.
- **Salvage refs** (`refs/instafy/salvage` and everything under it, in any letter case) hold work
  recovered from retired workspaces and may be the only copy of it. An ordinary push may not
  create, move or delete them. Only a push the shard marked as a salvage push, because it carries
  the controller's exact salvage credential (see
  [Controller-only salvage pushes](#controller-only-salvage-pushes)), may create one, and only as
  `refs/instafy/salvage/gateway/<name>` with a lower-case name of at most 100 characters. No push
  can move or delete a salvage ref, and every other ref update in a salvage push is refused. The shard sets the
  hook environment for this itself, never from a request header. These rules and the ASCII rule run
  before `GIT_POLICY_DISABLED`.
- **`main`** is fast-forward only and cannot be deleted. A name that differs from it only in letter
  case is refused.
- **`refs/instafy/`** holds only recovery refs, `refs/instafy/recovery/<origin id>/<name>` with a
  lower-case UUID and a name of `[0-9A-Za-z._-]`, and the salvage refs above. A push may create or
  move nothing else there, so a stray ref such as `refs/instafy/recovery` cannot block them.
- **Other refs**, recovery refs included, may be deleted by any client allowed to push
  (`git.write`).
- **Every ref points to a commit**, directly or through an annotated tag.
- **Paths and sizes** are checked on the net change between the new tip and what the repository
  already accepted: the ref's old value, else the current `main`, else the empty tree. That covers
  everything a merge or several new commits bring in, but earlier commits are not walked one by
  one: a path or blob that one new commit adds and a later one removes is not checked. Paths are
  read in raw form, so unusual file names are checked exactly as stored.

Knobs:
- `GIT_MAX_BLOB_BYTES` (default `20971520` = 20 MiB): reject large blobs (helps avoid accidental binary/caches as canonical)
- `GIT_DENY_PATHS` (optional, comma-separated glob patterns): additional blocked paths (e.g. `*/vendor/*,*.zip`)
- `GIT_MAX_PUSH_BYTES` (default `1073741824` = 1 GiB): largest pack one push may send. Any value
  other than a positive whole number of bytes stops the shard from starting.
- `GIT_POLICY_DISABLED=1`: disable the hook's checks except the salvage ref rules and the ASCII ref-name rule (local-only debugging; unsafe). Object checks and the push size bound stay on.

Upgrades: deploy shards before Git Edge and the controller. Once a shard runs this policy, do not
roll it back to an older shard image: older shards rewrite per-repository hooks on each request
and run without object checks or salvage ref protection.

Behaviour that changed with the shared policy: a ref must point to a commit (or an annotated tag
of one), malformed objects that older git versions wrote are refused by the object checks, a push
may send at most `GIT_MAX_PUSH_BYTES`, and refs under `refs/instafy/` other than recovery refs
cannot be created.

### Push event hooks
`git-shard` can emit best-effort JSON webhooks after successful `git-receive-pack` requests:
- `GIT_EVENTS_WEBHOOK_URL` (optional): destination URL.
- `GIT_EVENTS_WEBHOOK_TOKEN` (optional): bearer token for the destination.
- `GIT_EVENTS_WEBHOOK_TIMEOUT_MS` (default `3000`): request timeout per event.

Payload schema is `instafy.git-service.event.v1` with `kind=git.push.received`, repo name, optional `projectId`, `defaultBranch`, and the pushed ref updates. Controller can consume these via `/git/hooks/events` and fan out `workspace.commit` SSE events so Studio refreshes quickly after external pushes.

For each push the shard names a fresh report file under `<GIT_REPO_ROOT>/.instafy-push-reports/`
in the hook environment (when push events are on, and for every salvage push, whose created refs
the shard logs). The shared `post-receive` hook appends the refs that push updated, and the
shard builds the event once `git receive-pack` has exited. An event lists the push's own updates to
branches and tags, so pushes that overlap in time never show up in each other's events. Each
update carries `refName`, `oldRev` (absent for a created ref), `newRev` (absent for a deleted ref)
and `deleted`. A refused push updates no ref and sends no event.

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

### Saving files in Studio
Studio picks how the Files editor saves from the space's default origin (the controller's
`GET /projects/:id/origin`), probing `GET /git/status?limit=1` for a hosted origin:
- **Stateful gateway** (no `stateless: true` in the status, or unknown): Save draft and Save
  version, exactly as before.
- **Stateless gateway** (`stateless: true`) and **Desktop origins**: one Save (Cmd/Ctrl+S, also
  Shift+Cmd/Ctrl+S). Each save is one `/apply` manifest pinned to the origin the file was read
  from, and checked the way that origin checks it, even after the default origin changed (the
  Desktop app went offline or came online). On the stateless gateway it carries `baseRev` (the
  `X-Instafy-Rev` of the read) and `expected` (the read's blob id) and commits on apply; on a
  Desktop origin it carries `expected` when the blob id is known and is published with
  `/git/sync {paths}`. If the file changed in the space meanwhile, the save answers 409 and the
  edits stay in the editor with a card that offers Merge or Reload. An edit read before such a
  change of origin or mode is checked once against the space's text when the file is opened: the
  same base text needs nothing, a different one raises the card. A new file stays in the browser
  until its first Save (which creates it on the default origin), and a new folder is one commit
  of its `.instafy.keep` placeholder, which the first save into the folder removes. Commit events
  reload the explorer at the event's commit; the editor's own saves, deletes and new folders are
  not reloaded, even when their event arrives before the save's response, and every open Files
  panel (the Files tab, the explorer drawer, a chat file surface) shows them at once. A save that
  is still running when its panel closes, the user switches spaces or leaves Studio is still
  recorded on the file, also when the user comes back before it finishes, so the next save builds
  on it. A save that fails once the user is in another space or has left Studio shows no message:
  the file keeps its unsaved edits, and when the file changed in the space its card waits in that
  space's chat. A file read again after a save shows what the space holds then, even when that is
  the text the save started from. Unsaved edits warn when leaving Studio;
  inside the Desktop app they do not block closing the window or quitting, because they stay on
  this device.

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

Request headers whose names start with `X-Instafy-Git-` are reserved for messages between Git
Edge and Git Shard. Git Edge drops every client-supplied header in that namespace before it
proxies a request.

The route has no compatibility variants: a query string, trailing slash, Smart HTTP subpath,
non-canonical UUID, or different HTTP method does not authorize deletion. The private shard repeats
the exact-root validation; refuses symlinks, non-direct children, non-directories, cross-filesystem
entries (including nested mounts), and directories that do not have the structural markers of a
bare Git repository; and never auto-initializes a repository while handling `DELETE`.

### Controller-only salvage pushes

Work recovered from retired workspace copies is kept on canonical as salvage refs. Writing one
needs a separate controller capability, `git.salvage`, which can do nothing else:

1. Use an unscoped controller-internal or Supabase service-role bearer to call
   `POST /projects/<uuid>/git/access_token` with `{"scopes":["git.salvage"]}`.
2. Push with the returned token as the bearer credential through Git Edge, creating
   `refs/instafy/salvage/gateway/<name>` with an empty expected old value, for example
   `git push --force-with-lease=<ref>: origin <commit>:<ref>`. The name starts with `[0-9a-z]`,
   continues with `[0-9a-z._-]` and has at most 100 characters (`policy::is_salvage_ref_name`).

`git.salvage` must be the only requested scope, always mints with a fixed 120-second lifetime, and
cannot be minted by a human session or any scoped runtime, job, origin or pre-stop grant token. The
controller logs each issuance with the project id and the token id (`jti`), never the token.

Git Edge accepts the token for exactly two requests, the two of a push:
`GET /<uuid>.git/info/refs?service=git-receive-pack` with no other query, and
`POST /<uuid>.git/git-receive-pack` without a query. Any other request is refused, including the
reads `git http-backend` would serve for shapes that only mention `git-receive-pack` (an
upload-pack request with that query appended, a second `service=` parameter, dumb-HTTP `HEAD` and
object paths). The push's ref advertisement lists the repository's refs and their commit ids, but
the token cannot fetch any object. The token must also have its exact shape: protocol `git`, the
repository's project, subject `instafy-controller-salvage`, `git.salvage` as the only scope, the
fixed lifetime, and no runtime, origin, lease, run or browser binding. A token that names
`git.salvage` is refused in any other shape, whatever else it holds.

Git Shard checks the token again with the same request matcher: a request whose bearer lists
`git.salvage` must be one of those two requests, verify against `GIT_JWKS_URL` and `GIT_AUDIENCE`
and have the same exact shape, or the shard refuses it before it touches the repository. So the
credential can never read, and never push as an ordinary `git.write` one. Other requests are left
to Git Edge as before. The shard logs each accepted salvage credential with its token id and, after
a salvage push, the refs it created; never the token.

A verified salvage push may only create salvage refs: it cannot move or delete one, and every other
ref update in the same push (`main`, branches, tags, recovery refs) is refused. Every refusal
specific to a salvage push starts with `instafy: salvage push refused:` and is permanent; retrying
the same ref cannot succeed. Object checks and the push size bound apply to every pushed object.
Deny paths and the blob size cap apply as for any push, which means to the net change between the
new tip and the current `main`, not to each commit in the ref's history: a path or blob that one
pushed commit adds and a later one removes is not checked, and the hook has no secret patterns at
all. Because salvage refs are permanent and readable by every `git.read` holder, the client that
builds a salvage commit must filter its whole history itself (every commit not already on `main`)
for secrets and excluded paths before it pushes, or push a single filtered commit on top of `main`.

Only deleting the repository (`git.delete`) removes salvage refs through the service. Short of
that, an operator can delete one on the shard host after review.

Upgrades: deploy shards before Git Edge. An older shard does not check the salvage credential and
would run its push as an ordinary write, so no salvage token may be minted until every shard runs
this policy. For the same reason, never roll a shard back to a version without salvage support
while Git Edge still accepts the credential: roll Git Edge back first, or stop minting
`git.salvage`.

## Concurrency (human-style)
- Agents/runtimes work on branches or local commits.
- To update `main`, they: `fetch main → merge → push` (FF-only). The local commits keep their ids
  under at most one merge commit; nothing is rebased or forced.
- If push is rejected, they fetch and retry; on conflicts `main` keeps its copy and the local copy
  goes to a recovery ref (`refs/instafy/recovery/<origin id>/<name>`) for the user or the agent.
- No global merge queue service; the git ref update is the serialization point.

## History in Studio

Studio picks its versioning UI per space from the project's default origin:

- **Changes** (a cloud space on the stateful gateway, and any space whose mode is not known yet):
  the working-tree drawer with Save version and Discard, unchanged.
- **History** (a cloud space whose gateway answers `/git/status` with `stateless: true`, and every
  Desktop space): saved versions read from the default origin, 20 per page with Show more where
  the origin pages history. Each version can be reviewed or reverted; Revert saves a new version
  that undoes it (`POST /git/revert-commit {commit, base}`) and never rewrites history.
- **Unsaved work** (History only): work kept on `refs/instafy/recovery/*` and
  `refs/instafy/salvage/*`, listed with `GET /git/recovery`. Restore commits it as a new version
  (`POST /git/recovery/restore`); when files changed since, Studio asks per file (use the kept
  version, keep the current one, or ask the agent) and finishes with a `keep` list, or Cancel,
  which closes the choices and restores nothing else (the only way out for salvage). "Use this
  version" reads the file at the ref and saves it on top of the head the restore reported. A read
  answers 404 `not_found` only when the path is absent from the tree at that commit,
  `unsupported_entry` when the path is a symlink or submodule (which reads and listings both
  hide), and `rev_not_found` when the ref no longer resolves. `not_found` at the ref becomes a
  delete only when a listing at the ref shows the ref still resolves without the path;
  `unsupported_entry` and an uncoded 404 write nothing, and `rev_not_found` reloads the list.
  Reads and listings at a ref carry `X-Instafy-Rev` set to the ref's tip, or no header; another
  commit means the entry moved and the list reloads, and a missing header never does. On a
  Desktop space it refuses a file the folder has uncommitted edits to, writes nothing over a
  symlink or nested repository in the folder (`unsupported_entry`), and sends the folder's current
  blob as `expected` (none when the folder lacks the path, which the origin enforces). Remove
  deletes a recovery ref for everyone (`POST /git/recovery/dismiss`); salvage refs stay and show
  "Restored" once restored. A restore of work the saved version already has answers
  `committed: false` and says there was nothing to restore; with `marked: true` (salvage refs) the
  origin recorded it as an empty version on `main`, so History also reloads at that `rev` and the
  entry shows "Restored". `notRestored` items may carry a `reason`: a file left out as an old chat
  upload (`attachment`, which a salvage keeps privately) is named in a sentence of its own, apart
  from secret and ignored files, and a `kept` file is never named as refused. The section is
  hidden on servers without these routes.
- **Desktop**: History also counts files changed in the folder outside Studio and saves them as a
  version (`POST /git/sync`), naming files it kept on the computer and why.

When a mode check swaps one drawer for the other while it has keyboard focus, the new drawer's
title takes focus and says which one the space uses; a space only ever shown as Changes never
sees this.

The nav badge counts uncommitted changes in Changes and unsaved-work entries in History; salvage
entries (by their kind, whatever the ref's letter case), which cannot be removed, count only until
the viewer has seen them (newer recovery entries never push a seen salvage entry out). Each viewer sees one chat row the first time new
unsaved work appears (opening History counts as seeing it); it is not written into the
conversation. What a viewer has seen lives in the browser's storage, and in memory for the session
when the browser refuses storage.

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
