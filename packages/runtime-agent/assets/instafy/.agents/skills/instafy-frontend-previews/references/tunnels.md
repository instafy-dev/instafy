# Public tunnels for a preview

Only after the person agreed to a public link (see SKILL.md, "Public links").

## When the preview is tunneled (backend + login caveats)

A tunneled preview is a **new website origin**. Things that work on your laptop can break elsewhere until a few settings are updated.

- Remote devices can’t reach `localhost`. If the frontend calls `http://127.0.0.1:*` / `localhost`, fix it by using a reachable backend (tunnel the backend too, run it in a hosted runtime) or proxy via same-origin paths (e.g. `/api`).
- Some backends/auth providers only trust specific website URLs. If sign-in/callbacks fail, the preview URL likely needs to be added to an allowlist (“Redirect URLs”, “Callback URLs”, “Site URL”, etc). Prefer **stable** preview hostnames; if the user wants “auto-fix”, request a management token via `request_secret`.
- Some dev servers block unknown `Host` headers (example: Vite). If the preview shows “Blocked request…host is not allowed”, add the tunnel domain with a leading dot to Vite `server.allowedHosts`: the host of the URL that `instafy tunnel start` printed, without its first part (for `https://abc123.example.com` that is `".example.com"`; locally `".rt.test"`).

## Instafy tunnel flow (what this means)

Instafy tunnels are **controller-managed grants**:
- You request a tunnel grant from the controller (optionally specifying `localPort` + `purpose`).
- The response includes a `publicUrl`/`hostname` plus credentials for a local client (self-hosted tunnels use `rathole`).
- You run the tunnel client locally to forward `127.0.0.1:<port>` to that public URL.

Two common ways to do this:

1) **Via Instafy CLI** (preferred when available on the machine running the dev server):
- `instafy tunnel start --port <port> --json` (best for parsing/storing state)
- `instafy tunnel list` / `instafy tunnel logs <tunnelId> --follow` / `instafy tunnel stop <tunnelId>`

2) **Via controller API + rathole** (advanced):
- Request: `POST /projects/<projectId>/tunnels/request` with controller configured for self-hosted tunnels (`TUNNEL_BROKER_BASE_URL`, `TUNNEL_BROKER_TOKEN`).
  - Include `metadata.localPort=<port>` and `metadata.purpose="preview"` (or pass `localPort`/`purpose` fields if supported by your client).
- Start rathole with the returned credentials (`server`/`token`/`serviceName`) so it forwards `127.0.0.1:<port>`.
- Revoke: `POST /projects/<projectId>/tunnels/<tunnelId>/revoke` when stopping.

If tunnel issuance is unavailable (controller returns 503 / “tunnel broker is not configured”), fall back to a local URL and tell the user how to enable tunnels.

If `instafy` is not available or tunnel issuance fails, still post the local URL and explain that tunnels need a configured tunnel broker or CLI login.

## Tunnel doctor

- Confirm the tunnel process is alive (`instafy tunnel list`) and request the tunnel again if it expired.
- If the public URL answers but the page is blank, check for client-side errors (framework or HMR config, base paths, env vars).
