#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BROKER_URL="${BROKER_URL:-http://localhost:8082}"
AUTH_HEADER="Authorization: Bearer dev-token"
TRAEFIK_CONFIG_PATH="${TRAEFIK_CONFIG_PATH:-config/traefik/dynamic.yml}"
TRAEFIK_CONFIG_WAIT_ATTEMPTS="${TRAEFIK_CONFIG_WAIT_ATTEMPTS:-120}"

echo "Waiting for broker health..."
HEALTH_OK=false
for i in {1..60}; do
  if curl -sf "$BROKER_URL/healthz" >/dev/null; then
    HEALTH_OK=true
    break
  fi
  sleep 0.5
done

if [[ "$HEALTH_OK" != "true" ]]; then
  echo "Broker did not become healthy at $BROKER_URL" >&2
  exit 1
fi

echo "Requesting tunnel..."
RESPONSE=$(curl -sf -X POST "$BROKER_URL/tunnels" \
  -H "content-type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{"project_id":"11111111-1111-1111-1111-111111111111"}')

TUNNEL_ID=$(printf "%s" "$RESPONSE" | jq -r '.tunnel.tunnel_id')
HOSTNAME=$(printf "%s" "$RESPONSE" | jq -r '.tunnel.hostname')
REMOTE_PORT=$(printf "%s" "$RESPONSE" | jq -r '.tunnel.client.remote_port // empty')

if [[ -z "${HOSTNAME:-}" || "$HOSTNAME" == "null" ]]; then
  echo "Failed to parse hostname from response: $RESPONSE" >&2
  exit 1
fi

echo "Waiting for Traefik dynamic config to include $HOSTNAME..."
for ((i = 0; i < TRAEFIK_CONFIG_WAIT_ATTEMPTS; i++)); do
  if grep -Fq -- "Host(\`${HOSTNAME}\`)" "$TRAEFIK_CONFIG_PATH" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! grep -Fq -- "Host(\`${HOSTNAME}\`)" "$TRAEFIK_CONFIG_PATH"; then
  echo "Traefik dynamic config was not updated at $TRAEFIK_CONFIG_PATH" >&2
  cat "$TRAEFIK_CONFIG_PATH" >&2 || true
  exit 1
fi

if [[ -n "${REMOTE_PORT:-}" ]]; then
  if ! grep -q "http://rathole:${REMOTE_PORT}" "$TRAEFIK_CONFIG_PATH"; then
    echo "Traefik config missing backend port $REMOTE_PORT" >&2
    cat "$TRAEFIK_CONFIG_PATH" >&2
    exit 1
  fi
fi

echo "Traefik config updated OK."

if [[ -n "${TUNNEL_ID:-}" && "$TUNNEL_ID" != "null" ]]; then
  echo "Revoking tunnel $TUNNEL_ID..."
  curl -sf -X DELETE "$BROKER_URL/tunnels/$TUNNEL_ID" -H "$AUTH_HEADER" >/dev/null || true
fi
