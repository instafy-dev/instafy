# Origin HTTP Server (Rust)

Rust implementation of the workspace origin service that now ships inside the runtime agent. The server validates controller-issued JWTs, exposes read endpoints for the workspace filesystem, and applies multi-file updates atomically.

## Key Features
- Axum-based HTTP server with `/entries`, `/files/:path`, `/raw/:path`, `POST /apply`, `POST /git/sync` and `POST /git/flush` routes.
- EdDSA token validation through the controller JWKS (Ed25519 public keys).
- Safe path handling + staging writes via temporary files before atomic promotion.
- Optional commit receipt + presence heartbeat back to the controller when `ORIGIN_INTERNAL_TOKEN` is provided.
- Optional **git-canonical** mode: clone/fetch a remote repo into the workspace, apply changes via `POST /apply`, then persist to the canonical remote via an explicit `POST /git/sync` step (commit, then publish by merge).

## Running Locally
```bash
cargo run
```

Environment variables mirror the previous TypeScript stub (`ORIGIN_PROJECT_ID`, `ORIGIN_ID`, `ORIGIN_WORKSPACE_ROOT`, `ORIGIN_CONTROLLER_URL`, etc.). See `src/main.rs` for defaults. `cargo test --manifest-path packages/origin-http-server/Cargo.toml` exercises the crate.

### Git-canonical mode (workspace gateway)
Set `ORIGIN_GIT_REMOTE_URL` to enable git-backed persistence:
- `ORIGIN_GIT_REMOTE_URL`: git remote URL (SSH or HTTPS)
- `ORIGIN_GIT_BRANCH`: branch to track/push (default: `main`)
- `ORIGIN_GIT_REMOTE_NAME`: remote name (default: `origin`)
- `ORIGIN_GIT_AUTHOR_NAME` / `ORIGIN_GIT_AUTHOR_EMAIL`: commit identity defaults

In this mode:
- The origin bootstraps a checkout on start (`git clone`/`git fetch`).
- `POST /apply` applies file changes to the workspace (no git operations). On a workspace runtime or Desktop origin, the manifest may carry `expected: {path: blobId | null}`; if any path no longer holds the blob the client read, the whole apply fails with `409 {code: "head_moved", paths}` and nothing is written. `/files` and `/raw` send the served bytes' blob id in `X-Instafy-Blob`, and `/entries` lists `blobOid` for files up to 2 MiB.
- `POST /git/sync` publishes. See "Publishing" below. The multi-tenant gateway keeps its older commit-and-push until its working copies are retired.
- Reserved paths like `.git/` and `.instafy/origin-staging/` are hidden from the filesystem API and rejected for applies.

### Publishing (workspace runtimes and Desktop)
Canonical `main` is the truth, and nothing here forces, rebases or resets it (`src/publish.rs`):
- `POST /git/sync {paths}` commits those paths (only those, from a temporary index, so other staged work stays staged), and `{}` commits every changed path that is not ignored. `{mode: "refresh"}` commits nothing: it pushes parked work, publishes commits already on the branch and moves the checkout to `main`. The runtime agent calls it before every turn. A process hosting the origin can also run a read-only refresh in process (`OriginHttpServer::checkout_refresher`), for a turn without a workspace lease: it fetches with the origin's own `git.read` credential, moves the checkout only when it holds nothing unpublished, and pushes nothing. It has no HTTP route.
- The local branch L reaches `main` by a plain push: a fast-forward when `main` has not moved, otherwise one merge commit on the fetched tip R (`src/tree_merge.rs`, git 2.34 plumbing only). Every local commit keeps its id, author and message. A lost race is fetched and retried; a lost response is checked against the remote before retrying.
- Paths both sides changed keep `main`'s version; the local version goes to a `conflict` recovery ref, and a Desktop folder keeps the user's bytes on disk as a local edit. Work that cannot be published at all goes to an `unpublished` recovery ref and is retried later.
- Paths that may never be published (`src/publish_policy.rs`: the shard's deny list, Instafy metadata, secret files such as `.env*` and private keys, legacy chat uploads, files over 20 MiB) keep their saved version: never-pushed local commits are rewritten locally so the path keeps its earlier content, and the response reports it. A path the shard refuses by name is dropped and the push retried.
- The response carries `rev` (P), `baseRev` (R), `gitSyncStatus` (`published`, `partial`, `unchanged` or `unpublished`), `conflictedPaths`, `rejectedPaths` (`{path, reason, keptSavedVersion}`), `recoveryRef` and `recoveryRefs`. When nothing could be saved the route answers 409 (or 503 when retrying can help) with the same fields and `code: "not_saved"`.
- `POST /git/revert-commit {commit, base?}` applies the inverse to the index and the files it touches (409 `dirty_paths` if one has unsaved edits, 409 `revert_conflict` if later changes overlap), commits it and publishes.
- `POST /git/flush {turnActive}` runs before the controller stops a hosted runtime (Desktop folders are refused): it publishes finished local commits (none while a turn is active), parks unsaved edits (and an unfinished turn's commits) on recovery refs, and pushes every never-pushed local recovery ref. It never publishes dirty files to `main`. The controller calls it with a short-lived `fs.write` token for the workspace lease holder, which the server exchanges for `git.write`; without it the work stays on local refs. The response lists `recoveryRefs`, `parkedCommits`, `publish` (when finished commits were published) and `unpushedRefs` with `unpushedRefNames`, the local refs still waiting for a push. The process's own shutdown does the same without network or credentials on hosted checkouts only, leaving the refs local for the next publish.

Recovery refs (`src/recovery.rs`) are built without moving HEAD and stored first as `refs/instafy/local-recovery/<name>`, named `<UTC time>-<kind>-<content hash>` so the same work is stored once. A holder of `git.write` pushes them to `refs/instafy/recovery/<origin id>/<name>`; only after the remote confirms the commit does the local ref move to `refs/instafy/local-recovery-pushed/<name>`. A pushed ref whose canonical copy later disappears was dismissed and is never published again. Before its first publish, a checkout left behind by the older sync is repaired once (`src/stale_align.rs`): copies that match the pre-reset version are put back to the saved version, other edits are merged or parked on a `stale` recovery ref.
- Network git commands are bounded: every git command the server runs against the remote (all built by `server_git_command`) sets `http.lowSpeedLimit=1000` and `http.lowSpeedTime=300` (and pins `GIT_HTTP_LOW_SPEED_LIMIT`/`GIT_HTTP_LOW_SPEED_TIME` to match), so a fetch, push or ls-remote whose transfer stays below 1000 bytes/s for 300 seconds fails with `Operation too slow`. The window is wide enough for a push waiting on the remote's update hook. curl does not check speed while connecting, but gives up on an unanswered connect after its default 300 second connect timeout. A remote that stops responding fails the current command after one window (about five minutes) instead of holding the workspace lock indefinitely. The bound is on silence, not on total duration: a peer that keeps sending, or goes quiet for less than 300 seconds at a time, is not cut off.

## Follow-ups
- Add integration tests that spin the server with a temporary workspace and hit each endpoint (especially multipart apply + delete scenarios).
- Extend staging to fsync parent directories on delete paths and consider journaling for recovery.
- Expand the presence heartbeat metadata once the controller surface is finalized (latency, disk usage, etc.).
- Replace the Playwright desktop-origin harness with this binary once the controller `/entries` + `/files` APIs ship in production.
