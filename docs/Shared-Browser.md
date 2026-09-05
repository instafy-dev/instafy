# Shared Browser

> **Status:** the implementation supports CDP screencast with HiDPI RFB fallback, plus an
> optional WebRTC transport. WebRTC and durable profile persistence are default-off and must be
> enabled deliberately by each deployment after connectivity and privacy validation.

Shared Browser is the project-scoped, web/mobile-compatible browser identity. Cookies, tabs, storage, and network location stay in the project runtime. The Electron app renders the same remote session and never imports it into the device-local Personal Browser profile. Profile separation is not an OS sandbox from other processes in that runtime; see [browser profiles and login continuity](Browser-Profiles.md).

## Runtime eligibility

Shared Browser is an Instafy Cloud collaboration surface, not a way to expose a contributor's self-hosted runtime. Studio accepts only the exact canonical managed `instafy-cloud` route. The controller independently enforces the same rule before origin view/control grants, browser-only job creation, durable browser-profile GET/PUT, profile reset, and privileged provider authentication. An ordinary or custom self-hosted runtime remains private to its immutable controller-attested owner even when its project is shared; a cloud-looking provider label or prefix cannot create managed-cloud authority. Personal Browser is never shareable.

The managed browser image is also a controller/provider decision. Studio asks
for the harmless `runtimeFlavor: "webdev"`; it never sends an image reference
or `RUNTIME_CAPABILITIES`. For the exact canonical route, the controller strips
all unrecognized request metadata and environment variables. Its small
allowlist contains only safe product metadata plus the browser launch/render
settings Studio actually uses; Docker/Compose/BuildKit configuration, process
paths/proxies, image/build controls, capabilities, approval/control settings,
and protected launch markers are rejected. The provider independently applies
the corresponding runtime-container allowlist before Docker or cloud-init. The
controller converts the validated flavor into a controller-only launch attestation bound to the new
runtime lease ID. Reusing an active lease cannot change that flavor. The
provider accepts the attestation only when its generation matches the ensure
request's lease, then maps it to its configured deploy-pinned
`RUNTIME_AGENT_WEBDEV_IMAGE` (`repo@sha256:<manifest digest>` for hosted deployments).
The release-SHA tag is retained only for discovery/debugging; tags are mutable
and cannot establish the bytes a new runtime will pull.

Runtime registration cannot self-assert this provenance. The controller always
removes `_instafySharedBrowserAgentConsent` from reported capabilities and
re-adds exactly `{ "version": 1 }` only when the locked active lease carries a
valid exact-provider webdev launch attestation for that same generation. This
capability records trusted Shared Browser agent-lane provenance; it is not a
grant for any origin or action. The human confirmation policy below remains
the authorization boundary.

There is no Team runtime mode. Adding one later requires host-local consent, separate browser/workspace/shell/network/hardware grants, visible viewer/controller identity, expirations, an immediate kill switch, audit events, live socket revocation, and an OS sandbox. See [Self-Hosted-Runtime-Security.md](./Self-Hosted-Runtime-Security.md).

## One browser shell, three pixel transports

The Studio always owns the address bar, Go/history controls, status, errors, action ticker, and AI cursor. The runtime owns the page and profile.

```text
Studio Shared Browser shell
  ├─ browser.view pixels + metadata
  ├─ browser.control input + commands (current driver only)
  ├─ ephemeral participant/cursor/control WebSocket
  └─ negotiated pixel transport
       1. WebRTC VP8 video + bounded CDP input
       2. CDP Page.startScreencast JPEG + bounded CDP input
       3. HiDPI RFB + noVNC
             ↓
       viewport-only Chromium + project profile
```

`GET /browser/capabilities` returns a versioned, `Cache-Control: no-store` contract. Studio waits for that authoritative response before opening a pixel transport, so runtime discovery cannot briefly connect RFB and then tear it down to upgrade. A WebRTC-enabled runtime advertises `webrtc`, `cdp-screencast`, and `rfb` in that order. A CDP-only runtime advertises `cdp-screencast` and `rfb`; RFB is always the safety lane. Runtime capabilities are authoritative—the Vite flags provision transports on new runtimes, while the runtime flags are the operational kill switches.

Fallback stays on the same runtime and profile. A fatal WebRTC error moves to CDP; a fatal CDP error moves to RFB. During reconnect the UI captures a bounded frozen frame, keeps the prior page visible, and shows an explicit **Reconnecting…** state. CDP is ready after its first painted JPEG. WebRTC controllers wait for both a decoded video frame and the separate input WebSocket; view-only participants are ready from video alone and never open the input socket. CDP has a bounded first-frame startup watchdog; WebRTC also monitors active, visible video for frame stalls.

