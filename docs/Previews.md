# Site previews

Status: off unless configured. The local dev stack (`scripts/run-e2e-dev.mjs`) turns it on for itself. Production and
self-hosted deployments stay off until an operator sets the variables below. Hosted launch is blocked on the items in
[Before a hosted launch](#before-a-hosted-launch).

A site preview shows a site running in a space's machine inside Studio, to the space's members only. Nothing becomes
public, and no consent question is asked. A public link is still `instafy tunnel`, which Octo uses only when asked.
Instafy's browser cannot show a space's own sites: its safety policy blocks the space's own addresses (localhost,
127.0.0.1, private addresses) and non-web ports, so a site running in the space is seen through a preview.

## How it works

1. Octo starts a site in the space's machine and shows it with one command,
   `instafy preview open --title <title> --serve-cmd "<command with {port}>" --start [--path <path>]`: the CLI picks the
   site's port, starts it and posts its card (item 8). The `instafy-frontend-previews` skill tells it
   when. `instafy preview check --port <port>` takes a local headless look first. A turn on a restored provider thread
   and a direct workspace-change turn (such as "make a page and show me a preview") load no workspace memory snapshot,
   so their prompt names the workflow skills that match the request strongly (at most three,
   with the file to read), and the browser rule on every turn that can ask for Instafy's browser says that it opens public addresses only.
