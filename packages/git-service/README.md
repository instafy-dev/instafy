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

## Repo hygiene (git-shard)
`git-shard` installs a server-side `hooks/update` policy for:
- Fast-forward-only `main`
- Deny common churn paths (like `node_modules/`)
- Per-blob size caps (see `GIT_MAX_BLOB_BYTES`, `GIT_DENY_PATHS`, `GIT_POLICY_DISABLED` in `docs/Git-Service.md`)

Trusted backend cleanup may mint a 60-second, service-only `git.delete` token and send exact
`DELETE /<uuid>.git` through Git Edge. Shards must remain private; the full fail-closed contract is
documented in `docs/Git-Service.md`. Both edge and shard validate delete credentials with the
configured `GIT_JWKS_URL` and `GIT_AUDIENCE`.
Git Edge also requires the new shard's status-bound `X-Instafy-Git-Delete-Result` acknowledgement,
so an older shard cannot manufacture a successful cleanup with an ordinary Smart HTTP `404`.
