#!/usr/bin/env bash
set -euo pipefail

# Smoke: ensure PowerDNS API can write an ACME-style TXT record (DNS-01).
# Assumes services are already running (see `pnpm pdns:up`).

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TUNNEL_DOMAIN="${TUNNEL_DOMAIN:-rt.test}"
BROKER_URL="${BROKER_URL:-http://localhost:8082}"
PDNS_API_BASE="${PDNS_API_BASE:-http://localhost:18081/api/v1}"
PDNS_API_KEY="${PDNS_API_KEY:-dev-pdns-key}"

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

echo "Waiting for PowerDNS API..."
API_OK=false
for i in {1..60}; do
  if curl -sf -H "X-API-Key: $PDNS_API_KEY" "$PDNS_API_BASE/servers" >/dev/null; then
    API_OK=true
    break
  fi
  sleep 0.5
done

if [[ "$API_OK" != "true" ]]; then
  echo "PowerDNS API did not become reachable at $PDNS_API_BASE" >&2
  exit 1
fi

ZONE="${TUNNEL_DOMAIN}."
NAME="_acme-challenge.${TUNNEL_DOMAIN}."
TOKEN="instafy-smoke-$(date +%s)-$RANDOM"
CONTENT="\"$TOKEN\""

PAYLOAD=$(jq -n \
  --arg name "$NAME" \
  --arg content "$CONTENT" \
  '{
    rrsets: [
      {
        name: $name,
        type: "TXT",
        ttl: 60,
        changetype: "REPLACE",
        records: [{ content: $content, disabled: false }]
      }
    ]
  }')

echo "Creating TXT record via PowerDNS API: $NAME"
curl -sf -X PATCH \
  -H "X-API-Key: $PDNS_API_KEY" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" \
  "$PDNS_API_BASE/servers/localhost/zones/$ZONE" >/dev/null

echo "Resolving TXT via PowerDNS on 127.0.0.1:1053..."
RESOLVED=""
for i in {1..20}; do
  RESOLVED=$(dig +short "@127.0.0.1" -p 1053 "$NAME" TXT 2>/dev/null || true)
  if [[ -n "$RESOLVED" ]]; then
    break
  fi
  sleep 0.5
done

if [[ "$RESOLVED" != *"$TOKEN"* ]]; then
  echo "TXT did not resolve (expected token). got=$RESOLVED" >&2
  exit 1
fi

echo "Resolved: $RESOLVED"

DELETE_PAYLOAD=$(jq -n --arg name "$NAME" '{
  rrsets: [
    {
      name: $name,
      type: "TXT",
      changetype: "DELETE"
    }
  ]
}')

echo "Cleaning up TXT record..."
curl -sf -X PATCH \
  -H "X-API-Key: $PDNS_API_KEY" \
  -H "Content-Type: application/json" \
  --data "$DELETE_PAYLOAD" \
  "$PDNS_API_BASE/servers/localhost/zones/$ZONE" >/dev/null || true

echo "OK"
