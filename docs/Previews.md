# Site previews

Status: off unless configured. The local dev stack (`scripts/run-e2e-dev.mjs`) turns it on for itself. Production and
self-hosted deployments stay off until an operator sets the variables below. Hosted launch is blocked on the items in
[Before a hosted launch](#before-a-hosted-launch).

A site preview shows a site running in a space's machine inside Studio, to the space's members only. Nothing becomes
public, and no consent question is asked. A public link is still `instafy tunnel`, which Octo uses only when asked.

## How it works

1. Octo starts a site in the space's machine (any server on any port) and runs
   `instafy preview open --port <port> --title <title> [--path <path>]`. The `instafy-frontend-previews` skill tells it
   when. `instafy preview check --port <port>` takes a local headless look first.
2. The CLI checks that something is listening, asks the controller for a preview, starts a rathole client for it and
   tells the controller it is ready. It never prints a URL. Its JSON output has ids, the port, the path, a status and
   `viewerHostSuffix` (for a dev server's allowed-hosts list).
3. The controller records a **Ready to preview** card in the conversation: an `action_request` message whose
   `details.preview` holds the preview's id and port, and no URL.
4. A member presses **Open** on the card. Studio asks the controller for a viewer session and shows the site as a tab in
   the conversation's side pane, next to Chat, Browser and files, under the same browser bar (title, Reload, Open in
   new tab). The card never opens by itself, and cards in history never open anything.
5. The tab's × closes the pane and revokes its session. If the server stops answering, the card and the pane say
   "Not responding on port N". If the preview is closed or the machine stops, they say "Stopped".

```
runtime   instafy preview open --port N --title T
            → controller POST /projects/:id/previews            (job, machine or writer)
              → broker POST /tunnels {labels: {kind: preview, visibility: private}}
            → rathole client 127.0.0.1:N
            → controller POST …/previews/:pid/ready              → the card
Studio    Open → controller POST …/previews/:pid/view            → viewer URL, kept in memory only
            → <iframe src="https://p-<label>--<tunnel hex>.<PREVIEW_DOMAIN>/">
Traefik   HostRegexp router → forwardAuth → broker GET /preview-auth
            → controller POST /tunnel-broker/hooks/preview-auth  (cached ≤ 30 s)
            → rathole → 127.0.0.1:N in the space's machine
```

## Configuration

Every part fails closed. A missing setting turns previews off; it never makes them public.

| Where | Setting | Unset means |
|---|---|---|
| Broker | `PREVIEW_DOMAIN` (viewer hosts are `p-<label>--<tunnel>.<PREVIEW_DOMAIN>`) | no private routers; private tunnels refused with 400 |
| Broker | `PREVIEW_AUTH_ADDRESS` (where Traefik's forwardAuth reaches the broker) | the same |
| Broker | `PREVIEW_AUTH_HOOK_URL` (the controller's `/tunnel-broker/hooks/preview-auth`) | the same |
| Broker | `ACL_HOOK_TOKEN` = controller `TUNNEL_BROKER_HOOK_SECRET` | every viewer request denied |
| Broker | `PREVIEW_MAX_TTL_SECONDS` (default 43200) | 12 h |
| Ingress sidecar | `PREVIEW_DOMAIN`, `PREVIEW_AUTH_ADDRESS` (same values as the broker) | no private routers |
| Controller | `PREVIEW_DOMAIN`, or `PREVIEW_BASE_URL` such as `http://preview.localhost:8083` | every preview route answers 503 `previews_unavailable`; no tunnel, grant or card is made |
| Controller | the broker's `GET /capabilities` must report private previews for the same domain | the same |
| Controller | `PREVIEW_DENY_PORTS` (comma-separated) | only the built-in denylist |

The broker reports what it serves at `GET /capabilities` (`{privatePreviews, previewDomain}`), and the controller
checks it before it creates anything. The controller refuses to start when `PREVIEW_DOMAIN` is the Studio, API or
`TUNNEL_DOMAIN` host or sits under one of them.

Where a part is older or unconfigured:

- CLI: a 404 or 503 from the controller exits 5 with "Previews are not available on this server". Exit 2 means nothing
  is listening on the port; exit 3 means the port is not allowed.
- Skill: on exit 5, or with no `preview` command, Octo keeps the old flow: it gives the local URL, and makes a public
  tunnel only when asked.
- Studio: no card means no tab. A pane whose preview the controller no longer serves says "Previews are not available
  here".

### Local stack

`scripts/run-e2e-dev.mjs` (`pnpm stack:up`) sets these for the tunnel broker it starts itself, and for the controller
beside it:

| Setting | Value |
|---|---|
| `PREVIEW_DOMAIN` | `preview.localhost` (browsers resolve `*.localhost` to loopback) |
| `PREVIEW_BASE_URL` | `http://preview.localhost:8083` (the local Traefik's plain-HTTP port, `PUBLIC_INGRESS_PORT`) |
| `PREVIEW_AUTH_ADDRESS` | `http://broker:8080` (the broker on its compose network) |
| `PREVIEW_AUTH_HOOK_URL` | `http://host.docker.internal:<CONTROLLER_PORT>/tunnel-broker/hooks/preview-auth` |
| `ACL_HOOK_URL` | `http://host.docker.internal:<CONTROLLER_PORT>/tunnel-broker/hooks/acl` |
| `ACL_HOOK_TOKEN`, `TUNNEL_BROKER_HOOK_SECRET` | one random secret per checkout, kept owner-only in `tmp/tunnel-broker-hook-secret` |

- Values already in the environment win.
- `PREVIEW_DOMAIN=` (empty) turns previews off for the stack.
- With `TUNNEL_BROKER_BASE_URL` set, or `RUNTIME_SKIP_TUNNEL_BROKER=1`, the script starts no broker and sets nothing.
- The hook secret is random because the dev controller listens on every interface; a value written in the source
  would open its hooks to the local network.
- `ACL_HOOK_URL` is set as well because the controller stops burning tunnel credits itself once the hook secret is
  set; the broker's ACL hook burns them instead, as in a hosted deployment.

The browser test `packages/frontend/tests/playwright/projects/project-preview-ready.spec.ts` runs on this stack. It
skips itself when the broker does not report private previews.

## Security model

- **Create.** The live job of the space's machine, a machine token, or a writer. The job token is bound on the server to
  its job, run, machine and lease; copies of those fields from the client are ignored. Ports used by the machine's own
  services are denied, plus `PREVIEW_DENY_PORTS`. At most 16 open previews and 30 creates a minute per machine.
- **View.** Space members with read access who pass the private-runtime check. This is checked when a session is
  minted, again through the broker hook at least every 30 s, and on every pane heartbeat (about once a minute).
- **Capability.** Each Open mints a 130-bit label, bound to one person and one preview and stored only as a hash. At
  most 5 live sessions per person and preview, and 20 mints a minute. A session lasts 30 min idle and 12 h at most. A
  pane's session is kept alive only by its heartbeat, never by traffic through the site; the broker hook never extends
  one. Closing the pane, closing the preview, stopping the machine or removing the member revokes it. New requests stop
  within 30 s.
- **Paths.** A private tunnel has no router on its bare `<uuid>.<TUNNEL_DOMAIN>` host (404). An unknown, expired or
  revoked label gets 401. Every private router has the auth middleware, and a render test fails if one does not.
  Service-worker scripts get 403.
- **Frame.** The iframe is sandboxed, sends no referrer and is allowed only fullscreen and clipboard-write. Studio
  accepts one message from it, `{type: "instafy-preview", status}`, and only from that frame's own window and origin.
  The viewer URL lives in memory only; tabs store the preview id, never a URL.
- **Reach.** The rathole client dials only `127.0.0.1:<port>` in the space's own machine. Viewer URLs come only from
  that space's grant rows, never from client input.
- **Billing.** A private preview burns no tunnel credits: it is part of the machine the space already pays for.
- **Retention.** Session rows are pruned a little after they expire, and revoked ones an hour after revocation.

### Known limits

- The site's own cookies are third-party in the iframe, so Safari and WKWebView block them. Such sites work through
  "Open in new tab".
- A dev server that checks the Host header (for example Vite's `server.allowedHosts`) refuses the viewer host until
  `viewerHostSuffix` is added to its allowed hosts. The skill tells Octo to do that on a "Blocked request" error.
- While a session is live, its label works for whoever holds it. It is a bearer. Browsers also send it in the `Origin`
  header of the site's own cross-origin requests.

## Before a hosted launch

None of these block a local or self-hosted merge, because everything is off by default.

- **Preview domain (Q1/O1).** Hosted previews need a separate registrable domain, listed on the Public Suffix List with
  `*.<domain>`, plus wildcard DNS and TLS. Until it is listed, previews on that domain can set cookies for each other.
  The controller's startup check keeps the domain off the Studio, API and tunnel hosts.
- **Label binding (Q4/O1).** Bind each label to the first browser that opens it with a partitioned `__Host-` cookie, so
  a leaked label stops working elsewhere. That needs Traefik 3.1 or later (`addAuthCookiesToResponse`); the stack runs
  3.0. Keep the short idle window as the fallback where partitioned cookies are not supported.
- **Long-lived connections (O4).** A site's own WebSockets and SSE streams opened before a revocation stay open until
  they end. Put preview routers on their own Traefik entrypoint with bounded idle and write timeouts, or give the broker
  a way to cut upgraded connections.
- **Defaults to confirm.** Q2: private previews burn no tunnel credits. Q3: every space member who can read the space,
  read-only viewers included, can open a preview.