## Multi-user presence and exclusive control

All project members may join the runtime-scoped collaboration channel. Presence
is additionally tagged with the active CDP page, so a named cursor is rendered
only over the page its owner is actually pointing at. Presence contains bounded
participant IDs, signed display labels, page IDs, normalized x/y coordinates,
and control requests only. Typed text, keys, clipboard contents, field values,
URLs, and page content are rejected by this strict collaboration protocol and
are never placed in Postgres. The separate ephemeral agent action log contains
bounded action labels, URLs, target labels, and key names for the visible cursor
and ticker, but never typed values, clipboard contents, or full page content.

The origin owns one driver lease for the entire browser runtime because tab
focus, navigation, viewport, and keyboard focus are shared Chromium state. The
first Builder-or-higher participant acquires it; another eligible participant
can request control, and the current driver can grant or release it. Viewers get
`browser.view` pixels and presence but never receive input authority. Each
controller-minted browser token signs both the user subject and an in-memory,
per-mounted-surface `browserSessionId`, so duplicated tabs, devices, and
side-by-side browser surfaces cannot silently drive as one participant. Display
names are also controller-attested from the account profile, but are
presentation metadata—not authorization.

This is enforced at the origin, not merely disabled in React. Toolbar commands
check ownership immediately before CDP mutation. The separate CDP/WebRTC input
socket checks every message, so an already-open former-driver connection cannot
continue after handoff. A normal leave releases immediately; an unclean network
disconnect keeps the same signed session for ten seconds so a short Wi-Fi loss
can reconnect without stealing control. The UI fails closed while its presence
channel reconnects. It accepts only the exact bounded server schema (64 KiB,
at most 32 participants and 32 requests); an invalid authoritative message
clears local ownership immediately and closes/reconnects the socket rather than
preserving stale controls. Browser grants rotate before their signed expiry: the
replacement collaboration socket joins under the same participant before the
old socket closes, preserving the driver/request state, while stale input and
pixel sockets are bounded by the signed deadline. Studio also caps the refresh
interval at eight minutes, ahead of the sender's ten-minute peer ceiling.
WebRTC renegotiates its video peer with the rotated grant instead of outliving
the authority that created it.

Cursor movement is coalesced at both client and origin to at most one shared
state publication every 50 ms. CDP/RFB pixel streams are capped per participant
and per runtime. The separate CDP input lane admits at most two overlapping
sockets per signed surface for grant rotation and 64 across the runtime (one
steady socket plus one rotation slot for each of 32 participants), before
resolving a CDP target. Collaboration ingress is capped at 120 frames per second
per connection and 12 control actions per 10 seconds; input counts every frame
against its 240-per-second budget before authority or marker work, and closes a
former driver's socket after a bounded rejected-input burst. WebRTC separately
caps active peers and offer attempts. These bounds keep presence, rejected
input, or renderer reconnects from becoming an unbounded runtime fan-out.

RFB cannot safely separate pixels from arbitrary raw input without parsing the
RFB client protocol. It therefore remains driver-exclusive: non-drivers use
WebRTC or CDP, and the origin rechecks the exact owner before forwarding every
client packet (with a one-second idle poll to close a quiet revoked bridge). It
is not presented as a view-only collaboration lane.

Agent control uses the same runtime-wide authority. A Shared Browser job writes
a strict, mode-0600 heartbeat marker under the protected runtime directory
`/run/instafy/browser` before prompt/context preparation and refreshes it for
the turn. The origin publishes the agent as the control owner, rejects every
human mutation, preserves the previous live human driver, and restores that
driver only when the job guard explicitly removes the marker after Codex and
its tool tasks have fully shut down. `ShutdownComplete` is accepted only after
shutdown has gated new task installation, serialized any overlapping guardian
abort, disabled pending-work restart, aborted and joined the active turn, and
confirmed that both active and retired MCP process groups are gone. A
passed heartbeat deadline is diagnostic, not proof that execution stopped, so
expired, unreadable, or malformed marker state remains agent-owned and
fail-closed. A heartbeat write failure, lease loss, external cancellation, or
run deadline enters the same bounded cleanup supervisor. Codex gets a fixed
eight-second confirmed-shutdown window inside a ten-second outer drain cap; if
it stalls, panics, loses an MCP startup race, or cannot prove child-process
exit, the guard leaves authority in place and recycles the runtime. Heartbeat
writes and marker release share one
serialized file lane, and a read, ownership, parse, or remove failure is never
treated as successful release. Runtime startup clears an old-process marker
before origin starts; origin and the executor share that process, making a
fresh process the other safe restoration boundary. Conversation-local run
state remains a fast UI hint; the origin marker is what makes the lock
consistent for teammates viewing from other conversations or devices.

