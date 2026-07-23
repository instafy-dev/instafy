# Origin HTTP Server (Rust)

Rust implementation of the workspace origin service that now ships inside the runtime agent. The server validates controller-issued JWTs, exposes read endpoints for the workspace filesystem, and applies multi-file updates atomically.

## Key Features
- Axum-based HTTP server with `/entries`, `/files/:path`, `/raw/:path`, `POST /apply`, and `POST /git/sync` routes.
- EdDSA token validation through the controller JWKS (Ed25519 public keys).
- Safe path handling + staging writes via temporary files before atomic promotion.
- Optional commit receipt + presence heartbeat back to the controller when `ORIGIN_INTERNAL_TOKEN` is provided.
- Optional **git-canonical** mode: clone/fetch a remote repo into the workspace, apply changes via `POST /apply`, then persist to the canonical remote via an explicit `POST /git/sync` step (commit + push).

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
- `POST /apply` applies file changes to the workspace (no git operations).
- `POST /git/sync` stages non-reserved dirty paths, creates a commit (caller-provided message), then pushes (fast-forward-only with a fetch/rebase retry loop).
- Reserved paths like `.git/` and `.instafy/origin-staging/` are hidden from the filesystem API and rejected for applies.

## Follow-ups
- Add integration tests that spin the server with a temporary workspace and hit each endpoint (especially multipart apply + delete scenarios).
- Extend staging to fsync parent directories on delete paths and consider journaling for recovery.
- Expand the presence heartbeat metadata once the controller surface is finalized (latency, disk usage, etc.).
- Replace the Playwright desktop-origin harness with this binary once the controller `/entries` + `/files` APIs ship in production.
