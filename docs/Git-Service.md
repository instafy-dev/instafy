# Git Service (Git-canonical workspaces)

## What it is
**Git-canonical** means space files are **durably stored as bare git repos** in an Instafy git service. Everything else (runtimes, origins, checkouts) can evaporate and be rebuilt from git.

This is **not GitHub**: we host the git servers and expose standard git remotes so any git client can `clone/push/fetch`.

## What runs (names)
- **Runtime Controller**: auth + scopes; issues access tokens; tracks repo metadata (which shard holds which space repo).
- **Git Edge** (`git-edge`): stateless HTTPS front door for git traffic (auth + routing).
- **Git Shards** (`git-shard-*`): stateful nodes that store bare repos on attached volumes and serve git protocol.
- **Workspace Gateway** (Origin HTTP API, `origin-http-server` with `ORIGIN_MULTI_TENANT=1`): serves every hosted space's `/entries`, `/files`, `/raw`, `POST /apply` and history routes straight from its canonical repository. Reads come from git objects in a disposable bare mirror, and each write is one commit pushed to `main`. It keeps no working copy; see [Hosted workspace gateway](#hosted-workspace-gateway).
- **Runtime Agents**: compute that runs Codex/tools; uses local checkout(s) and pushes branches/commits back to the git service.

## Where files live at rest
- **At rest**: `git-shard` volume(s) store bare repos, e.g. `/var/lib/instafy-git/repos/<project_id>.git`.
- **Not at rest**: the workspace gateway's mirror cache (`<workspace root>/.git-cache/`; deleting any of it only costs a fetch) and runtime checkouts (working copies on ephemeral disk).
- **Disposable**: `<workspace root>/.legacy/` on the gateway's volume holds the working copies that
  earlier, stateful gateway images kept per space. Nothing reads them; see
  [Retiring gateway working copies](#retiring-gateway-working-copies).
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
  - object checks on every push, a push size bound, and a reserved salvage ref namespace
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
- **Salvage refs** (`refs/instafy/salvage` and everything under it, in any letter case) are
  reserved: no push may create, move or delete one. This check and the ASCII rule run before
  `GIT_POLICY_DISABLED`.
- **`main`** is fast-forward only and cannot be deleted. A name that differs from it only in letter
  case is refused.
- **`refs/instafy/`** holds only recovery refs, `refs/instafy/recovery/<origin id>/<name>` with a
  lower-case UUID and a name of `[0-9A-Za-z._-]`. A push may create or move nothing else there, so
  a stray ref such as `refs/instafy/recovery` cannot block them.
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
- `GIT_MAX_PUSH_BYTES` (default `1073741824` = 1 GiB; blank means the default): largest pack one
  push may send. A non-blank value other than a positive whole number of bytes stops the shard
  from starting.
- `GIT_POLICY_DISABLED=1`: disable the hook's checks except the salvage ref rule and the ASCII ref-name rule (local-only debugging; unsafe). Object checks and the push size bound stay on.

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

When push events are on, the shard names a fresh report file for each push under
`<GIT_REPO_ROOT>/.instafy-push-reports/` in the hook environment. The shared `post-receive` hook
appends the refs that push updated, and the shard builds the event once `git receive-pack` has
exited. An event lists the push's own updates to
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
- `Studio → Controller (auth/token) → origin (/entries,/files,/raw,/apply and the history routes)`,
  where the origin is the Workspace Gateway for a cloud space and the Desktop origin for a
  Desktop space.
- On the Workspace Gateway each `POST /apply` is one commit on canonical `main`; there is no
  separate sync step (see [Hosted workspace gateway](#hosted-workspace-gateway)).
- On a workspace runtime or Desktop origin, `POST /apply` writes files into the checkout, and persisting them to the canonical remote is an explicit sync step via `POST /git/sync` so agents can choose commit boundaries/messages and handle conflicts intentionally.
- Every git command an origin runs against the remote (fetch, push, ls-remote) is bounded. On a workspace runtime or Desktop origin it runs while the space's apply lock is held. Each command carries curl's low-speed check: a transfer that stays under 1000 bytes/s for 300 seconds fails with `Operation too slow`. This covers a remote that accepts the connection and never answers, one that sends headers and then goes quiet, and one that stops mid-transfer. One 300 second window applies to every command because the longest quiet phase of a healthy exchange is a push waiting for the remote, which replies only after its update hook has checked every changed path; that takes longer for large commits. The speed check does not run while curl is still connecting; an unanswered connect ends at curl's default 300 second connect timeout, sooner where the OS stops retrying. A remote that stops responding fails the current command after one window (about five minutes) instead of holding the lock indefinitely, and the sync returns that error. The bound is on silence, not on total duration: a remote that keeps sending faster than 1000 bytes/s, or that goes quiet for less than 300 seconds at a time, is not cut off. A failed background refresh releases the lock and keeps the existing checkout until the next sync. The Workspace Gateway's git commands carry the same speed check; it also stops a fetch of `main` after five minutes, and a read waits on one for at most ten seconds. A read of a recovery ref, a restore's fetch and removal of one, a dismissal and the `GET /git/recovery` list instead run their git commands for those refs against canonical inside the request, for at most 60 seconds.

Native environments can choose:
- **FS API** (same as Studio): `/apply` alone on the Workspace Gateway, or `/apply` (write) + `/git/sync` (commit/push) on a workspace runtime or Desktop origin, or
- **git client** directly (`clone/commit/push`), as long as `main` protections/hook policies are enforced.

### Saving files in Studio
Studio picks how the Files editor saves from the space's default origin (the controller's
`GET /projects/:id/origin`), probing `GET /git/status?limit=1` for a hosted origin:
- **Stateful gateway** (an older gateway image: no `stateless: true` in the status, or unknown):
  Save draft and Save version, exactly as before. The gateway built from this repository always
  answers `stateless: true`.
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

## Hosted workspace gateway

The Workspace Gateway is `origin-http-server` started with `ORIGIN_MULTI_TENANT=1`. One process
serves every hosted space from its canonical repository, `<ORIGIN_GIT_REMOTE_BASE_URL>/<space
id>.git`, and keeps no working copy: nothing it writes to its disk is ever the only copy of a save.
The code is `packages/origin-http-server/src/hosted/`. Workspace runtimes and Desktop origins
(single-tenant origins) keep their checkouts and are described in
`packages/origin-http-server/README.md`.

### Configuration and start

The gateway refuses to start when:

- `ORIGIN_GIT_REMOTE_URL` is set to anything but blank. It would route every space to one
  repository; the gateway builds each space's URL from `ORIGIN_GIT_REMOTE_BASE_URL`, which is
  required.
- `ORIGIN_STAGING_ROOT` is set, even to a blank value. Uploads are staged in the gateway's own
  cache.
- `ORIGIN_GIT_BRANCH` is set to anything but `main`.
- `ORIGIN_GATEWAY_GIT_AUTHOR_EMAIL` is `origin@instafy.dev`, the address workspace runtimes and
  Desktop commit under by default.
- `ORIGIN_CACHE_MAX_BYTES` is set to a non-blank value other than a positive whole number of bytes
  (blank means the 20 GiB default).

The gateway commits as `ORIGIN_GATEWAY_GIT_AUTHOR_NAME` / `ORIGIN_GATEWAY_GIT_AUTHOR_EMAIL`. Without
them it uses `ORIGIN_GIT_AUTHOR_NAME` / `ORIGIN_GIT_AUTHOR_EMAIL`, except that the runtimes' default
address `origin@instafy.dev` is replaced by `gateway@instafy.dev` with a warning; with neither set,
the address is `gateway@instafy.dev`. The gateway recognizes its own commits by that address (import
receipts, restores), so choose it once.

Before it listens, the gateway:

1. Moves every working copy an earlier, stateful gateway image left in its workspace root
   (`ORIGIN_WORKSPACE_ROOT`) to `.legacy/`. A direct child of the root counts when its name is
   exactly a space id as that gateway wrote it (a lower-case, hyphenated UUID) and it is a folder or
   a link. It goes to `.legacy/<id>`, or `.legacy/<id>-<UTC time>` when that name is taken; nothing
   is replaced, a link is moved as a link and never followed, and an empty folder is removed.
   `.legacy/` is created with mode 0700. An older gateway image started on the same volume later,
   such as an automatic rollback, finds no working copy there and clones each space fresh instead
   of saving old drafts over newer work. When anything cannot be moved, the gateway does not start.
2. Opens its mirror cache, `.git-cache/` under the same root (mode 0700; a link in its place is
   refused), empties the cache's scratch folders, and removes the locks a git process that was
   killed left in any mirror.

`ORIGIN_WORKSPACE_ROOT` must be a folder of the gateway's own, never a runtime provider's
checkout folder (`DOCKER_REPO_HOST`). A provider keeps each runtime's checkout there under the
space id, the name step 1 moves, and such a checkout can hold work no runtime has pushed yet. So
before it moves anything, the gateway refuses to start on a root that holds the provider's
`.instafy-checkout-stamps/` or `.instafy-evicted/`, or a space folder whose `.instafy/.git` holds a
runtime's clean-stop marker (`instafy-stopped-clean`) or a local recovery ref
(`refs/instafy/local-recovery*`, loose or packed); it follows no link to find them. It then logs
`could not move old gateway working copies to .legacy; refusing to start`, caused by an error that
names the root and what was found there and ends with
`ORIGIN_WORKSPACE_ROOT must be a folder of the gateway's own, never the providers' DOCKER_REPO_HOST`,
and exits with status 1.

Run the gateway with an init as PID 1 (`docker run --init`, or `init: true` in Compose, as
`docker/docker-compose.runtime.yml` does), so any process the server leaves behind is reaped.

### Mirror cache

`.git-cache/<space id>.git` is a bare mirror of the space's canonical `main` (and, for a moment at
a time, of a recovery commit a read asked for). Deleting a mirror, or the whole cache,
only costs a fetch.

- Fetches of `main` run once per space at a time, in a task of their own. A plain read reuses a
  fetch that finished in the last two seconds, while the mirror it filled is still the one on
  disk, or joins the one running; a write waits for a fetch that started after it arrived. A read
  waits at most ten seconds for a fetch, a space's first clone included, and a write as long as
  its own budget allows (see [Writes](#writes)); either is then answered 503 `fetch_pending` while
  the fetch goes on. A fetch is stopped after five minutes. A failed fetch is an error, never older
  data: a canonical repository out of reach is 502 `canonical_unreachable`.
- Recovery refs are not fetched that way. A `?ref=` read (also `ref` on the diff and
  review routes), a restore's fetch and removal of such a ref, a dismissal and the
  `GET /git/recovery` list (after its read of `main`) run their git commands for those refs
  against canonical inside the request, for at most 60 seconds, and are not answered
  `fetch_pending` for that wait.
- A mirror damaged on the gateway's disk (a lock a killed git left, a missing or corrupt object,
  what a full disk left behind) is thrown away and cloned again. A read or write that finds the
  damage is answered 503 `mirror_reset` meanwhile. Damage on canonical's side, or a transfer cut
  off part way, is a 502 and the mirror is kept.
- A full disk is answered 503 `disk_full` wherever a write or fetch finds it, and starts a sweep.
- Every ten minutes a sweep removes scratch older than an hour and, while the mirrors together
  exceed `ORIGIN_CACHE_MAX_BYTES` (default 20 GiB), the least recently used mirror that nobody
  has used for an hour. The cap is soft: mirrors in use are never removed for it. When the cache's
  disk has less than 2 GiB free, the sweep removes mirrors nobody holds, however recently used,
  until it has that much again. `.legacy/` is never touched; when the disk is short of space, the
  warning reports its size (measured at most once an hour). The sweep
  also packs a mirror past git's own `gc --auto` limits (about 6,700 loose objects or 50 packs);
  git never runs maintenance in a mirror on its own.

The 503 answers (`fetch_pending`, `mirror_reset`, `disk_full`, and `writes_busy` below) carry
`Retry-After: 2`, which browsers can read: the gateway exposes `Retry-After`, `X-Instafy-Rev` and
`X-Instafy-Blob` through CORS. Reads fetch with a `git.read` credential minted with the gateway's
`ORIGIN_INTERNAL_TOKEN` (or the caller's token). Writes
exchange the caller's own `fs.write` token for `git.write` right before each push, never the
gateway's credential, and every `fs.write` request must hold the caller's live workspace lease.

### Reads

- `/entries`, `/files/<path>` and `/raw/<path>` show canonical `main`; with `?rev=<commit>`, a
  commit `main` reaches (`main` is fetched once when the mirror does not have it yet); with
  `?ref=<recovery ref>`, that ref's commit, read on canonical by exactly that name.
  `rev` and `ref` together are 400 `invalid_ref`.
- Every read that looked at a commit answers `X-Instafy-Rev` naming it (for `?ref=`, the ref's own
  id), errors included. A space without `main` answers an empty root and no header. Files carry
  `X-Instafy-Blob`, and listings carry no modification time.
- A 404 is `not_found` only when the commit's tree has nothing at the path. A folder where a file
  was asked for, a link, a submodule or a reserved path is `unsupported_entry`, and a `rev` or
  `ref` that does not resolve is `rev_not_found`. A file over 20 MiB is 413 `too_large`.
- `GET /git/status` answers `stateless: true` with nothing unsaved, for every space and without a
  fetch. Studio reads that flag to pick one Save and History (see
  [Saving files in Studio](#saving-files-in-studio)).
- `GET /git/history?limit&skip` lists `main`'s first-parent history, up to 50 commits a page (8 by
  default), with `hasMore`.
- `GET /git/diff` and `GET /git/history/review` answer a commit the space does not have with 200,
  an empty answer, `error` and `code: "rev_not_found"` (clients read a 404 on these two routes as a
  space without versioning), and remember that commit for 30 seconds without fetching again. A
  diff `base` the space does not have is left out, so the change shows against the commit's first
  parent.
- `GET /git/recovery` lists unsaved work as single-tenant origins do. A restore commit counts when
  the gateway's address, `origin@instafy.dev` or `gateway@instafy.dev` committed it.

### Writes

Each write is one commit on canonical `main`. The gateway builds it from git objects in a
quarantine of its own, pushes it as a fast-forward of the `main` it built on (create-only for a
space without `main`), and moves its objects into the mirror only after the push landed, so a
refused write leaves nothing behind.

- `POST /apply` (multipart) and `POST /apply-json` take the single-tenant manifest plus `baseRev`,
  the `X-Instafy-Rev` the client read at, and `expected: {path: blobId | null}`, the blob each path
  held when read (`null`: absent). A path that changed since is 409 `head_moved {head, paths}`, and
  nothing is saved. Without `baseRev` (other than for an import) only the paths named are changed,
  and the save is logged under the target `origin_apply_no_base_rev` with the client's
  `X-Instafy-Client` label. Deleting a folder needs `baseRev` (400
  `delete_requires_base_rev`). The answer is `{rev, baseRev, committed, fileCount, bytesWritten}`,
  with `committed: false` when the save would not change `main`'s tree.
- Refused, with nothing saved: 400 `unsupported_entry` (a link or submodule written over), 409
  `path_type_conflict` (a file where a folder is, or the reverse), 409 `path_alias` (a new path
  `main` holds under another spelling a disk that ignores case or Unicode form takes for it, with
  case folded fully, so `Straße.md`, `STRAẞE.md` and `STRASSE.md` are one name), 422
  `ignored_path` (a new file the space's `.gitignore` ignores), 422 `excluded_path` with a `reason`
  such as `secret`, `attachment` (a chat upload) or `excluded` (build output, dependencies, Instafy
  files), 422 `policy_rejected` (a file over 20 MiB), and 502 `push_rejected` (canonical refused
  the push).
- A person's write is authored by the per-space pseudonym and display name the controller puts in
  their token (`author_name`, `author_email`; only addresses under `@users.noreply.instafy.dev`
  count), the rule Desktop saves by. A job's token, or one without those claims, is authored by the
  gateway, and the gateway is always the committer, so no user id or token subject reaches history.
  A caller's `commitMessage` keeps its prose; control characters other than newlines and tabs are
  dropped, it is cut at 16 KiB, and the `Instafy-` trailers git reads in its last paragraph are
  removed (`Instafy-Resolved-By` stays). Without one, the subject is `Update <path>`, `Delete <path>` or
  `Update <n> files`.
- Imports are writes whose token carries the `workspace.import` scope, which the controller adds
  to its import tokens. Only they may send an `idempotencyKey` (400 `idempotency_requires_import`
  otherwise). An import's commit carries `Instafy-Apply-Key`, `Instafy-Apply-Fingerprint`,
  `Instafy-Apply-Files` and `Instafy-Apply-Bytes` trailers, and is made even when it changes
  nothing: that commit is its receipt. An import leaves out the paths a save may never hold and
  lists them in `skippedPaths` instead of being refused. A repeat with the same key answers the
  first answer's counts with `replayed: true`, and a different fingerprint is 409 `idempotency_conflict`. `POST
  /apply/status {idempotencyKey, requestFingerprint?}` finds the receipt on `main` (a commit under
  the gateway's address, at most 31 days old by its committer date) and answers `{status:
  "succeeded", rev, baseRev, fileCount, bytesWritten}`, or 404 `not_found`; it takes an import
  token only (400 `idempotency_requires_import` otherwise), and a different `requestFingerprint`
  is 409 `idempotency_conflict`. Imports, and the
  controller's managed-files applies (`autoCommitAfterApply`), add ignored files as tracked content
  and are not refused for `path_alias`.
- `POST /git/revert-commit {commit, base?}` saves the inverse of a saved commit, merged onto
  `main` (409 `revert_conflict` when later changes overlap). A merge or a first commit needs
  `base`, which must be an ancestor of `commit`.
- `POST /git/recovery/restore` and `POST /git/recovery/dismiss` follow the single-tenant rules
  (one restore plan, `src/restore_plan.rs`).
- `POST /git/sync` commits nothing: with `{expectedRev}` it checks that the commit is on `main`
  (409 `rev_not_on_main` otherwise) and otherwise answers `main`. `{mode: "refresh"}` is 400
  `not_supported`, and so is `POST /git/revert`: there is no working copy to refresh or discard.
- `/apply`, `/apply-json`, `/git/revert-commit` and `/git/recovery/restore` take one of four write
  slots shared by all spaces, and imports one of two slots of their own. A slot is let go while the
  write waits on canonical, and before its push. A write that waits ten seconds for a slot (an
  import, 60 seconds) is answered 503 `writes_busy`.
- A push that loses the race to another save fetches `main`, builds the change again and retries,
  at most five attempts within ten seconds for a person's write (840 seconds for an import), and
  then answers 409 `main_busy`. A push that ends without an answer is settled by fetching `main`.
- The controller's imports ask a busy gateway again within their budget (any 503 with
  `Retry-After`, the four 503 codes above, and 409 `main_busy`). Its managed-files bootstrap reports
  `workspace-busy` on a 503 and is tried again later.

## Retiring gateway working copies

Earlier gateway images kept one working copy per space at `<root>/<space id>` and saved from it.
The stateless gateway moves those copies to `<root>/.legacy/` before it serves (see
[Configuration and start](#configuration-and-start)), and no gateway image reads `.legacy/`
again. The copies are disposable: once the switch is done, an operator may delete `.legacy/`.
Copy a file out by hand first only when a space's owner asks for a draft that never reached
canonical.

### Switching a deployment

1. Drain imports. The stateful gateway kept import receipts inside each working copy, and the
   stateless gateway finds a receipt only as its own commit on `main`. An import the controller
   resumes after the switch (a retry with the same key) finds no receipt there: one not yet
   recorded as applied is applied again, over anything saved since, and one recorded as applied
   fails unless its commit is on `main`. Run this right before the image changes, and start no
   import between the two:
   ```sql
   select id, project_id, status, claim_expires_at, error_message
     from public.github_import_operations
    where status in ('pending', 'applied')
       or (status = 'failed' and prepared_json is not null);
   ```
   Wait for each `pending` or `applied` row whose claim is live (`claim_expires_at` in the future)
   to finish. A row whose claim has expired is an import that stopped part way (at a controller
   restart, for example), and a retry with the same key resumes it: have it retried while the
   stateful gateway still serves, so that it finishes there, or, when it cannot be, check on that
   gateway whether its files were applied and tell the space's owner before you switch. A `failed`
   row the query lists kept its preparation (`prepared_json`) and is resumed the same way when its
   import is retried; one that failed while its apply was under way (a timeout, for example) may
   already have been applied on the stateful gateway. Treat these rows like the expired ones: have
   them retried on the stateful gateway, or check there whether their files were applied, before
   you switch.
2. Deploy the stateless gateway image. Its start moves the working copies to `.legacy/`.

## Concurrency (human-style)
- Agents/runtimes work on branches or local commits.
- To update `main`, they: `fetch main → merge → push` (FF-only). The local commits keep their ids
  under at most one merge commit; nothing is rebased or forced.
- If push is rejected, they fetch and retry; on conflicts `main` keeps its copy and the local copy
  goes to a recovery ref (`refs/instafy/recovery/<origin id>/<name>`) for the user or the agent.
- No global merge queue service; the git ref update is the serialization point.
- The Workspace Gateway builds each save on the `main` it just fetched and pushes it as a plain
  fast-forward. A lost race fetches, builds the save again and retries, and conflicts are checked
  against what the client read (see [Writes](#writes)); nothing goes to a recovery ref.

## History in Studio

Studio picks its versioning UI per space from the project's default origin:

- **Changes** (a cloud space on an older, stateful gateway, and any space whose mode is not known yet):
  the working-tree drawer with Save version and Discard, unchanged.
- **History** (a cloud space whose gateway answers `/git/status` with `stateless: true`, and every
  Desktop space): saved versions read from the default origin, 20 per page with Show more where
  the origin pages history. Each version can be reviewed or reverted; Revert saves a new version
  that undoes it (`POST /git/revert-commit {commit, base}`) and never rewrites history.
- **Unsaved work** (History only): work kept on `refs/instafy/recovery/*`, listed with
  `GET /git/recovery`. Restore commits it as a new version
  (`POST /git/recovery/restore`); when files changed since, Studio asks per file (use the kept
  version, keep the current one, or ask the agent) and finishes with a `keep` list, or Cancel,
  which closes the choices and restores nothing else. "Use this
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
  blob as `expected` (none when the folder lacks the path, which the origin enforces). A restore
  removes a recovery ref once `main` holds its work, all of it but what the person kept; a kept
  new name that a disk ignoring case takes for another file of `main` (`todo.md` beside `TODO.md`,
  `Docs/guide.md` beside a file `docs`) keeps the ref, because `main` holds that work under neither
  name. A ref a restore keeps shows "Restored" only once `main` holds a restore commit for it; a
  restore that kept or refused all it held makes none (`committed: false`), so the entry stays
  pending until it is removed. Remove deletes a recovery ref for everyone
  (`POST /git/recovery/dismiss`). A restore of work the saved version already has answers
  `committed: false` and says there was nothing to restore. `notRestored` items carry a `reason`
  on both Desktop and the gateway: a file left out as an old chat upload (`attachment`) is named
  in a sentence of its own, apart
  from secret and ignored files, and a `kept` file is never named as refused. The section is
  hidden on servers without these routes.
- **Desktop**: History also counts files changed in the folder outside Studio and saves them as a
  version (`POST /git/sync`), naming files it kept on the computer and why.

When a mode check swaps one drawer for the other while it has keyboard focus, the new drawer's
title takes focus and says which one the space uses; a space only ever shown as Changes never
sees this.

The nav badge counts uncommitted changes in Changes and, in History, unsaved-work entries that are
not restored yet. Each viewer sees one chat row the first time new
unsaved work appears (opening History counts as seeing it); it is not written into the
conversation. What a viewer has seen lives in the browser's storage, and in memory for the session
when the browser refuses storage.

## Local dev
- `pnpm stack:up` starts `git-shard-0`, `git-edge` and `origin-gateway` in Docker
  (`docker/docker-compose.runtime.yml`) by default (`GIT_CANONICAL=0` opts out), storing repos
  under `tmp/git-repos/` (`GIT_REPO_VOLUME`).
- Dev convenience: `git-shard` can auto-init and seed `<project_id>.git` on first access (`GIT_AUTO_INIT=1`).
- Run a single-tenant Origin (one space's checkout) in git mode by setting:
  - `ORIGIN_GIT_REMOTE_URL=http://git-edge:8080/<project_id>.git`
  - `ORIGIN_GIT_BRANCH=main`
- The Compose `origin-gateway` service is the multi-tenant Workspace Gateway
  (`ORIGIN_MULTI_TENANT=1`, `ORIGIN_GIT_REMOTE_BASE_URL=http://git-edge:8080`, no
  `ORIGIN_GIT_REMOTE_URL`). In its workspace root, `tmp/origin-gateway-workspaces/` by default
  (`ORIGIN_GATEWAY_WORKSPACE_VOLUME`), the gateway keeps `.git-cache/` and, after an upgrade from
  an older gateway, the disposable `.legacy/`. Runtime checkouts do not belong there: the local
  provider keeps them in `tmp/runtime-checkouts/<project_id>` (`DOCKER_REPO_HOST` overrides it;
  see [Local Development](Local-Dev.md#git-canonical-local-git-service)).

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
- Run the Workspace Gateway with a persistent volume of its own as its workspace root, never the
  runtime provider's checkout folder (`DOCKER_REPO_HOST`), and an init as PID 1. Its mirror cache
  is disposable, and so are the working copies an upgrade from a stateful gateway image leaves in
  `.legacy/` (see [Retiring gateway working copies](#retiring-gateway-working-copies)). See
  [docker/README.md](../docker/README.md#deployment-and-self-hosting).

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
