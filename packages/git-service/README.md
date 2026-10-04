# Instafy Git Service (edge + shard)

This package provides two binaries used in **git-canonical** mode:

- `git-edge`: stateless HTTPS front door (auth + shard routing).
- `git-shard`: stateful repo node (stores bare repos + serves Git Smart HTTP via `git http-backend`).

Docs: `docs/Git-Service.md`.

## Local dev (docker compose)
The dev stack runs `git-edge`, `git-shard-0`, and `origin-gateway` via
`docker/docker-compose.runtime.yml` when `GIT_CANONICAL=1`. They share the
local-only `git-services:local` image so their overlapping Rust dependencies
compile once. Production continues to build and deploy three separate minimal
images from their dedicated Dockerfiles.

## Repository policy (git-shard)
`git-shard` writes shared `update` and `post-receive` hooks to `<GIT_REPO_ROOT>/.instafy-hooks/` at
startup and runs every `git http-backend` with `core.hooksPath` pointing there, so requests never
write hook files or repository config, and hooks inside a repository are ignored. It refuses to
start if the hooks cannot run or git ignores the command-scope configuration. The policy covers:
- Fast-forward-only `main`, with letter-case variants of its name refused
- Deny common churn paths (like `node_modules/`, from `REPO_POLICY_DENY_PATTERNS` in `src/policy.rs`)
- Per-blob size caps, checked on the net change between the old and new tip, merges included
- Object checks (`receive.fsckObjects`) and a push size bound (`GIT_MAX_PUSH_BYTES`)
- Salvage refs (`refs/instafy/salvage/**`, any letter case) that no push can move or delete; only
  a push carrying the controller's exact `git.salvage` credential may create one, under
  `refs/instafy/salvage/gateway/`
- Only recovery refs (`refs/instafy/recovery/<origin id>/<name>`) may be created under `refs/instafy/`

See `GIT_MAX_BLOB_BYTES`, `GIT_DENY_PATHS`, `GIT_MAX_PUSH_BYTES` and `GIT_POLICY_DISABLED` in
`docs/Git-Service.md`. `tests/shard_push_policy.rs` runs the real `git-shard` binary against a git
client to cover the policy end to end.

The policy module is the one copy of these rules. `origin-http-server` depends on this crate with
`default-features = false`, which builds only `policy`; the `server` feature (on by default) adds
the edge and shard and their dependencies.

Trusted backend cleanup may mint a 60-second, service-only `git.delete` token and send exact
`DELETE /<uuid>.git` through Git Edge. Shards must remain private; the full fail-closed contract is
documented in `docs/Git-Service.md`. Both edge and shard validate delete credentials with the
configured `GIT_JWKS_URL` and `GIT_AUDIENCE`.
Git Edge also requires the new shard's status-bound `X-Instafy-Git-Delete-Result` acknowledgement,
so an older shard cannot manufacture a successful cleanup with an ordinary Smart HTTP `404`.
