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
- `GET /capabilities` — optional features this broker is configured for: `{ privatePreviews: true, previewDomain }` when private previews are set up (below), otherwise `{ privatePreviews: false }`. Callers check it before asking for a private tunnel.
- `GET /tunnels/:id/probe?path=/` — `HEAD <path>` through `RATHOLE_UPSTREAM_HOST:<rathole port>` with a 2 s timeout. Returns `{ listening, status }`; `listening` is true only when an HTTP status line comes back, because rathole accepts the TCP connection even when nothing is behind it. `RATHOLE_UPSTREAM_HOST` is this broker's own ingress (`INGRESS_HOST:INGRESS_PORT`); a tunnel on any other ingress reports `listening: false`, because rathole ports are allocated per ingress and the same number may belong to another site here.
- `DELETE /tunnels/:id` — revoke + expire DNS records.
- Labels: `labels.kind = "preview"` lets `expires_in_seconds` run up to `PREVIEW_MAX_TTL_SECONDS` (default 43200) instead of the token TTL. `labels.visibility = "private"` (anything other than `public`) makes a private tunnel, described below; without the preview config the request fails with 400. An `idempotency_key` stays bound to the visibility it was first used with: reusing it with the other visibility returns 409 instead of the stored tunnel.
  - Optional hooks:
  - `ACL_HOOK_URL` (POST) receives `{ intent, project_id, org_id?, runtime_id?, lease_id?, idempotency_key?, metadata? }` and returns `{ allowed: bool }`. When `allowed: false`, broker denies creation. When you burn credits here, require an `idempotency_key` so repeated calls don’t double-charge.
  - `EVENT_HOOK_URL` receives fire-and-forget events `{ kind: tunnel.created|tunnel.revoked|tunnel.expired, project_id, org_id?, runtime_id?, lease_id?, data }` (`tunnel.expired` is emitted by `ingress_sidecar` when it revokes expired tunnels).
  - In Instafy deployments, point these at the runtime-controller:
    - `ACL_HOOK_URL=https://<controller>/tunnel-broker/hooks/acl`
    - `EVENT_HOOK_URL=https://<controller>/tunnel-broker/hooks/events`
    - `ACL_HOOK_TOKEN`/`EVENT_HOOK_TOKEN` must match controller `TUNNEL_BROKER_HOOK_SECRET`.

## Private previews
A private tunnel gets no router on `<uuid>.<TUNNEL_DOMAIN>`. Instead `ingress_sidecar` renders a Traefik `HostRegexp` router for `p-<26 base32>--<tunnel hex>.<PREVIEW_DOMAIN>` with three shared middlewares: `instafy-preview-auth` (forwardAuth to `PREVIEW_AUTH_ADDRESS/preview-auth`), `instafy-preview-headers` (drops `X-Frame-Options`, adds `no-referrer` and `noindex`) and `instafy-preview-errors` (502-504 pages from `/preview-error/{status}`). Private previews are off by default: if `PREVIEW_DOMAIN` or `PREVIEW_AUTH_ADDRESS` is unset, private bindings render nothing, and without all three of `PREVIEW_DOMAIN`, `PREVIEW_AUTH_ADDRESS` and `PREVIEW_AUTH_HOOK_URL`, plus a non-empty `ACL_HOOK_TOKEN` for the hook, the broker refuses private tunnels with 400 and `GET /capabilities` reports `privatePreviews: false`. `PREVIEW_DOMAIN` must not equal `TUNNEL_DOMAIN` or sit above or below it; otherwise private previews stay off.

A private tunnel's create response has no `url`. Its `hostname` (`<uuid>.<TUNNEL_DOMAIN>`) still gets DNS records but no router, so it is not a link to open. The caller makes its own label (26 lowercase base32 characters), keeps it secret, and builds `p-<label>--<tunnel_id without dashes>.<previewDomain>` from `GET /capabilities`; the hook then decides each request by `sha256(label)`. When `TRAEFIK_CERT_RESOLVER` is set, capability routers are served on `websecure` only, so the label never crosses the network over plain HTTP; without it (local stacks) they are also on `web`.

- `GET /preview-auth` (no API token; Traefik calls it) reads `X-Forwarded-Host`, refuses `Service-Worker: script` with 403, and asks `PREVIEW_AUTH_HOOK_URL` with bearer `ACL_HOOK_TOKEN`:
  ```json
  { "tunnelId": "<tunnel uuid>", "capabilityHash": "<lowercase hex sha256 of the label>" }
  → { "allow": true, "ttlSeconds": 30 }
  ```
  Allows are cached for `ttlSeconds` (at most 30 s), denials for 5 s, in separate maps so made-up labels cannot evict a member's allow. Requests that miss the cache for the same label wait on one hook call. Each tunnel gets 60 hook calls at once and 10 a second after that; past it, unknown labels are denied without asking. A key the hook allowed in the last 10 minutes is asked again outside that budget when its cached allow lapses, so a flood of made-up labels on a known tunnel cannot lock members out; the hook is still asked, so revocation keeps its delay. A hook error denies without caching. Denials return a 401 page that posts `{ type: "instafy-preview", status: 401 }` to the parent frame.
- `GET /preview-error/:status` returns the same kind of page for the given status.
- The hook path in `.env.example` (`/tunnel-broker/hooks/preview-auth`) is the controller's; that route arrives with the controller previews change and is not on the controller yet.
- The broker API process needs `PREVIEW_DOMAIN`, `PREVIEW_AUTH_ADDRESS` and `PREVIEW_AUTH_HOOK_URL`; the ingress sidecar needs the first two.

Known limits of the capability host:
- forwardAuth runs once per HTTP request or upgrade. A WebSocket or an SSE response that is already open keeps flowing after its label is revoked, its member is removed, or it idles out; only new requests get the 401. Revoking the tunnel or stopping the runtime takes the rathole service away, which should end those streams as well (not verified yet). A site that wants its streams re-checked can end them periodically so the reconnect passes forwardAuth again; the broker does not cut them. Hosted launches need entrypoint timeouts for these.
- The label is the hostname, so it also reaches places `no-referrer` does not cover: the `Origin` header of the site's own cross-origin fetches and WebSockets (for example requests to a third-party API), DNS resolvers and TLS SNI. Whoever sees it can use it while it is live, so the hook should let labels idle out and be revoked; the broker re-asks it at least every 30 s.
- The headers middleware drops the site's `X-Frame-Options` and sets no `frame-ancestors`, so any origin can frame a preview while its label is live, not only Studio. The 401 and error pages post `{ type: "instafy-preview", status }` with target `"*"`; it carries only the status, and whoever receives it must check `event.origin` against the preview host before acting on it.
- Hosted use needs more than this broker: `PREVIEW_DOMAIN` should be its own registrable domain, listed on the Public Suffix List, with wildcard DNS and TLS, so preview sites cannot set cookies for each other or for Studio; binding a label to the viewer (for example a partitioned `__Host-` cookie) needs Traefik 3.1 or later.

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