2. The CLI checks that something is listening, asks the controller for a preview, starts a rathole client for it and
   tells the controller it is ready. It never prints a URL. Its JSON output has ids, the port, the path, a status and
   `viewerHostSuffix` (for a dev server's allowed-hosts list).
3. The controller records a preview card in the conversation: an `action_request` message whose `details.preview`
   holds the preview's id and port, and no URL. Each run that opens a site posts its own card, so a conversation can
   hold several for one site. Studio draws only the latest one in full; an earlier one shrinks to a line ("Hello ·
   opened again further down"), so a conversation shows one card per site, at its latest place. The card looks like a
   link preview: a picture of the site, its title with a lock (private) and, when a press does something, a chevron,
   and one line of facts (see
   [The card's picture and facts](#the-cards-picture-and-facts)).
4. A member presses the card. Studio asks the controller for a viewer session and shows the site as a tab in the
   conversation's side pane, next to Chat, Browser and files, under the same browser bar (title, Reload, Open in new
   tab). The pane says "Opening <title>…" from the press until the site's page is in: loaded, and drawn for a page
   that says it draws itself after it loads (see `ready` under [Messages](#messages)). The card never opens by
   itself, and cards in history never open anything.
5. The tab's × closes the pane and revokes its session. The card says nothing while the site is live. If the preview
   is closed, the machine stops, or the server stops answering (Octo stopped it, say), the card reads "Stopped", with
   how to get it back (see [Waking a stopped site](#waking-a-stopped-site)), and the pane says "This site is stopped."
   in place of the site, with **Start again** where a press can start it. Neither names a port. When a turn in the
   space ends, the latest card of each preview asks for a new probe at once (the pane does, while it is on screen),
   since a server that stopped sends no event. While the pane is on screen it checks the site every 15 s and the cards
   of that preview read its answers, so they ask nothing themselves. A pane whose site stopped answering drops its frame
   and loads the site again once a check says it answers; a pane whose session the controller refuses because the site
   stopped asks for a new one only once a later check says the site answers again.
6. While the pane shows the site, its heartbeat (about once a minute) counts as activity in the space, so the idle
   sweep does not stop a machine someone is looking at. This counts only for members who may change the space, the
   same rule as Studio's own activity ping and as starting a stopped machine: the space pays for the machine, so a
   view-only member's viewing keeps nothing up. Each person's viewing does this for at most 4 hours a day per space.
7. A site `instafy preview open` knew how to start can be started again from the card or the pane after the machine
   slept (see [Waking a stopped site](#waking-a-stopped-site)).
8. `instafy preview open --serve-cmd "<command>" --start` starts the site: the command as argv (never a shell) from
   its directory in the workspace, in its own session so it outlives the process that started it, without terminal
   input, with its output appended to `.instafy/agent/logs/preview-<port>.log`, and with the environment stripped of
   credentials by the same rule as `instafy bind serve --detach` (no `CONTROLLER_*` value except
   `CONTROLLER_BASE_URL`, no `SUPABASE_*` value, no credential-like name). It waits up to 60 s for the port, the same
   as a wake, and exits 2 with the log's path when the command exits first or the port stays silent (then the command
   is stopped). `--json` adds `startedPid` (null when this same site already ran on its port and nothing was started)
   and `logFile`. The log is Instafy's, not the person's work: a turn's file list never counts it, as it counts nothing
   else under `.instafy/`. `instafy preview close` stops the site it started (and one a wake started), but only while
   its recorded pid still runs the command line recorded when the site answered.
9. **One site per port.** Without `--port`, `--start` picks the port and writes it where the command says `{port}`:
   this same site's port when it still has it (the same command from the same folder of the same space; another
   space's site on the same machine never is), else the first free port from one chosen by the command and its folder,
   between 20000 and 29999, that no other site here holds or has an open preview on. With `--port`, a port where another server answers is refused (exit 3) and names the site that holds
   it. The controller refuses an open whose title or folder differs from the open preview on that port with
   `409 port_in_use` ("Port 4173 already shows 'Lisbon in 3 days'."), unless the open says it replaces that site
   (`replace`, `--replace`): a preview is keyed by machine and port, so such an open would take the other site's
   card over.

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

A member can **Present** a site whose page says it can share its view, and the others **Follow** it live; see
[Follow-Mode.md](Follow-Mode.md).

## The card's picture and facts

- **Facts line.** `instafy preview open --summary "<text>"` (1 to 80 characters, one line, no control or direction
  characters; the controller checks it like the title) is kept with the preview. Without one, the card shows the
  page's own `<meta name="description">`, read when its picture is taken. Studio shows either as one line of plain
  text, cut at 80 characters, never Markdown or a link.
- **Taking the picture.** Once `/ready` reports the site live, `instafy preview open` loads `http://127.0.0.1:<port><path>`
  in the runtime image's own Playwright and Chromium (the engine `instafy preview check` uses) at 1280×800 in dark mode
  and keeps a 640×400 JPEG (quality 70, or 50 when that is over 256 KiB, else none), within 15 s in all. A preview
  keeps one picture, which Studio shows in its light and dark themes alike: a page that follows the person's light or
  dark mode is pictured dark, since a light picture would be a bright block in a dark Studio, and a page with only a
  light look is pictured light, as it shows. A page that draws itself
  after it loads marks it: `data-instafy-ready="false"` on its `<html>` element, then `"true"` once drawn (the map
  engine sets it once its tiles and description are in). The picture then waits for `"true"` instead of a quiet
  network, up to 30 s in all, and a page still drawing by then gets no picture, never a half-drawn one. The JSON gains `thumbnail`
  (`uploaded`, `skipped` or `failed`) and `thumbnailReason`; the exit code never changes. `--no-thumbnail` takes none,
  and no later check takes one for that preview's card either; `--thumbnail <file>` sends a picture a skill made itself
  (JPEG, PNG or WebP, at most 512 KiB and 2000×2000). `instafy preview check` takes a new one from the desktop page it
  already loaded (in dark mode too), when this machine has a preview open on that port and path, so a check after a
  change also refreshes the card.
- **After a turn.** `open` records, with each preview it opens on the machine, the folder the site's server runs from
  in the workspace (`siteDir`), and `open` and `check` record when they last pictured the site for the card
  (`pictureAt`), also when no picture came of it (a blank page, one that never loaded). While a turn's changes are
  saved, each preview whose folder holds a file the turn changed after that is checked once more, at the size its
  picture comes from (`instafy preview check --desktop`), from the workspace: at most three previews and 30 s in all,
  a check starting only with 15 s of that left, none once the turn is stopped or its changes could not be saved. The
  reply does not wait for it: the check goes on after the reply is posted, and the card's picture changes in place
  once it is sent (`preview.thumbnail_updated`). The check keeps the picture in a file (`--picture-to <file>`, for
  the runtime only, with the preview's id, the page's description and when the page began loading in
  `<file>.json`), and the runtime sends it with its own credential, which still works once the turn has ended. The
  check itself is given no credential: it goes on while the next turn may run, another member's with other granted
  secrets, and any process in a runtime can read another's environment, so it gets only what a helper that outlives
  a turn may have and the settings it reads (`PREVIEW_CHECK_ENV_KEYS`: where Node finds Playwright and Playwright its
  browsers, the skill packs whose link-only lists the capture enforces, and the reserved preview ports), never the
  turn's granted secrets. A picture older than one taken since (the next turn's own check, which records when it took
  its picture before it sends it) is not sent, nor sent again after the runtime's credential is renewed. So a turn that stopped
  before its own check still leaves the card showing the site as it left it, and a turn whose own check came after
  its last change adds nothing. The check's screenshots and picture go to a folder removed after it, and a check
  that fails, runs out of time or is stopped ends with every helper it started and leaves the old picture. A preview
  with no recorded folder or id, or opened with `--no-thumbnail`, is left alone.
- **What the capture may load.** Only the site's own loopback origin directly. Every other request goes through the
  image's `browser-egress-proxy`, an instance of its own on a free loopback port: public addresses on ports 80 and
  443 only, connected to the address it checked. Another loopback port, `localhost` names, private, link-local,
  CGNAT, metadata and reserved addresses, and every site on the link-only list (their translator, cache and archive
  copies too) are blocked, WebSockets included: a `no-agents` site is never fetched, and a `no-reuse` site, which
  `instafy web read` may read, is not loaded into a picture Instafy keeps and shows. Without the proxy binary nothing off the site's
  origin loads. A redirect is checked too: Playwright follows one without asking the request rules, so every
  connection off the site first passes Instafy's own gate in front of the egress proxy (local and link-local
  addresses included, which Chromium would otherwise send around a proxy), which refuses by the whole address of a
  plain-HTTP request and by the host of a TLS one or a WebSocket. A redirect to an https copy that a wrapper writes into
  its path or query, which the gate cannot read, means no picture is kept. The page loads as an anonymous first visit: a fresh context with no person's session, cookies,
  location or browser profile, service workers blocked, downloads refused, new windows closed, no permissions.
  `instafy preview check` follows the same rules and lists blocked requests as `blocked`, not as page errors.
- **Without a browser** (self-hosted without Chromium), the CLI reads the page's HTML from 127.0.0.1 (at most 512 KiB)
  and uses its `og:image` only when it is on the same `127.0.0.1:<port>` origin, at most 512 KiB, and a JPEG, PNG or
  WebP by its bytes. An `og:image` on another host is never fetched.
- **Upload.** `PUT /projects/:id/previews/:pid/thumbnail` with `{image: <base64>, contentType, source:
  "capture" | "og_image" | "file", description?}` (at most 768 KiB). Only a job or machine token bound to the
  preview's runtime may upload, as for `/ready`; people cannot. The controller decides the type from the bytes (JPEG,
  PNG or WebP; never SVG or GIF), reads the size from the header (64 to 2000 pixels each way), caps it at 512 KiB, and
  removes metadata (EXIF, XMP, ICC, comments, text chunks, anything after the image) without decoding pixels. At most
  6 uploads per preview a minute and 60 per runtime an hour.
- **Storage.** One picture per preview in `runtime_preview_thumbnails` (RLS on, no client policy). It goes with every
  new open of the preview (a preview is keyed by machine and port, so a site that replaces another on the port has the
  same id; the CLI takes a new picture once that site is live), when the preview is replaced (`supersededBy`) or closed for good,
  and with its space. A preview stopped by a sleeping machine keeps its picture. One closed on purpose whose card can
  start it again keeps its picture and page description, unshown while it is closed, so the card shows both again
  once a press brings the site back; once a newer tunnel takes its port, no press can, and the picture goes then. A
  card whose record now names another site shows neither that site's picture nor its facts.
- **Reading it.** `GET /projects/:id/previews/:pid/thumbnail?v=<version>` applies the rule `GET` of the preview uses:
  members who may open the preview (a private runtime's preview is a 404 to others). The answer is
  `cache-control: private, no-store`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none';
  sandbox`. `GET` of a preview gains `summary`, `pageDescription` and `thumbnail: {version, width, height, capturedAt}`
  or null. Studio fetches the picture with the person's own session into an object URL once the card is near the
  screen, within the chat's in-memory image budget (40 images, 64 MiB). Never a Storage object, a signed URL, an
  iframe, a notification or part of the card message, which stays ids-only.
- **Refresh.** Each upload publishes `preview.thumbnail_updated {previewId, version, runtimeId}` with the preview's
  conversation, built as `preview.wake` is, so the same `/events` filters apply. It carries no picture and no
  description; the latest card for the preview asks `GET` again and every card reads the answer.

## Waking a stopped site

`instafy preview open` records how the site was started: the argv and working directory of the process listening on
the port (read from `/proc` on a Linux space), or `--serve-cmd "<command>"`. A command line that looks like it carries a
secret is never recorded: the CLI leaves it out (from `/proc`) or refuses it (`--serve-cmd`), and the controller refuses
it too (`400`), whichever client sends it. The controller keeps it in the preview's
controller-owned metadata, where no tunnel route can change it and no listing shows it. The preview record says
`restartable: true` when such a command is recorded and no newer tunnel replaced the preview's (below). Closing a
preview on purpose (`instafy preview close`, the close route) keeps the command: the card reads "Stopped · opening
restarts it", and pressing it starts the site again for someone who may change the space.

When a member presses the card of a stopped, restartable site, including one that stopped answering (or **Start
again** in its pane), Studio calls `POST /projects/:id/previews/:pid/wake`, then opens the site once it answers:

- If the machine is up and the site answers, the answer is `200 {state: "live"}` and nothing else happens.
- Otherwise the controller records one wake (one open wake per preview; asking again joins it) and answers
  `202 {state: "waking"}`. If the machine is stopped, it starts it the way a chat message would. Only members who may
  change the space may start a stopped machine (`403 start_needs_builder`); anyone who may view the preview may restart
  its site while the machine is up, or join a wake under way. Starting a preview someone closed on purpose also takes
  someone who may change the space, machine up or not. A person's `GET` of the preview says `canStart: false` when
  their wake could not go ahead (they may not change the space, and the machine is not up or the preview was closed),
  so the card reads "Stopped · only people who can edit this space can start it" and cannot be pressed. A stopped
  preview that cannot be woken (no recorded command, or replaced by a newer one) reads "Stopped · ask Octo to start it
  again" and cannot be pressed either, since Octo can start it again in a turn. Until the controller has answered
  whether a press can start it, a stopped card reads just "Stopped". A card that cannot be pressed draws no chevron. A self-hosted machine that is offline fails with `409 runtime_offline`
  ("The computer this space runs on is offline.").
- The runtime agent polls `POST /agent/preview-restarts/claim` with its agent token. A claim reconnects the same
  preview tunnel on the machine's current lease and hands the agent the recorded command and the tunnel client
  credentials. The agent starts the command as argv in its directory under the workspace (symlinks resolved, never
  outside), with the same stripped environment as other helper processes, waits up to 60 s for the port, starts the
  tunnel client and records it in the CLI's state file under the CLI's lock, then reports
  `POST /agent/preview-restarts/:wake_id/result`. The controller probes the site through the tunnel before it calls the
  wake done; when the broker cannot be asked, the wake ends on the agent's word but the `preview.wake` event says
  `unverified`, not `live`, and Studio's own `GET` decides what it shows.
- `GET` on the preview shows the wake as `wake: {state: "idle" | "waking" | "failed", startedAt?, error?}`. Studio
  follows it until the site answers, then opens it. A failed wake records a fixed line ("the start command exited
  (exit status: 1) before the site answered on port 4173", "the space could not start; try again in a few minutes"),
  never a local path, user name or command line. Studio does not show that line, since it names ports and exit
  statuses: the card reads "Couldn't start · Ask Octo to start it again" (a press tries again) and the pane says
  "Couldn't start it. Ask Octo to start it again." The details stay in the agent's and the controller's logs.

No agent job, run, chat message or model call is involved. Limits: 6 new wakes per preview per 10 minutes and 30 per
person per space per hour (`429`); a wake not claimed within 10 minutes fails, and a claim without a result is retried
after 180 s (well past the agent's longest restart: 60 s for the port, 90 s for the CLI's lock, which `--start` holds
while its own site starts), at most 3 times. An agent that sees a re-claim of a preview it is still restarting reports
that restart's outcome for it. Each runtime
agent asks for claims every 3 s: one indexed update of `runtime_preview_wakes` plus the agent token's runtime check
(`ensure_runtime_can_heartbeat`), whether or not it has previews. A preview whose tunnel a newer one replaced never
wakes (`409 not_restartable`), even one someone had closed before the newer one opened on its port: its wake would get
the newer preview's tunnel and write over that preview's record. Without
previews configured, the wake route answers 503 like the others and the claim route 404, which the agent reads as "not
offered here" and then asks only every 5 minutes. `runtime_preview_wakes` keeps who asked and how each wake ended.

### When the broker replaces a preview's tunnel

A preview's tunnel is keyed by its machine and port, and the broker normally hands that key the same tunnel id (the
preview id) every time. After a `TUNNEL_DOMAIN` change it instead retires a tunnel minted under the old domain and
mints a new one, so the next `instafy preview open` (or wake) of that port gets a new preview id. The controller then
closes every earlier preview of the same key as the close route does: it stops, gets `closedAt` and `supersededBy`
(the new id), its viewer sessions and any presentation end, and `tunnel.grant_revoked` tells Studio, so its card
shows it stopped rather than probing a tunnel that is gone. Only previews recorded before the new one close, so an
open or wake that got an older tunnel of the key but finishes late never closes the newer preview. Cards name a
preview by id, so they stay with the old preview; the new one posts its own card when it is ready, even when a wake
copied an old preview's card ids onto it after another open had already closed that preview. The broker's own `tunnel.revoked` event for a tunnel the
controller did not revoke stops that grant too (not closed: it may be opened again). The event names the tunnel's
expiry, and an event whose expiry is earlier than the grant's (a late one about an issue of the tunnel the broker has
since refreshed), a duplicate, or one for an unknown tunnel changes nothing.

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
checks it before it creates anything. The controller refuses to start when `PREVIEW_DOMAIN` shares a cookie scope with
the Studio or API host: equal to it, under or above it, or under the same registrable domain. `PREVIEW_DOMAIN` may be
`TUNNEL_DOMAIN` itself (see [One user-content domain](#one-user-content-domain)); under, above or next to it is refused.

Where a part is older or unconfigured:

- CLI: a 404 or 503 from the controller exits 5 with "Previews are not available on this server". Exit 2 means nothing
  is listening on the port; exit 3 means the port is not allowed.
- Skill: on exit 5, or with no `preview` command, Octo keeps the old flow: it gives the local URL, and makes a public
  tunnel only when asked.
- Studio: no card means no tab. A pane whose preview the controller no longer serves says "Previews are not available
  here".

### One user-content domain

Public tunnels and private previews can share one domain: set `PREVIEW_DOMAIN` (broker, ingress sidecar and controller)
to the same value as `TUNNEL_DOMAIN`. Both kinds of host are then a single label under it, and neither reaches the
other's router:

| Host | Routed to |
|---|---|
| `<tunnel id, 32 hex>.<domain>` | a public tunnel's `Host` router. A private tunnel has no router on this host. |
| `p-<26 base32>--<tunnel hex>.<domain>` | that private tunnel's anchored `HostRegexp` router, behind forwardAuth. A public tunnel has none, and a public binding whose stored hostname starts with `p-` under the domain gets no router. |

The broker's tests compile the rendered Traefik rules and check that no host of one shape matches a router of the other.

- **TLS.** Every router asks for the same certificate, `<domain>` plus `*.<domain>`: one wildcard.
- **DNS.** The broker writes `A/AAAA` records for each `<tunnel id>.<domain>`. Capability hosts are minted by the
  controller and have no records of their own, so add one wildcard `*.<domain>` record that reaches the ingress serving
  private tunnels. Names with their own records keep them; the wildcard only answers the rest.
- **Cookies.** Use one registrable domain dedicated to user content, never a name under Studio's or the API's domain
  (the controller refuses that), and list it on the [Public Suffix List](https://publicsuffix.org/). Until it is listed,
  all users' sites on it, previews and public tunnels alike, share one cookie scope: any of them can set
  `Domain=<domain>` cookies the others receive, and they count as same-site to each other. The controller logs a
  warning at startup while the domain is not a public suffix.

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
  services are denied, plus `PREVIEW_DENY_PORTS`. At most 16 open previews and 30 creates a minute per machine; a wake
  that would reconnect a stopped or closed preview past the 16 fails with the same "Close one first".
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
  Viewing windows (`runtime_preview_viewing_windows`) are pruned after 48 hours.
- **Keep-awake.** Only members who may change the space keep it awake by viewing, for at most 4 hours per person, space
  and day, counted from that person's first viewing there, whatever the number of sessions. A view-only member's
  viewing, and a removed member's heartbeat (`410`), keep nothing up.
- **Wake.** The recorded start command runs as argv, never through a shell, only in its directory under the space's
  workspace, with a stripped environment. A command line that looks like it carries a secret is not recorded (the CLI
  and the controller both check), and the generic tunnel routes never return the command. A stopped machine is started
  only for members who may change the space, so a read-only member cannot spend its credits by opening a card.
- **Who may record a start command.** The runtime agent later runs the command with its own authority, outside any
  sandbox, so only callers that already have that authority may record one: the runtime itself (its machine token),
  Octo's turns on it (their job token; they run with full access on the runtime), and members who may change the
  space (who can ask Octo to run any command anyway). Sandboxed code never holds a controller token: the runtime
  refuses to hand one to an isolated tool worker, so a command that could not run inside the sandbox cannot be
  recorded to run outside it later.

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
  while the pane is hidden. It ends, with any answer still pending, when the frame reloads or the site moves to
  another page inside the frame (the new page did not ask), and when the tab closes or the person leaves the
  conversation.
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

- Geolocation is allowed only for Studio's own top frame on the Studio origin. A preview frame, any other subframe
  and any other origin are always denied.
- One question. On macOS, Location Services asks the person once, with Instafy's usage string, and keeps the answer;
  the app asks nothing of its own. On Windows and Linux the app asks once ("Allow Instafy to use your location?")
  and remembers the answer, either way, in `desktop-config.json` for that origin.
- Frames inside a Studio window get only fullscreen, clipboard writes and pointer lock. Everything else
  (notifications that would look like Instafy's, storage access, camera, sensors) is denied to them.
- **Location Permission…** in the app menu and Settings → Profile → Location show the answer and can reset the app's
  own one. Nothing can grant it except the native question. On macOS they point to System Settings → Privacy &
  Security → Location Services. When a site asks and the app itself allows location but the operating system
  refuses, the pane's note points to the operating system's settings, not the app's.
- The mac build carries the location usage strings and the location entitlement that the hardened runtime needs.

### Messages

All messages use one envelope, version 1. A site names itself in `source` with a short lowercase name of its own
choosing (`[a-z][a-z0-9-]{0,39}`). The name is not trusted for anything. `instafy-host` is Studio's own.

Studio → site, on every frame load and when Studio's theme changes:

```
{ "source": "instafy-host", "v": 1, "type": "layout", "caps": { "location": "host" }, "theme": "light" }
```

`caps.location: "host"` means the person's location is available through Studio: ask Studio, not
`navigator.geolocation`, which the frame may not use. `theme` is Studio's, so a site can match it: the bind client
puts it on `<html data-theme>`, which the starters' `theme.css` reads. A framed page's `prefers-color-scheme` can
follow the device instead of Studio's theme (it does in Chromium and WebKit), so a page that reads only it can differ
from Studio. A site that speaks before it got the layout is sent it again. In a conversation's preview pane the layout
also carries `caps.ask`: `true` when this person may send messages there, so a site's Ask Octo click (`ask`) is sent
as their own message, or the plain reason they may not (Bound-Sites.md §2a).

Site → Studio:

```
{ "source": "my-site", "v": 1, "type": "location-request", "payload": { "id": "r1", "watch": false, "highAccuracy": false } }
{ "source": "my-site", "v": 1, "type": "location-stop", "payload": { "id": "r1" } }
```

`id` is the site's own short id (`[A-Za-z0-9:._-]{1,64}`). It only comes back to that site.

A page that draws itself after it loads can list `ready` in its `layout-ack` and say when its first view is drawn,
the moment it sets `data-instafy-ready="true"` (see
[The card's picture and facts](#the-cards-picture-and-facts)):

```
{ "source": "my-site", "v": 1, "type": "layout-ack", "payload": { "supports": ["ready"] } }
{ "source": "my-site", "v": 1, "type": "ready" }
```

Until then the pane goes on saying it is opening the site ("Loading…" after Reload), for at most 15 s. It waits once
each time it loads the frame fresh (the press, Reload): a `ready` said before the frame's load event counts, and a page
that moves on inside the frame after that shows as it loads. Its line stays through the frame's load until the page
answers the layout sent then, so it does not go off for that moment: a page that does not list `ready` is shown at that
answer, or 250 ms after its load when it does not answer.

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

A site that wants to work both inside Studio and on its own checks for `?instafy_host=studio` or the layout
message and uses this path there, and `navigator.geolocation` elsewhere. Studio adds the query only to the frame's
first address, so after the site moves to another page only the layout message (sent on every load) says it; a site
can keep the flag in `sessionStorage`. The `instafy-frontend-previews` skill (its
`references/studio-host-messages.md`) tells Octo this.

### Limits of this version

- A site is keyed by its space, preview title, port and path. Two different sites with the same title in the same
  space share a stop.
- The list and stops are per device. Stopping a site on a laptop does not stop it on a phone.
- The desktop app's handling was tested in a real Electron window (`smoke:studio:permissions`), not in a signed,
  notarized mac build.

## Before a hosted launch

None of these block a local or self-hosted merge, because everything is off by default.

- **User-content domain.** Hosted previews need a registrable domain dedicated to user content (it may be the tunnel
  domain, see [One user-content domain](#one-user-content-domain)), listed on the Public Suffix List, plus wildcard
  DNS and TLS. Until it is listed, all users' sites on that domain can set cookies for each other. The controller's
  startup check keeps the domain off the Studio and API hosts and off anything above, below or next to the tunnel
  domain.
- **Label binding.** Bind each label to the first browser that opens it with a partitioned `__Host-` cookie, so a
  leaked label stops working elsewhere. That needs Traefik 3.1 or later (`addAuthCookiesToResponse`); the stack runs
  3.0. Keep the short idle window as the fallback where partitioned cookies are not supported.
- **Long-lived connections.** A site's own WebSockets and SSE streams opened before a revocation stay open until they
  end. Put preview routers on their own Traefik entrypoint with bounded idle and write timeouts, or give the broker a
  way to cut upgraded connections.
- **Defaults to confirm.** Whether every space member who can read the space, read-only viewers included, can open a
  preview.
