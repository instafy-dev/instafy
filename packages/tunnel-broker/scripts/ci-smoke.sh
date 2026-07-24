#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="$(mktemp -d)"
cp config/rathole/server.toml "$BACKUP_DIR/server.toml"
cp config/traefik/dynamic.yml "$BACKUP_DIR/dynamic.yml"

cleanup() {
  docker compose \
    --profile pdns \
    --profile ingress \
    --profile ingress-smoke \
    down --timeout 2 --volumes --remove-orphans || true
  cp "$BACKUP_DIR/server.toml" config/rathole/server.toml
  cp "$BACKUP_DIR/dynamic.yml" config/traefik/dynamic.yml
  rm -f config/rathole/client.toml
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

# The workflow preloads the content-addressed tunnel-broker:local image. Keep
# one Postgres/broker fixture alive for both distinct integration contracts so
# the probes do not rebuild the same release binary or tear each other down.
docker compose --profile pdns --profile ingress up -d \
  postgres broker pdns rathole traefik
docker compose --profile ingress up -d rathole-sidecar

bash ./scripts/pdns-smoke.sh
bash ./scripts/ingress-reachability-smoke.sh
