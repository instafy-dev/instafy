# Tunnel Broker (Rust)

Self-contained tunnel service for Instafy. Issues tunnel assignments, writes DNS records, and returns client configs (rathole-first). This package stays isolated from the controller/frontend so it can be open-sourced or reused independently.

## Layout
- `crates/tunnel-broker` — API service (Axum), Postgres-backed state, DNS + ingress orchestration hooks.
- `crates/tunnel-broker-types` — shared request/response contracts and common types.
- `config/` — sample config for PowerDNS and rathole server.
- `docker-compose.yml` — local stack (Postgres + broker + placeholders for PowerDNS/rathole).

## Dev quickstart
1. Install Rust (1.75+) and Docker.
2. Copy `.env.example` to `.env` and tweak defaults.
3. Run the stack:
   ```sh
   cd packages/tunnel-broker
   docker compose up --build
   ```
   The broker listens on `localhost:8082` by default. Postgres is exposed on `localhost:5545`.
   For full ingress (rathole + Traefik), run:
   ```sh
   docker compose --profile ingress up --build
   ```
   Traefik listens on `localhost:8083` (HTTP). Port `8443` is available for
   HTTPS when a certificate resolver is configured.
4. Hit the health check:
   ```sh
   curl http://localhost:8082/healthz
   ```
5. Create a tunnel (stubbed DNS + rathole config for now):
   ```sh
   curl -X POST http://localhost:8082/tunnels \
     -H "content-type: application/json" \
     -H "authorization: Bearer ${BROKER_API_TOKEN:?set BROKER_API_TOKEN}" \
     -d '{"project_id":"11111111-1111-1111-1111-111111111111","org_id":"22222222-2222-2222-2222-222222222222"}'
   ```
6. (Optional) PowerDNS: run `docker compose --profile pdns up pdns` to serve `rt.test` records directly from Postgres. Resolve with `dig @127.0.0.1 -p1053 <hostname>.rt.test A`.

## Notes
- Migrations live under `crates/tunnel-broker/migrations`; the service runs them automatically on start.
- DNS is served via PowerDNS (gpgsql) and rathole provides per-tunnel TCP ingress. Traefik can optionally front rathole to route hostnames to the right binding.
- Auth: `BROKER_API_TOKENS` (comma-separated) protects tunnel endpoints; empty means allow-all (dev only). Tunnel tokens returned to clients are signed JWTs using `TOKEN_SIGNING_KEY` / `TOKEN_ISSUER` (optional `TOKEN_AUDIENCE`) and default TTL `TUNNEL_TOKEN_TTL_SECONDS`.
- Rathole tokens: set `RATHOLE_SHARED_TOKEN` to force a shared client token (matching rathole `default_token`) if you want to skip per-tunnel tokens.
- Revocation clears the stored client token and its expiry before the broker
  reports success. The database constraint rejects any future transition that
  would leave credential material on a revoked tunnel row.
- Ingress nodes: every ingress node should run `ingress_sidecar` with its own `INGRESS_HOST`/`INGRESS_PORT` and public `INGRESS_IPV4`/`INGRESS_IPV6`. The sidecar upserts the `ingress_nodes` row (acting as a simple heartbeat) and renders configs for that ingress node only.
- Rathole bindings: broker allocates per-tunnel `rathole_service` and `rathole_port` from `RATHOLE_PORT_RANGE_START/END`, scoped per ingress node (ports can be reused across ingress nodes). Use `cargo run --bin render_rathole` (or set `RATHOLE_CONFIG_OUTPUT`) to render the server config for the local ingress node.
- Ingress sidecar: `cargo run --bin ingress_sidecar` periodically revokes expired tunnels for the local ingress node, rerenders `server.toml` from Postgres, optionally reloads rathole via `RATHOLE_RELOAD_COMMAND` or `RATHOLE_PID_FILE`, and writes Traefik dynamic config when `TRAEFIK_CONFIG_OUTPUT` is set. New tunnel writes also emit Postgres `NOTIFY` on `RATHOLE_CONFIG_NOTIFY_CHANNEL` so ingress nodes can refresh immediately after commit instead of waiting for the next polling tick.
- Public URL: `PUBLIC_INGRESS_PORT` controls the port embedded in `TunnelDescriptor.url` (defaults to `INGRESS_PORT`). Keep it at `443` in production if rathole control runs on a separate port.
- Credits: controller owns burns. Broker is credit-agnostic; use ACL and event hooks to let the controller decide when to burn or block tunnel creation.
- PowerDNS: uses standard `domains`/`records` tables with the gpgsql backend. The broker writes per-tunnel `A/AAAA` records into `records`, while `dns_sidecar` keeps zone apex `NS`/`SOA` + glue (`ns*.A/AAAA`) in sync with `dns_nodes`. PowerDNS API can be enabled to support Let’s Encrypt DNS-01 (wildcard certificates) by creating `_acme-challenge` `TXT` records.
- DNSSEC: the delegated tunnel zone is unsigned by default. Keep DNSSEC disabled in PowerDNS (`gpgsql-dnssec=no`) unless you also provision signing keys + DS records; enabling DNSSEC without signing can cause `SERVFAIL` for resolvers that request DNSSEC.
- Hooks: optional `ACL_HOOK_URL` (allow/deny) and `EVENT_HOOK_URL` (fire-and-forget) let external services authorize/observe tunnel lifecycle without coupling the broker to credits. In Instafy, point these at the controller (`/tunnel-broker/hooks/acl` + `/tunnel-broker/hooks/events`) and set `ACL_HOOK_TOKEN`/`EVENT_HOOK_TOKEN` to `TUNNEL_BROKER_HOOK_SECRET`.
- Keep tunnel-specific tests and docker-based smokes inside this package to avoid coupling with the controller/frontend repos.

## Local PDNS smoke
Run the end-to-end resolver check (requires Docker and `jq`/`dig`):
```sh
cd packages/tunnel-broker
pnpm test:pdns
```
This brings up Postgres + broker + PowerDNS, requests a tunnel, and resolves the hostname via PowerDNS on `127.0.0.1:1053`.

## Local PDNS API smoke (ACME DNS-01)
Verifies PowerDNS API can write an ACME-style TXT record (requires Docker and `jq`/`dig`):
```sh
cd packages/tunnel-broker
pnpm test:pdns:api
```

## Local ingress smoke
Validate rathole + Traefik config rendering:
```sh
cd packages/tunnel-broker
pnpm test:ingress
```

## Local ingress reachability smoke
Starts a tiny HTTP origin + rathole client in Docker and curls through Traefik:
```sh
cd packages/tunnel-broker
pnpm test:ingress:reachability
```
