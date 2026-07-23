#!/usr/bin/env bash
set -euo pipefail

# Simple smoke: issue a tunnel and resolve it via PowerDNS.
# Assumes services are already running (see `pnpm pdns:up`).

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BROKER_URL="http://localhost:8082"
AUTH_HEADER="Authorization: Bearer dev-token"

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

TUNNEL_ID=$(printf "%s" "$RESPONSE" | jq -r '.tunnel.tunnel_id // empty')
HOSTNAME=$(printf "%s" "$RESPONSE" | jq -r '.tunnel.hostname')
if [[ -z "${HOSTNAME:-}" || "$HOSTNAME" == "null" ]]; then
  echo "Failed to parse hostname from response: $RESPONSE" >&2
  exit 1
fi

echo "Resolving via PowerDNS on 127.0.0.1:1053 for $HOSTNAME..."
RESOLVED=""
LAST_OUTPUT=""
DIG_OPTS="+tcp +tries=1 +time=1"
for i in {1..20}; do
  LAST_OUTPUT=$(dig +short $DIG_OPTS "@127.0.0.1" -p 1053 "$HOSTNAME" A 2>&1 | head -n 5 | tr -d '\r' || true)
  if [[ "$LAST_OUTPUT" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    RESOLVED="$LAST_OUTPUT"
    break
  fi
  sleep 0.5
done

if [[ -z "$RESOLVED" ]]; then
  echo "DNS did not resolve $HOSTNAME via PowerDNS (last output: ${LAST_OUTPUT:-<empty>})" >&2
  exit 1
fi

echo "$RESOLVED"

if [[ -n "${TUNNEL_ID:-}" && "$TUNNEL_ID" != "null" ]]; then
  echo "Revoking tunnel $TUNNEL_ID..."
  curl -sf -X DELETE "$BROKER_URL/tunnels/$TUNNEL_ID" -H "$AUTH_HEADER" >/dev/null || true
fi
