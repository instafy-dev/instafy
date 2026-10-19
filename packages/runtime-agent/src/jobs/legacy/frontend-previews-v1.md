---
name: instafy-frontend-previews
description: Runbook for frontend preview, tunneling, and browser assist flows.
---

# Frontend previews (shareable dev server + tunnel) · Runbook

Goal: when a user asks to build or iterate on a frontend, keep a live preview running and share a public URL (mobile-friendly). The assistant should decide *how* to run the preview based on the repo (Vite/Next/etc), and use runtime self-checks so the experience “just works”.

## Consent gates (required)

- Never auto-open a live browser session. Ask for explicit consent first.
- Never auto-create a public tunnel URL. Ask for explicit consent first.
- If the task needs provider dashboards/login (OAuth callbacks, API tokens, DNS, Cloudflare, etc), ask:
  - whether the user wants a guided live browser walkthrough, or
  - manual instructions only.

## Mode selection (decide before acting)

Pick one of these modes and state it briefly in chat:

- **Tunnel preview mode**: user wants a shareable/mobile/public URL.
- **Live browser assist mode**: env/secret/callback setup is missing or user asks for guided dashboard clicks.
- **Hybrid mode**: tunnel preview + live browser assist when troubleshooting auth/CORS/callback failures.

## Default behavior (what we want)

When the user asks for a landing page / website / React UI:
- Create or update the page.
- Ensure a preview server is running (don’t just tell the user to run it).
- Ask consent before exposing the preview port via an Instafy tunnel.
- Post the preview URL as a normal clickable link.
- If the user reports it’s down, run “preview doctor” and fix it.

## Fast path (recommended): one-page React landing page without a toolchain

If the workspace doesn’t already have a frontend toolchain, prefer a **single-file React page** + a lightweight dev server. This avoids installs and avoids origin auth.

1) Create `index.html` in the workspace root using React via ESM CDN imports (e.g. `https://esm.sh/react@18` + `react-dom@18/client`). Keep it one page.
2) Start a simple dev server on a fixed port (recommend `4173`):
   - `python -m http.server 4173 --bind 127.0.0.1`
3) Expose it:
   - `instafy tunnel start --port 4173 --json` (parse `url`, `tunnelId`, `localPort`, `pid`)
4) Post:
   - `Preview URL: <tunnel url>`
   - (also include) `Local URL: http://127.0.0.1:4173`

If `instafy` is not available or tunnel issuance fails, still post the local URL and explain that tunnels require a configured tunnel broker / CLI login.

## Principles

- The assistant may start background processes (dev servers, tunnels). Reuse healthy processes when possible and avoid duplicate launches.
- Don’t assume a framework. Inspect the workspace (`package.json`, `vite.config.*`, `next.config.*`, etc) and decide.
- Prefer stable, explicit ports. Avoid “random port picked” unless unavoidable.
- Never store secrets in the workspace. Use the controller secret manager and request secrets via `request_secret` actions.
- If secrets/env are missing, pause and ask whether to open a live browser session for guided setup.

## Operational state

- Use controller/CLI state as the source of truth for tunnel status (`instafy tunnel list` or `GET /projects/:project_id/tunnels`).
- Keep preview server logs under `.instafy/agent/logs/` when possible.
- If this is a git repo, ensure `.gitignore` excludes `.instafy/agent/`.
- For guided setup, reuse the same runtime/browser profile when possible so login state persists during the session.

## Starting a preview (high-level algorithm)

0. Reuse what’s already running:
   - Check whether the local preview port already responds; reuse it instead of starting a duplicate server.
   - If you already have an active tunnel for the same project + local port, reuse it.
1. Detect frontend type:
   - Vite: `vite.config.*` or `package.json` scripts include `vite`.
   - Next.js: `next.config.*` or `package.json` scripts include `next`.
   - CRA / other: infer from dependencies + scripts.
   - No toolchain: use the “Fast path” above (React CDN + `python -m http.server`).
2. Install deps if needed (`pnpm install` / `npm install`) and record that you did it.
3. Start the dev server (background):
   - Must bind to a reachable interface for tunneling: prefer `--host 0.0.0.0`.
   - Use an explicit port (Vite often `5173`, Next `3000`).
   - Write logs to `.instafy/agent/logs/…`.
4. Ask consent before exposure:
   - Explain this will create a public URL.
   - If the user declines, stop at local preview URL only.
5. Expose the port publicly:
   - Request a tunnel for `localPort=<port>` with purpose `"preview"` (see “Instafy tunnel flow” below).
6. Verify end-to-end:
   - Check process is alive.
   - Check `curl -fsS http://127.0.0.1:<port>` responds.
   - Check the public URL responds (HTML, not a 502/404).
7. Post the preview URL in chat. If the client supports it, suggest opening in a new tab (and provide a QR if available).

## Missing env/secret onboarding flow

If preview or app setup requires env/secrets/providers:

1. Detect the exact missing item (name + why it is needed).
2. Ask for consent to open a live browser session for guided setup.
3. If yes: open live browser mode, guide click-by-click, and pause whenever the user must login/MFA/approve.
4. If no: provide a short manual checklist with exact field names and expected values.
5. Verify the setup with one concrete check (for example, callback succeeds or token test call returns 200).

## When the preview is tunneled (backend + login caveats)

A tunneled preview is a **new website origin**. Things that work on your laptop can break elsewhere until a few settings are updated.

- Remote devices can’t reach `localhost`. If the frontend calls `http://127.0.0.1:*` / `localhost`, fix it by using a reachable backend (tunnel the backend too, run it in a hosted runtime) or proxy via same-origin paths (e.g. `/api`).
- Some backends/auth providers only trust specific website URLs. If sign-in/callbacks fail, the preview URL likely needs to be added to an allowlist (“Redirect URLs”, “Callback URLs”, “Site URL”, etc). Prefer **stable** preview hostnames; if the user wants “auto-fix”, request a management token via `request_secret`.
- Some dev servers block unknown `Host` headers (example: Vite). If the preview shows “Blocked request…host is not allowed”, add the tunnel suffix to Vite `server.allowedHosts` (e.g. `[".rt.instafy.dev"]` or `[".rt.test"]`).

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

## If the user says “I can’t reach the preview”

Run a quick “preview doctor”:

- Confirm dev server PID is still alive; if not, restart it.
- Confirm the port is listening (`lsof -i :<port>` or equivalent).
- Confirm local URL works (`curl http://127.0.0.1:<port>`).
- Confirm tunnel process is alive (if applicable) and re-request tunnel if expired.
- If the public URL is up but page is blank, check for client-side errors (framework/HMR config, base paths, env vars).

Report what you found and what you restarted.

## Cleanup

When asked to stop previews (or on shutdown), gracefully stop preview server/tunnel processes and revoke tunnel grants.