## Deterministic agent execution

A Shared Browser message is an explicit browser-only run, not a normal workspace
turn that happens to mention a web page. Studio resolves the runtime that owns
the visible Shared Browser and dispatches this contract:

```json
{
  "runtimeId": "<visible-browser-runtime-uuid>",
  "metadata": {
    "browserTransport": "shared",
    "browserConsentVersion": 1,
    "browserRuntimeId": "<same-runtime-uuid>",
    "browserPageId": "<UI-selected-CDP-TargetID>",
    "runtimeExpectations": {
      "workspaceFileChanges": false,
      "commandExecution": false,
      "browserExecution": true
    }
  }
}
```

The composer blocks the send until that runtime is resolved. Before any job is
written, the controller requires the explicit `runtimeId`, rejects conflicting
transport/runtime aliases, and canonicalizes the request to one agent, exact
runtime routing, a read-only workspace scope, browser execution only, and no
runtime spread or multi-agent plan. If a browser-bound model response still
emits a plan action, the controller rejects it before any sibling job or runtime
is dispatched. It never clears or retargets that binding.
If the bound runtime stops after dispatch, both queued and leased Shared Browser
jobs and their runs fail with a reconnect-and-retry error instead of becoming
eligible for another runtime. The runtime also requires the UI-selected page's
CDP `TargetID` as `browserPageId`, places it
only in the isolated Shared MCP environment, and fails closed if that exact page
is no longer available. It never falls back to the focused or first browser tab.
This exact pin is separate from the WebRTC/CDP/RFB pixel fallback: pixel
transport may change, but it stays on the runtime, profile, and page that own the
visible experience.

Current runtimes also require the controller credential and the internal
workspace credential to be separate before entering the browser-only lane. The
controller issues that second credential only to the exact targeted and leasing
Shared runtime. Its nominal protocol scopes do not grant write authority:
origin routes revalidate the active job, run, runtime lease/generation, project
role, `writeIntent`, and read-only scope, and reject both workspace lease and
origin-token mint attempts from a Shared Browser job.

`browserConsentVersion` is a rollout and execution boundary, not descriptive
metadata. The controller accepts exactly version `1`, injects its own
controller-attested consent capability for the selected runtime generation,
and the runtime validates both before it exposes the Shared Browser MCP server.
A client without version `1` receives an immediate refresh-required error. A
runtime generation without the matching attestation receives a
reconnect-required error. Neither case may fall back to an older unapproved
browser path.

## Human approval policy

Shared Browser uses confirmation, rather than a site denylist, as its
sensitive-site policy. Before the agent can observe a page, the user who
started the run must approve that exact normalized origin for the current run.
Cross-origin navigation or controls require a separate origin approval before
the destination can be read. Origin approval does not authorize an action.

Every navigation, click, type, form submission, and key press then receives a
separate one-shot action prompt bound to the run, runtime generation, page,
fresh snapshot/target where applicable, destination, and payload fingerprint.
The default-focused action is **Deny**. Only the initiating user with live
`browser.control` authority can decide; another teammate, another page, an
expired request, or a replay cannot satisfy it. Scroll is allowed only after
the page origin has been approved because it changes no remote state. Typing
authentication, payment, or identity secrets remains blocked outright and is
not made possible by approval.

A denial, timeout, stale request, revocation, storage failure, or malformed
approval protocol is terminal for that browser run. The runtime latches the
failure, rejects later mutations without opening another prompt, and reports
machine-readable terminal-consent state so the job layer does not invoke its
normal missing-action retry. The user starts a new turn if they want to try
again. This keeps “Deny” from becoming a sequence of repeated consent prompts.
If the client temporarily loses its network, it retains the exact visible
request, shows reconnecting state, and retries the bounded poll/decision path;
the origin's one-use fingerprint and replay checks remain authoritative.

The agent controls the page through one runtime-owned, required MCP server:

```text
instafy_shared_browser.status
instafy_shared_browser.snapshot
instafy_shared_browser.navigate / click / type / press / scroll
```

It exposes only status, bounded snapshots, navigation, click, type, key press,
and scroll operations. The runtime replaces every project-configured MCP server
with this one bounded server for the turn, disables shell and patch tools, and
connects to the runtime's loopback CDP endpoint internally. The model cannot
author Playwright/CDP scripts or receive a raw debugger endpoint. Click, type,
and every key press must carry both an index and the SHA-256 `snapshotId` from
the observed page. The selected CDP target is part of that fingerprint, so even
two tabs with identical URLs and DOM cannot replay each other's snapshots. The
controller recomputes that fingerprint immediately before acting and uses a
concrete element handle, so reordered or relabeled DOM cannot silently retarget
an action. It resolves `aria-labelledby` references into the raw safety
descriptor before classifying sensitive and consequential targets; Delete,
Backspace, Enter, and the rest of the key allowlist cannot bypass that
classification. CSS selectors are not accepted. The embedded controller loads
Playwright only from the image-installed absolute module path and runs from the
runtime-agent binary directory, never from project `node_modules`. Actions
return concrete observed page state, including the final URL and title.

