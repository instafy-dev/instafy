# Integration Notes (Controller + Runtime)

This broker + PDNS path is meant to stay isolated from the controller/frontend codebases. Use these guidelines to wire it in without leaking broker logic elsewhere.

## Broker API (current shape)
- Auth: `Authorization: Bearer <token>` (from `BROKER_API_TOKENS`).
- `POST /tunnels` body:
  ```json
  {
    "project_id": "uuid",
    "org_id": "uuid",             // optional, passed through to hooks and stored
    "runtime_id": "uuid?",        // optional
    "lease_id": "uuid?",          // optional
    "expires_in_seconds": 900,    // optional; clamped to token TTL
    "labels": { "source": "controller" }
  }
  ```
  Response: `{ tunnel: { tunnel_id, hostname, ingress_host, ingress_port, token, token_expires_at, url?, client: { server, token, hostname, protocol } }, credit?: null }`
- `GET /tunnels/:id` — fetch descriptor.
- `DELETE /tunnels/:id` — revoke + expire DNS records.
  - Optional hooks:
  - `ACL_HOOK_URL` (POST) receives `{ intent, project_id, org_id?, runtime_id?, lease_id?, idempotency_key?, metadata? }` and returns `{ allowed: bool }`. When `allowed: false`, broker denies creation. When you burn credits here, require an `idempotency_key` so repeated calls don’t double-charge.
  - `EVENT_HOOK_URL` receives fire-and-forget events `{ kind: tunnel.created|tunnel.revoked|tunnel.expired, project_id, org_id?, runtime_id?, lease_id?, data }` (`tunnel.expired` is emitted by `ingress_sidecar` when it revokes expired tunnels).
  - In Instafy deployments, point these at the runtime-controller:
    - `ACL_HOOK_URL=https://<controller>/tunnel-broker/hooks/acl`
    - `EVENT_HOOK_URL=https://<controller>/tunnel-broker/hooks/events`
    - `ACL_HOOK_TOKEN`/`EVENT_HOOK_TOKEN` must match controller `TUNNEL_BROKER_HOOK_SECRET`.

## Controller wiring (recommended)
1. Configure broker base URL + bearer token in controller env (keep separate from runtime/Studio env).
2. On desktop runtime start (or hosted runtime needing a tunnel):
   - Call `POST /tunnels` with `{ project_id, org_id, runtime_id, lease_id }`.
   - Persist `tunnel_id`, `hostname`, `token`, `token_expires_at`, and `url` into your `runtime_tunnel_grants` (or equivalent) row.
   - Broker does not burn credits. Run your own burn in the controller before/after the call (or have the ACL hook enforce quotas).
3. Reuse `token_expires_at` to schedule refresh/revoke. No refresh endpoint yet; for now re-request a new tunnel when expiring and revoke the old one.
4. On shutdown/lease end: `DELETE /tunnels/:id` and mark grant revoked.
5. Credits: controller owns burns. Broker remains credit-agnostic by design.

## Runtime wiring (rathole client)
- Use `tunnel.client` fields to start the rathole client (server host:port, token, hostname, service). Default protocol is TCP; extend when HTTP mappings land.
- Stop the client when the controller instructs revoke or when `token_expires_at` passes.
- If your ingress uses a single shared rathole `default_token`, set broker `RATHOLE_SHARED_TOKEN` to the same value so clients can connect.
- Per-tunnel ingress ports/services are allocated in Postgres; render `server.toml` via `cargo run --bin render_rathole` and hot-reload rathole on changes.
- For automated sync on ingress nodes, run `cargo run --bin ingress_sidecar` with `RATHOLE_CONFIG_OUTPUT` pointing at your rathole config path.

## DNS (PowerDNS)
- PDNS (gpgsql backend) reads from standard `domains` / `records` tables. In dev, `docker compose --profile pdns up pdns` exposes DNS on `127.0.0.1:1053`.
- Zone/domain is seeded from `TUNNEL_DOMAIN`. `dns_sidecar` keeps the zone apex (`NS`/`SOA`) and glue (`ns*.A/AAAA`) in sync with the `dns_nodes` table.
- The broker writes per-tunnel `A/AAAA` records into `records` so hostnames resolve to the chosen ingress node.
- For wildcard TLS (Let’s Encrypt DNS-01), enable the PowerDNS API and let Traefik/lego create `_acme-challenge` `TXT` records via the API. This requires `records` to be writable (no views).
- DNSSEC: the tunnel zone is unsigned by default. Keep DNSSEC disabled in PowerDNS (`gpgsql-dnssec=no`) unless you also provision signing keys + DS records; enabling DNSSEC without signing can cause `SERVFAIL` for resolvers that request DNSSEC.

### Dedicated DNS nodes (recommended at scale)
If you run DNS separately from ingress, populate `dns_nodes` with the authoritative nameserver labels + IPs (e.g. `ns1`, `ns2`). The broker-generated `pdns_records` view will emit NS + glue records for these nodes at the zone apex.

The simplest way to keep this up to date is to run `dns_sidecar` on each DNS node with:
- `DNS_NODE_HOSTNAME=ns<N>` (e.g. `ns1`)
- `DNS_NODE_IPV4`/`DNS_NODE_IPV6` set to the public IPs
- `DATABASE_URL` set to the shared Postgres

If `dns_nodes` is empty, the view falls back to a single `ns1.<zone>` pointing at the most recently updated ingress node (dev convenience).

## Local smoke
Run `pnpm test:pdns` from `packages/tunnel-broker` to bring up Postgres + broker + PDNS, issue a tunnel, and resolve it via `dig @127.0.0.1 -p1053 <hostname> A`.
Run `pnpm test:pdns:api` to verify PowerDNS API can write an ACME-style `_acme-challenge` `TXT` record.

## Future hooks
- Add refresh endpoint for token rotation.
- Add metrics/health endpoints for DNS/ingress nodes.
- Optional: expose PDNS stats or AXFR to a secondary if you deploy multiple DNS nodes.
- Expose credit snapshot in responses when burns occur (matching controller metadata), and align burn amount with controller config.

## Multi-ingress (production)
- Every ingress node runs:
  - `rathole` (server)
  - optional `traefik` (HTTP routing)
  - `ingress_sidecar` (heartbeat + renders configs from Postgres)
- Each ingress node should have a unique `INGRESS_HOST` (or host:port pair) and must set `INGRESS_IPV4`/`INGRESS_IPV6` so the broker can:
  - return the correct rathole server endpoint in `tunnel.client.server`
  - write tunnel A/AAAA records pointing at that ingress IP
- Rathole ports are allocated per ingress node (same port ranges can be reused across nodes). The broker picks an ingress node (currently: least active tunnels) and persists `ingress_id` into the tunnel record.
