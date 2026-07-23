#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BROKER_URL="${BROKER_URL:-http://localhost:8082}"
AUTH_HEADER="Authorization: Bearer dev-token"
TRAEFIK_HTTP_PORT="${PUBLIC_INGRESS_HTTP_PORT:-8083}"
TRAEFIK_URL="${TRAEFIK_URL:-http://localhost:${TRAEFIK_HTTP_PORT}}"
TRAEFIK_CONFIG_PATH="${TRAEFIK_CONFIG_PATH:-config/traefik/dynamic.yml}"
TRAEFIK_CONFIG_WAIT_ATTEMPTS="${TRAEFIK_CONFIG_WAIT_ATTEMPTS:-120}"
TRAEFIK_REACHABILITY_WAIT_ATTEMPTS="${TRAEFIK_REACHABILITY_WAIT_ATTEMPTS:-120}"
INGRESS_PORT="${INGRESS_PORT:-37000}"
CLIENT_CONFIG_PATH="config/rathole/client.toml"

echo "Starting smoke HTTP origin..."
docker compose --profile ingress --profile ingress-smoke up -d smoke-http

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
TOKEN=$(printf "%s" "$RESPONSE" | jq -r '.tunnel.client.token // .tunnel.token')
SERVICE=$(printf "%s" "$RESPONSE" | jq -r '.tunnel.client.service // .tunnel.client.serviceName // empty')

if [[ -z "${HOSTNAME:-}" || "$HOSTNAME" == "null" ]]; then
  echo "Failed to parse hostname from response: $RESPONSE" >&2
  exit 1
fi
if [[ -z "${TOKEN:-}" || "$TOKEN" == "null" ]]; then
  echo "Failed to parse token from response: $RESPONSE" >&2
  exit 1
fi
if [[ -z "${SERVICE:-}" || "$SERVICE" == "null" ]]; then
  echo "Failed to parse rathole service from response: $RESPONSE" >&2
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

cat > "$CLIENT_CONFIG_PATH" <<EOF
[client]
remote_addr = "rathole:${INGRESS_PORT}"
default_token = "${TOKEN}"

[client.services.${SERVICE}]
type = "tcp"
local_addr = "smoke-http:80"
EOF

echo "Starting rathole client..."
docker compose --profile ingress --profile ingress-smoke up -d rathole-client

echo "Waiting for reachability through Traefik ($TRAEFIK_URL) for $HOSTNAME..."
BODY=""
for ((i = 0; i < TRAEFIK_REACHABILITY_WAIT_ATTEMPTS; i++)); do
  BODY=$(curl -sk -H "Host: $HOSTNAME" "$TRAEFIK_URL/" || true)
  if [[ "$BODY" == *"Hostname"* ]]; then
    break
  fi
  sleep 0.5
done

if [[ "$BODY" != *"Hostname"* ]]; then
  echo "Did not receive expected response via Traefik for $HOSTNAME" >&2
  echo "$BODY" >&2
  exit 1
fi

echo "Reachability OK."

if [[ -n "${TUNNEL_ID:-}" && "$TUNNEL_ID" != "null" ]]; then
  echo "Revoking tunnel $TUNNEL_ID..."
  curl -sf -X DELETE "$BROKER_URL/tunnels/$TUNNEL_ID" -H "$AUTH_HEADER" >/dev/null || true
fi

rm -f "$CLIENT_CONFIG_PATH" || true