Every high-level snapshot/action appends the cursor/action-ticker telemetry
owned by the Shared Browser shell. The runtime records the action-log position
before the turn and accepts completion only when it sees both a completed call
from the exact `instafy_shared_browser` server and new action evidence. A tool
event from another MCP server, a status-only narration, or prose success is not
accepted. Missing evidence gets one browser-specific retry that again requires
the bounded server and a fresh snapshot. If the retry still has no instrumented
action evidence, the job fails closed instead of presenting an unverified prose
success.

Page content is untrusted. Browser-only turns therefore have no local execution
environment, project MCP servers, web search, plugins, image generation, child
agents, patch/file tools, or learned-memory tools. Browser capability variables
are also stripped from shell children in ordinary turns. The hosted browser is
still in the same runtime OS boundary as ordinary workspace execution; moving
Chromium/control into a separate sidecar user or container is the remaining
defense-in-depth step against a deliberately hostile workspace process.

At normal desktop widths Studio follows the runtime preference, so WebRTC is the primary low-latency lane when it is available. At compact widths Studio deliberately selects CDP screencast when advertised: CDP resizes the actual Chromium viewport and lets the page reflow, while a fixed-aspect video would otherwise be scaled or letterboxed. Returning to a wide layout restores the preferred WebRTC viewer without changing the Shared profile or page state.

## Responsive and touch behavior

There is one canonical Chromium viewport per Shared Browser runtime. The current
human driver owns viewport resize; differently sized spectators do not fight it.
CDP, WebRTC, reconnect snapshots, the app-owned AI cursor, teammate cursors, and
human input all use the same `object-fit: contain` page rectangle. Portrait,
landscape, and split-pane spectators therefore see neutral gutters instead of a
stretched page. Pointer and wheel events in those gutters are rejected rather
than clamped onto a live edge pixel. A drag that leaves the page still releases
its previous in-page mouse press, preventing a stuck button. Decoded
canvas/video dimensions are authoritative for this rectangle; a spectator's
locally requested socket size cannot override the aspect ratio of shared pixels.

On coarse-pointer clients a tap becomes one remote click, while a one-finger
drag becomes bounded remote wheel scrolling without an accidental click. CDP
and WebRTC drivers also get an explicit **Keyboard** control. It opens a local
16px text field so iOS/Android can summon their software keyboard, then sends
bounded text, paste, IME composition, Backspace/Delete, Enter, Tab, Escape, and
arrow keys through the same origin-authorized input socket. The control
uses neutral capitalization with autocorrection and spellcheck disabled because
it cannot infer the remote field's type, and disappears immediately when human
authority is revoked. RFB remains the final
noVNC fallback and uses noVNC's own input path; the app-owned mobile keyboard
bridge is intentionally not shown there.

Below 540px the browser bar keeps navigation/address controls on the first row
and adds a compact context strip for connection state, participants, the
current human/agent controller, and request/grant actions. Important narrow
targets are at least 40px, with 44px coarse-pointer variants where applicable.
The extra row deliberately trades about 40px of stage height for visible
ownership and safe touch control.

## Enabling the ladder

A safe initial configuration is:

```bash
VITE_INSTAFY_SHARED_BROWSER_CDP_SCREENCAST=1
VITE_INSTAFY_SHARED_BROWSER_WEBRTC=0
TURN_ENABLED=false
BROWSER_PROFILE_PERSIST_PROJECT_IDS=
```

WebRTC must only change to `1` after TURN is deployed and a project is explicitly allowlisted.
WebRTC provisioning also enables CDP so it has an immediate fallback. Runtime flags are:

```bash
INSTAFY_BROWSER_CDP_SCREENCAST=1
INSTAFY_BROWSER_WEBRTC_ENABLED=0
INSTAFY_BROWSER_PREFERRED_VIEWER=cdp-screencast
INSTAFY_BROWSER_WEBRTC_FPS=30
INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS=3500
```

### Existing tunnel and infrastructure reuse

CDP and RFB require no new generic edge tier. They reuse the hosted runtime, origin instance, scoped controller grants, and existing project tunnel. That path carries capabilities, page commands, authenticated CDP/RFB WebSockets, and—when enabled later—WebRTC signaling and bounded input. WebRTC media must not traverse the application tunnel; its relay-only media path requires the dedicated TURN tier. Before redesigning CDP delivery, instrument controller JPEG-relay bandwidth, latency, and concurrent viewers.

