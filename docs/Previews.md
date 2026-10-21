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
| Broker | `ACL_HOOK_TOKEN` = controller `TUNNEL_BROKER_HOOK_SECRET` (the bearer for every controller hook) | private previews off (the broker logs "PREVIEW_AUTH_HOOK_URL is set without ACL_HOOK_TOKEN") |
| Broker | `PREVIEW_MAX_TTL_SECONDS` (default 43200) | 12 h |
| Ingress sidecar | `PREVIEW_DOMAIN`, `PREVIEW_AUTH_ADDRESS` (same values as the broker) | no private routers |
| Controller | `PREVIEW_DOMAIN`, or `PREVIEW_BASE_URL` such as `http://preview.localhost:8083` | every preview route answers 503 `previews_unavailable`; no tunnel, grant or card is made |
| Controller | the broker's `GET /capabilities` must report private previews for the same domain | the same |
| Controller | `PREVIEW_DENY_PORTS` (comma-separated) | only the built-in denylist |
| CLI (in the space's machine) | `INSTAFY_PREVIEW_DENY_PORTS` (comma-separated), checked before the controller is asked | only the CLI's built-in list of the machine's own service ports |

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

`scripts/run-e2e-dev.mjs` (`pnpm stack:up`) configures the tunnel broker it starts itself, and the controller beside
it. The rules are in `scripts/lib/localTunnelBroker.mjs`. There are two parts.

**Controller hooks**, as in `packages/tunnel-broker/docs/integration.md`. The broker asks the controller before it
creates any tunnel, public or private, and reports tunnel events to it:

| Setting | Value |
|---|---|
| `ACL_HOOK_URL` | `http://host.docker.internal:<CONTROLLER_PORT>/tunnel-broker/hooks/acl` |
| `EVENT_HOOK_URL` | `http://host.docker.internal:<CONTROLLER_PORT>/tunnel-broker/hooks/events` |
| `ACL_HOOK_TOKEN`, `EVENT_HOOK_TOKEN`, controller `TUNNEL_BROKER_HOOK_SECRET` | one random secret per checkout, kept owner-only in `tmp/tunnel-broker-hook-secret` |

**Private previews**, which need the hooks:

| Setting | Value |
|---|---|
| `PREVIEW_DOMAIN` | `preview.localhost` (browsers resolve `*.localhost` to loopback) |
| `PREVIEW_BASE_URL` (controller) | `http://preview.localhost:8083` (where `docker-compose.yml` publishes the local Traefik's plain-HTTP entrypoint). Derived only for a loopback domain (`localhost`, `*.localhost`, a loopback IP) |
| `PREVIEW_AUTH_ADDRESS` | `http://broker:8080` (the broker on its compose network) |
| `PREVIEW_AUTH_HOOK_URL` | `http://host.docker.internal:<CONTROLLER_PORT>/tunnel-broker/hooks/preview-auth` |

- Values already in the environment win. With a `PREVIEW_DOMAIN` that is not loopback, `PREVIEW_BASE_URL` is left
  unset, so the controller uses `https://<PREVIEW_DOMAIN>` and you provide that HTTPS ingress. The controller refuses
  plain `http` on any other host, so the script refuses a `PREVIEW_BASE_URL` like that before it starts anything.
- The hook secret must agree: if
  `TUNNEL_BROKER_HOOK_SECRET`, `ACL_HOOK_TOKEN` and `EVENT_HOOK_TOKEN` are set to different values, the script refuses
  to start. Set only `TUNNEL_BROKER_HOOK_SECRET`.
- `PREVIEW_DOMAIN=` (empty) turns previews off. The hooks stay on.
- With `TUNNEL_BROKER_BASE_URL` set, or `RUNTIME_SKIP_TUNNEL_BROKER=1`, the script starts no broker and sets nothing.
- With `RUNTIME_SKIP_CONTROLLER=1` the script cannot configure the controller. Unless `TUNNEL_BROKER_HOOK_SECRET` is
  set, the broker gets no hooks and no previews, and the script says so. A controller you run yourself needs the same
  `TUNNEL_BROKER_HOOK_SECRET`, plus `PREVIEW_DOMAIN=preview.localhost` and
  `PREVIEW_BASE_URL=http://preview.localhost:8083` for previews; without the base URL its viewer URLs are `https` on
  port 443 and do not load.
- A controller that is already running is reused only if it accepts the secret (an ACL hook call with an empty
  project answers 400 and writes nothing; the controller checks the bearer first). If it does not, and this checkout
  started it (its recorded pid is on the port), it is restarted with the secret. A controller this checkout did not
  start, such as another worktree's, is never stopped: the script exits and says how to proceed.
- The settings go only to the broker's compose and the controller. Other services the script starts never see the
  secret.
- The hook secret is random because the dev controller listens on every interface; a value written in the source
  would open its hooks to the local network.
- The broker reaches the controller on `host.docker.internal`, which `docker-compose.yml` maps to the host for Linux
  Docker.

The browser test `packages/frontend/tests/playwright/projects/project-preview-ready.spec.ts` runs on this stack. It
skips itself when the broker does not report private previews, so it skips in CI. Set
`INSTAFY_E2E_REQUIRE_PREVIEWS=1` to make it fail there instead, so a local run cannot pass by skipping.

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
- **Frame.** The iframe is sandboxed, sends no referrer and is allowed only fullscreen and clipboard-write, so it can
  never use the browser's geolocation itself. Studio reads messages from it only from that frame's own window and
  origin: `{type: "instafy-preview", status}`, and the site envelope described in [Location](#location). They are
  data, never commands. Studio adds `?instafy_host=studio` to the frame's address so a site knows where it runs.
  The viewer URL lives in memory only; tabs store the preview id, never a URL.
- **Reach.** The rathole client dials only `127.0.0.1:<port>` in the space's own machine. Viewer URLs come only from
  that space's grant rows, never from client input.
- **Billing.** Tunnel credits for broker tunnels are charged by the controller's ACL hook, `TUNNEL_CREDIT_BURN_AMOUNT`
  once per create and idempotency key (0 by default, so the local stack charges nothing). A private preview is
  charged nothing: the hook sees its private label and burns 0.
- **Retention.** Session rows are pruned a little after they expire, and revoked ones an hour after revocation.

### Known limits

- The site's own cookies are third-party in the iframe, so Safari and WKWebView block them. Such sites work through
  "Open in new tab".
- A dev server that checks the Host header (for example Vite's `server.allowedHosts`) refuses the viewer host until
  `viewerHostSuffix` is added to its allowed hosts. The skill tells Octo to do that on a "Blocked request" error.
- While a session is live, its label works for whoever holds it. It is a bearer. Browsers also send it in the `Origin`
  header of the site's own cross-origin requests.

## Location

A site in a preview can use the person's location, with one browser prompt for Instafy and a visible 📍 for every
site that got it. Studio is the only part that calls the browser's geolocation. Sites ask Studio for it.

### What the person sees

- **One prompt.** The first time any site asks, Studio calls `navigator.geolocation`, so the browser asks once, for
  Instafy. If Instafy already has location, there is no prompt. There are no per-site prompts.
- **📍 in the bar.** A site that received the location this session shows 📍 in the preview's bar and on its tab
  in both tab strips. It pulses while the site follows the person (a watch). Pressing it offers **Stop sharing
  location** (or **Share location again**) and **Sites with your location…**.
- **A one-time note.** The first time a site gets the location on this device, a short note says "📍 <title> can see
  your location · Stop". It goes away by itself.
- **The list.** Settings → Profile → Location lists every site that received it on this device, with its space and
  when it last got a position, and Stop or Share again. The list belongs to the signed-in account. Another account on
  the same device never sees it, and it is not sent anywhere.
- **Blocked.** If the browser (or the desktop app) refuses location to Instafy itself, the pane says where to allow
  it. A site cannot tell the difference between that and "no position".

### The rules

- **Only the site on screen.** Studio answers only the mounted, visible preview frame whose window and viewer origin
  match the request, and posts answers to that origin only, never `"*"`. A hidden pane gets `hidden`. A watch pauses
  while the pane is hidden and ends when the frame reloads, the tab closes or the person leaves the conversation.
- **Stop sticks.** After Stop, that site's requests get `stopped` until the person presses Share location again in
  Studio. Nothing a site sends can undo a stop. A stop is kept per space, preview title, port and path on this
  device, so a reopened or renamed preview stays stopped.
- **Limits per frame.** At most 5 requests in 10 seconds and 3 watches at once; more get `unavailable`. A one-off
  answer may reuse a position up to 30 seconds old.
- **What Studio keeps.** Studio does not store positions. It keeps, on this device only, which sites received the
  location and when. It also remembers, in memory, that a frame has received positions until that frame is loaded
  fresh, because the page may still hold them in its URL or state. Anything that shares what a pane shows with other
  people must check this first and keep those positions out.
- **Open in new tab** is the site's own page. There the browser asks for the site's own origin, as on any website,
  and Studio is not involved.

### Desktop app

The Studio window's Electron session has a permission handler (`packages/desktop-app/src/studioPermissions.ts`).
Without one Electron grants every request, so a preview frame used to get location with no prompt at all.

- Geolocation is allowed only for Studio's own top frame on the Studio origin, after one native question ("Allow
  Instafy to use your location?"). The answer, either way, is remembered in `desktop-config.json` for that origin.
  A preview frame, any other subframe and any other origin are always denied.
- Frames inside a Studio window get only fullscreen, clipboard writes and pointer lock. Everything else
  (notifications that would look like Instafy's, storage access, camera, sensors) is denied to them.
- **Location Permission…** in the app menu and Settings → Profile → Location show the answer and can reset it.
  Nothing can grant it except the native question.
- The mac build carries the location usage strings and the location entitlement that the hardened runtime needs.

### Messages

All messages use one envelope, version 1. A site names itself in `source` with a short lowercase name of its own
choosing (`[a-z][a-z0-9-]{0,39}`). The name is not trusted for anything. `instafy-host` is Studio's own.

Studio → site, on every frame load and when Studio's theme changes:

```
{ "source": "instafy-host", "v": 1, "type": "layout", "insets": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
  "chrome": "host", "title": "shown", "caps": { "geolocation": true, "location": "host" }, "theme": "light" }
```

`caps.location: "host"` means "ask Studio". A site that speaks before it got the layout is sent it again.

Site → Studio:

```
{ "source": "my-site", "v": 1, "type": "location-request", "payload": { "id": "r1", "watch": false, "highAccuracy": false } }
{ "source": "my-site", "v": 1, "type": "location-stop", "payload": { "id": "r1" } }
```

`id` is the site's own short id (`[A-Za-z0-9:._-]{1,64}`). It only comes back to that site.

Studio → site:

```
{ "source": "instafy-host", "v": 1, "type": "location", "payload": { "id": "r1",
  "coords": { "latitude": 59.33, "longitude": 18.06, "accuracy": 20 }, "timestamp": 1700000000000 } }
{ "source": "instafy-host", "v": 1, "type": "location-error", "payload": { "id": "r1", "code": "denied" } }
{ "source": "instafy-host", "v": 1, "type": "location-stop", "payload": { "id": "r1" } }
```

`coords` may also carry `altitude`, `heading` and `speed`. A watch gets repeated `location` messages with the same
id. `code` is `denied`, `unavailable`, `timeout`, `stopped` or `hidden`, and ends that request. A watch that already
got a position outlives a passing `unavailable` or `timeout` from the browser.

A site that wants to work both inside Studio and on its own checks for `?instafy_host=studio` (or the layout
message) and uses this path there, and `navigator.geolocation` elsewhere. The `instafy-frontend-previews` skill tells
Octo this.

### Limits of this version

- A site is keyed by its space, preview title, port and path. Two different sites with the same title in the same
  space share a stop.
- The list and stops are per device. Stopping a site on a laptop does not stop it on a phone.
- The desktop app's handling was tested in a real Electron window (`smoke:studio:permissions`), not in a signed,
  notarized mac build.

## Before a hosted launch

None of these block a local or self-hosted merge, because everything is off by default.

- **Preview domain.** Hosted previews need a separate registrable domain, listed on the Public Suffix List with
  `*.<domain>`, plus wildcard DNS and TLS. Until it is listed, previews on that domain can set cookies for each other.
  The controller's startup check keeps the domain off the Studio, API and tunnel hosts.
- **Label binding.** Bind each label to the first browser that opens it with a partitioned `__Host-` cookie, so a
  leaked label stops working elsewhere. That needs Traefik 3.1 or later (`addAuthCookiesToResponse`); the stack runs
  3.0. Keep the short idle window as the fallback where partitioned cookies are not supported.
- **Long-lived connections.** A site's own WebSockets and SSE streams opened before a revocation stay open until they
  end. Put preview routers on their own Traefik entrypoint with bounded idle and write timeouts, or give the broker a
  way to cut upgraded connections.
- **Defaults to confirm.** Whether every space member who can read the space, read-only viewers included, can open a
  preview.