Hosted WebRTC uses coturn REST authentication. Deploy a dedicated relay with stable DNS, TLS, and
a firewall that exposes only:

- `turn:<host>:3478?transport=udp` for the normal low-latency path;
- `turns:<host>:443?transport=tcp` for restrictive networks;
- a bounded UDP relay range; and
- any certificate-challenge endpoint required by the chosen ACME setup.

The relay range belongs only to the TURN firewall; it is not opened on the controller or runtime
fleet. coturn denies private, loopback, link-local, multicast, and other reserved peers, uses
`use-auth-secret`, and reads the same high-entropy secret as the controller. Keep metrics private,
automate certificate renewal, and health-check both the listener and certificate.

A self-hosted deployment provides:

```bash
TURN_ENABLED=false                              # default; dedicated-tier switch
TURN_PUBLIC_HOST=turn.example.com               # DNS-only, never proxied
TURN_ACME_EMAIL=ops@example.com
TURN_RELAY_MIN_PORT=49152
TURN_RELAY_MAX_PORT=49251
CONTROLLER_BROWSER_TURN_SHARED_SECRET=<32-or-more-random-bytes>
CONTROLLER_BROWSER_TURN_CREDENTIAL_TTL_SECONDS=3600
CONTROLLER_BROWSER_WEBRTC_PROJECT_IDS=<comma-separated-project-uuids>
```

Store the shared secret in the deployment secret manager and provide the resulting TURN URL list
only to the controller. An empty or absent `CONTROLLER_BROWSER_WEBRTC_PROJECT_IDS` enables WebRTC
for no projects, which is the safe initial state. A comma/whitespace-separated list enables only
those project UUIDs (maximum 256). Projects outside the allowlist stay on CDP or RFB even if the
frontend can request WebRTC.

The URL list accepts at most four comma-separated `turn:`/`turns:` URLs. The shared secret must be 32–4096 bytes; the optional TTL defaults to 3600 seconds and must be 300–86400. URLs and secret are required together, and controller startup rejects partial or malformed configuration.

The controller mints coturn REST usernames that bind expiry, project ID, and runtime ID, then derives credentials with HMAC-SHA1. It refreshes that derived credential on every proxied capabilities and offer request rather than treating the runtime's ensure-time credential as the long-lived source of truth. Studio re-fetches `GET /browser/capabilities` immediately before creating a peer, and the offer path independently carries the same negotiation's fresh server-side credential into the Pion sender. The shared secret itself never leaves the controller. The refresh path is covered locally but still needs a reconnect-after-TTL test against the deployed host.

The controller-owned merge overwrites provider/runtime ICE data and sets `INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN=1`. The origin exposes `webrtc.relayOnly`, Studio uses `iceTransportPolicy: "relay"`, and the sender also enforces relay-only ICE. Managed hosted sessions therefore cannot silently fall back to host or server-reflexive candidates. Credential-bearing responses are `Cache-Control: no-store`. Provider-supplied static ICE credentials remain available only for disposable local testing when managed TURN is unset.

TURN topology changes mutate shared network and certificate state. Review them as infrastructure
changes, prove them with a disposable project, and drain affected sessions before removing a relay.
Deployment-specific cutover and teardown procedures belong in the operator's private runbook.

## WebRTC implementation and current limit

The runtime image now contains a small Pion sender. It captures the X11 Chromium display with ffmpeg, encodes realtime VP8, and serves bounded non-trickle SDP offers on loopback. The origin proxies only the authenticated offer; clients cannot reach the sender directly. Peer count, pending offers, request rate, SDP sizes, ICE configuration, and negotiation time are bounded. The origin injects the signed browser-view deadline into the loopback offer, and the sender closes the peer at that deadline (with a ten-minute safety ceiling). Capture starts for the first viewer, is shared across viewers, and stops after the last viewer leaves.

This is a real transport implementation with controller-minted, expiring TURN credentials. It is
not proof that a particular deployment's relay is reachable. WebRTC must remain default-off until
forced-relay tests pass from the supported web and desktop clients. CDP and RFB do not depend on
TURN.

The authenticated relay smoke derives a temporary REST credential, proves both TURN/TLS over TCP 443 and TURN over UDP 3478 with real relay allocations, then confirms that an invalid credential is rejected:

```bash
TURN_HOST=turn.example.com \
TURN_SHARED_SECRET="$TURN_SHARED_SECRET" \
node scripts/turn-relay-smoke.mjs
```

Run this after provisioning when `TURN_ENABLED=true`. A passing server-side smoke is required but
not sufficient; the deployment must also reconnect after the configured credential TTL from both
real client types.

## Deployment order

1. Keep the WebRTC flag off, `TURN_ENABLED=false`, and both project allowlists empty.
2. Deploy TURN with an empty project allowlist. Prove authenticated UDP and TLS/TCP relay
   allocation, independent-network reachability, metrics, and certificate renewal.
3. Pilot one disposable project from signed Electron and normal web clients. Prove relay-only
   candidates, reconnect after credential TTL, input, and WebRTC → CDP → RFB fallback.
4. Expand WebRTC and durable-profile allowlists only after their separate connectivity and privacy
   decisions are complete. To stop WebRTC, first clear the allowlist or turn off the frontend flag;
   only then tear down TURN.

## CDP screencast

The CDP lane gives every newly joined viewer one bounded `Page.captureScreenshot`
bootstrap frame, then uses a view-only `Page.startScreencast` socket with one
in-flight frame and decode/paint-before-ack backpressure. The bootstrap prevents
a second teammate or rotating grant from exposing an unpainted black canvas
while Chromium waits for the next visual change. The pixel lane accepts frame
acknowledgements only. Human resize, pointer, wheel, keyboard, and text messages
use the separate bounded `/browser/input` socket shared with WebRTC, and every
message requires the current signed driver lease. Neither lane accepts a CDP
method name, JavaScript expression, arbitrary target URL, or raw debugger
endpoint. Details and limits are in
[Shared-Browser-CDP-Screencast.md](./Shared-Browser-CDP-Screencast.md).

Besides being WebRTC's first failure fallback, CDP is the deliberate compact-viewport renderer. It changes Chromium's logical viewport so responsive sites reflow at narrow widths instead of stretching a fixed-aspect video frame.

## Adaptive HiDPI RFB

RFB remains the broadest-connectivity fallback and now has an end-to-end 1x/2x render path rather than a frontend canvas multiplier:

- Studio requests 2x only for a dense display whose initial surface fits the 8,294,400-pixel default budget.
- TigerVNC physical geometry/DPI and Chromium device scale use the same runtime-advertised `renderScale`.
- noVNC remote resize multiplies logical geometry by that scale, preserves aspect ratio, and respects `maxFramebufferPixels`.
- Encoding quality and compression adapt as the framebuffer approaches its cap.
- Pointer input and the app-owned AI cursor map browser CSS coordinates through the actual canvas/video device dimensions.

The default ceiling is 3840×2160. Configure it with `INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS`; configure the fixed 1–2 scale with `INSTAFY_BROWSER_RENDER_SCALE`. The scaled resize adapter targets the pinned noVNC 1.5 internal resize hook, so a noVNC upgrade must rerun the focused geometry/input tests.

HiDPI makes text materially sharper. It does not remove RFB frame latency; the native-looking result comes from combining viewport-only Chromium with Studio-owned chrome.

## Runtime egress isolation

Every enabled Shared Browser session starts a dedicated stdlib-only HTTP/CONNECT
proxy on `127.0.0.1:9226` before Chromium. Chromium is launched with that proxy,
the implicit loopback bypass removed, QUIC disabled, and its WebRTC IP policy set
to `disable_non_proxied_udp`. If the proxy binary, policy configuration, or
readiness check fails, Chromium is not launched; the non-browser agent runtime
can continue operating.

The proxy resolves each hostname itself, validates every returned address, and
dials a selected validated IP directly. This pins DNS resolution to the outbound
connection and fails closed on mixed public/private DNS answers. It denies
loopback, RFC 1918/private, link-local and metadata, multicast, unspecified,
IPv4-mapped private, CGNAT, benchmark, NAT64-bypass, documentation, and reserved
destinations. The listener is loopback-only; request/response headers, resolver
and dial timeouts, tunnel idle time, allowed ports, and concurrent connections
are bounded. Defaults are:

```bash
INSTAFY_BROWSER_EGRESS_ISOLATION=1
INSTAFY_BROWSER_EGRESS_PROXY_BIND=127.0.0.1:9226
INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS=80,443
INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS=128
```

For local tests only, isolation can be bypassed by setting both
`INSTAFY_BROWSER_EGRESS_ISOLATION=0` and
`INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV=1`. Setting isolation off without that
explicit unsafe flag blocks browser startup. This boundary applies to the
runtime Chromium process; it is not a general network sandbox for arbitrary
agent processes or for the server-side WebRTC sender.

## Authorization and control boundary

Browser access is separate from workspace file access:

- `browser.view` covers capabilities, page metadata, actions, and pixels;
- `browser.control` covers focus, navigation, pointer, and keyboard input;
- CDP/WebRTC pixels require `browser.view`; their separate input requires
  `browser.control` plus the live driver lease; RFB requires both and is
  driver-exclusive.

`fs.read` and `fs.write` do not authorize browser routes. See [Shared-Browser-Authorization.md](./Shared-Browser-Authorization.md) for the exact mapping.

The high-level facade rejects privileged schemes, credential-bearing URLs,
unknown fields, oversized values, arbitrary CDP, and raw JavaScript. CDP and
the WebRTC sender remain loopback-only. The egress proxy blocks runtime-local
and control-plane destinations for Chromium navigation. The per-origin plus
one-shot confirmation policy above is the sensitive-site action policy for
otherwise public sites; a future denylist may reduce prompt volume but is not
an authorization substitute.

## Shared profile persistence and clearing

Durable Shared Browser state reuses the Project Secrets security boundary
rather than introducing another vault. The controller encrypts the pruned
Chromium archive with the same AES-GCM key, stores one controller-only row per
project/scope, and restores it only to an exact active managed-cloud lease with
the dedicated `agent.browser_profile` scope. Cookies, Local Storage, Session
Storage, IndexedDB, and required Chromium identity files are included; caches
and browsing history are not. The row is overwritten rather than accumulated
and is retained until a writer clears it or the project/organization is
deleted. There is no separate inactivity TTL.

Saves use compare-and-swap, not last-writer-wins. An authorized `GET
/agent/browser-profile` supplies the exact stored version and the
`x-instafy-profile-write-policy: versioned-v2` header. An authorized empty `404`
with that policy establishes version `0`. The runtime installs a validated
snapshot as an exact baseline, not an overlay on an older cookie database, and
uploads only to `PUT /agent/browser-profile/v2?version=N`. The controller
atomically creates version `1` only while the row is absent, or updates a row
only while its version still equals `N`. A stale writer receives `409` and
cannot overwrite the winning profile. Snapshots do not synchronize two live
Chromium sessions.

Archives are packed in deterministic file order, and the runtime hashes the
exact restored baseline before launching Chromium. An unchanged snapshot does
not consume a version or needlessly invalidate another writer. This compares
archive bytes, not semantic equivalence of website logins.

Periodic and shutdown saves share one serialized writer state. A failed
restore, conflicting or uncertain upload, cancelled upload, or invalid
acknowledgment disables further saves for that process. A runtime must restart
or be replaced and successfully establish a baseline before it can save again;
it never automatically adopts another writer's version. The browser may remain
usable locally while saving is disabled, so unsaved changes can be lost when
that runtime ends.

Final packing requires confirmed Chromium exit. Close has a bounded deadline;
a missing/ambiguous process identity, PID reuse, or timeout skips that final
upload and retains the last acknowledged stored snapshot. A successful close
signal alone is not treated as proof that the browser stopped.

A shutdown save also requires the runtime lease to remain active. Ordinary
controller/provider-initiated stops currently fence the lease before signaling
the runtime, so their final upload is rejected and recovery uses the last
successful periodic snapshot. Do not promise zero-loss graceful recovery for
those stops. A future reason-scoped pre-stop snapshot/acknowledgment protocol
must finish before fencing; profile reset must continue to fence old writers
without accepting a late upload. Periodic live-profile copies are best-effort,
not a transactional Chromium database backup.

Legacy `PUT /agent/browser-profile` requests on an upgraded controller are
authorized normally but then fail with `428`, even if they carry a version.
New runtimes require the `versioned-v2` policy and never fall back to the
legacy write route. Older controllers do not implement the v2 route, so
rollback or a mixed-controller deployment cannot silently turn a **new
client's** conditional save into a blind overwrite. An **old runtime talking
to an old controller can still perform a blind write**; protocol negotiation
does not protect that pair.

Roll out with an all-controller barrier, not just controllers-first ordering:

1. Disable durable persistence on every serving controller and drain/stop all
   profile-capable runtimes before introducing new writers. Confirm no old
   in-flight save remains. If preserving a final snapshot, finish it before
   closing this maintenance window's write gate.
2. Upgrade and verify **every** serving controller target, including standby
   targets that can receive failover traffic. Keep persistence disabled until
   the legacy route is rejected everywhere; one upgraded GET response does
   not prove the fleet is upgraded.
3. Roll out the new runtime image, enable the controller-owned allowlist, and
   start new runtime generations that establish a versioned baseline.

Before controller rollback, disable persistence on every controller, stop/drain
every profile-capable runtime, and wait for in-flight writes to finish. Keep
persistence disabled throughout rollback; do not roll back one target into a
live mixed-writer fleet. Deployment tooling must enforce these barriers.
This change does not itself implement a deployment coordinator. The persistence
compatibility change is intentional; ordinary browser use does not require
durable profile saving. Persistence remains default-off.

Builders and higher roles get one **Clear shared browser data** action in the
existing browser bar. After confirmation, `DELETE
/projects/:project_id/browser-profile` stops every potentially live trusted
managed runtime through the provider-fenced release path, takes the project
launch fence, rechecks that no replacement runtime can hold the decrypted
profile, and only then deletes the encrypted row. Provider ambiguity, failed
release, or a concurrent replacement fails closed and retains the row for a
safe retry. A historical `removed` runtime is considered released only when its
matching lease is released and its provider acknowledgement follows its latest
stop event; an unproved terminal label still blocks the clear. Both low-volume
proof events survive the ordinary 14-day telemetry pruning window and cascade
with runtime or project deletion. The action remains
available after a project is removed from the persistence allowlist so policy
rollback cannot strand stored login material.
Viewers cannot invoke it. A successful clear ends the current shared session
and Studio starts one fresh browser; the client suppresses automatic reconnect
while deletion is in flight.

This lifecycle deliberately adds neither a second secret system nor a new
audit ledger. Existing browser access grants retain the actor, project, scope,
lease, issuance, and expiry boundary. A future team activity stream may add a
small `profile_cleared` event, but that is not required for safe persistence.

## Operational notes

The local mixed-client collaboration proof launches one normal Playwright Chromium owner and one actual Electron teammate as distinct users. It joins both to the same runtime, origin, and CDP page with distinct signed surface sessions; keeps the Electron viewer at 390×844 while the web driver remains desktop-sized; verifies aspect-aware pixels and named cursors in both directions; proves viewer input is rejected; grants control from web to Electron; rotates the Electron driver to 844×390 without replacing the page/input identity; forcibly drops Electron's collaboration socket; and proves the same participant and driver lease reconnect within the ten-second grace. Its screenshot assertions reject blank/mostly-black repaint failures on both clients.

```bash
pnpm --filter @instafy/frontend test:e2e:desktop:shared-browser-collaboration
```

The separate responsive proof keeps one live Shared Browser mounted while it
moves through 360×800, 390×844, 844×390, 768×1024, and 1024×768. It checks
horizontal overflow, address/stage/composer geometry, painted pixels, URL and
DOM continuity, then drops both CDP pixel and input sockets at phone width and
requires a contained frozen frame plus a same-page reconnect:

```bash
pnpm --filter @instafy/frontend test:e2e:browser:responsive
```

These collaboration-only tests submit no AI turn and need neither managed credits nor
`~/.codex/auth.json`.

An opt-in local agent-turn proof may connect the machine's existing `~/.codex/auth.json` through the
visible Desktop credential flow. Electron main keeps only the supported ChatGPT subscription fields,
removes API-key and unknown fields, and sends the sanitized credential directly to the configured
controller. Renderer and preload code receive only availability and created-credential metadata,
never the path or contents. Disable traces, video, and automatic screenshots before exercising this
flow, use disposable local accounts and projects, and verify that the turn is recorded as BYOC with
no managed-credit debit. Hosted canary accounts and orchestration are deployment-private.

Operational invariants:

- Runtime image changes require a forced local rebuild
  (`STACK_FORCE_RUNTIME_BUILD=1 pnpm stack:up` or `pnpm stack:refresh`).
- Hosted runtimes must use an immutable, registry-verified image digest.
- A generic hosted runtime may be recycled for Shared Browser only when it belongs to the same
  project and has no active lease. Busy, custom, and other-project runtimes require explicit
  takeover.
- Durable profile persistence stays default-off. Client/provider metadata cannot self-enable it;
  the controller-owned allowlist gates both token scope and profile API access.
- Live actions remain serialized by the exclusive human/agent driver lease.
- Chromium navigation remains constrained by the runtime egress proxy and by per-origin plus
  one-shot action confirmation.
- Before enabling WebRTC, prove TURN reachability from signed desktop and normal web clients, force
  relay-only candidates, and verify automatic WebRTC → CDP → RFB fallback.

## Remaining work

- Evaluate optional risk-based prompt reduction only after deployment evidence;
  never weaken the universal per-origin and one-shot confirmation baseline for
  authenticated sessions.
- Prove TURN and forced-relay WebRTC from signed Electron and normal web clients.
- Turn the shipped CDP frame/relay telemetry into capacity alerts and limits before considering a new direct media path.
- Close the profile snapshot's sub-30-second hard-kill edge and add per-user private keys for a private tier.
- Run the responsive proof on real iOS Safari and Android Chrome hardware; the current automated phone/tablet matrix uses Chromium viewports plus a real Electron window at phone dimensions.
