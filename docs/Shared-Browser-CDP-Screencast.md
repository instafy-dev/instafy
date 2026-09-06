# Shared Browser CDP screencast transport

The CDP screencast viewer keeps the Shared Browser's hosted Chromium identity and
local Instafy toolbar, but sends only page-viewport JPEG frames instead of a
remote X11 desktop framebuffer. It is both WebRTC's first failure fallback and
Studio's preferred compact-viewport renderer, where changing the actual Chromium
viewport produces responsive page reflow instead of scaling a fixed-aspect video.

## Enabling it

Both ends are explicitly flag-gated:

- Frontend: `VITE_INSTAFY_SHARED_BROWSER_CDP_SCREENCAST=1`
- Runtime: `INSTAFY_BROWSER_CDP_SCREENCAST=1`

The frontend passes the runtime flag when it ensures a browser runtime. A
CDP-only origin advertises `viewerKinds: ["cdp-screencast", "rfb"]` and prefers
`cdp-screencast`; a WebRTC-enabled origin advertises
`["webrtc", "cdp-screencast", "rfb"]` and normally prefers `webrtc`. Compact
Studio still selects CDP when it is advertised. A fatal WebRTC failure falls
through to CDP, and a fatal CDP failure falls through to RFB, on the same runtime
and profile.

## Connection and authentication

Every participant requests `browser.view` and opens the view-only pixel socket:

- Direct origin: `GET /browser/screencast`
- Controller proxy: `GET /origin/:originId/browser/screencast`

Both WebSocket paths validate the dedicated browser view scope; workspace file scopes
cannot open them. `pageId`, logical `width`/`height`, and `dpr` are the only
transport query parameters forwarded through the controller. CDP remains bound
to the runtime's configured loopback port and a target returned by Chromium's
local `/json/list`; callers cannot supply a CDP URL or method.

The pixel socket closes at the signed browser grant's absolute expiry. Studio
rotates the grant and renderer before that deadline. Runtime admission also
caps CDP/RFB pixel sockets per signed participant and across the runtime.

Builder-or-higher participants also receive `browser.control` and open the
separate input socket used by both CDP and WebRTC. The socket is useful only
while that exact signed browser session owns the runtime-wide driver lease:

- Direct origin: `GET /browser/input`
- Controller proxy: `GET /origin/:originId/browser/input`

## Frame flow and bounds

Before starting the event stream, the origin requests one bounded
`Page.captureScreenshot` bootstrap JPEG. Chromium may not emit an immediate
`Page.screencastFrame` to a second CDP viewer when another teammate is already
streaming the same page; the bootstrap guarantees that every new viewer paints
the current page instead of exposing the canvas background. It uses the same
16 MiB payload ceiling, gets an origin-generated frame id, and needs no upstream
Chromium acknowledgement.

The origin then starts `Page.startScreencast` and permits at most one
client-visible unacknowledged event frame plus one queued latest frame. If
Chromium produces more frames while one is pending, the origin retains the
newest one, acknowledges any older queued frame it replaces, and promotes the
retained frame as soon as the pending frame is acknowledged. A five-second
acknowledgement timeout performs the same promotion so a failed decoder cannot
permanently stall Chromium. This prevents a navigation paint from being lost
behind the initial blank frame on a higher-latency tunnel.

Chromium's `sessionId` identifies the entire screencast session and is intentionally
reused across its frames, so it remains internal to the origin and is used only for
upstream `Page.screencastFrameAck` commands. The origin assigns each client-visible
frame a connection-local, monotonically increasing `frameId`; client `ack` messages
must match that exact id. A late acknowledgement for a frame promoted by the
five-second timeout therefore cannot accidentally release its replacement.
This breaking wire contract is advertised as Shared Browser capabilities version 2;
version 1 clients and origins fail capability negotiation instead of mixing the two
acknowledgement schemes.

JPEG decoding is asynchronous, so only a `frameId` newer than the highest
successfully painted id may draw to the canvas; a late older decode is closed and
acknowledged without repainting. A decode owned by a disposed/replaced connection
is closed without touching the canvas. This prevents an initial blank frame from
overwriting a newer navigation frame after it finishes decoding, including across
reconnects. The UI reports the transport ready only after its first eligible JPEG
paints and queues that acknowledgement before the Ready update; a ten-second
watchdog falls back instead of leaving an empty but apparently connected canvas.

Limits:

- Logical viewport: 240–3840 by 160–2160 CSS pixels
- DPR: 0.5–3, reduced when needed to stay under 8,294,400 device pixels
- Encoded frame payload: 16 MiB maximum
- Client input message: 16 KiB maximum on `/browser/input`
- Open input sockets: 2 per signed surface during grant rotation, 64 per runtime
  (32 steady sockets plus one rotation slot per participant)
- Input ingress and dispatch: 240 frames per second per connection, counted
  before live-authority checks; a rapid revoked-driver burst closes the socket
- Inserted text: 8 KiB UTF-8 maximum

## Input contract

The screencast socket accepts only positive origin-generated `frameId`
acknowledgements. All mutation uses `/browser/input`, which revalidates the
current human driver for every message before dispatching any CDP command. Its
strict, deny-unknown-field messages are:

- `resize`: logical `width`, `height`, and `dpr`
- `mouse`: pressed/released/moved, bounded viewport coordinates, button mask,
  modifiers, and click count
- `wheel`: bounded viewport coordinates and deltas
- `key`: raw/key down, key up or char with bounded key/code/text values
- `text`: bounded `Input.insertText` content

`resize` is the only lane that applies `Emulation.setDeviceMetricsOverride`.
Viewer-only participants never resize the shared Chromium page. A handoff keeps
the old input socket open for transport continuity, but every subsequent message
from it is rejected because its signed session no longer owns control.

The frontend adapter in `remoteBrowserInput.ts` is transport-independent and is
shared with the WebRTC viewer. Neither viewer accepts arbitrary CDP method names,
JavaScript expressions, URLs, or payload objects from the browser client.
Physical and mobile Enter keys send `keyDown` with carriage-return text (`\r`),
followed by a text-free `keyUp`, so Chromium performs form submission and textarea
line breaks. Ctrl/Alt/Meta shortcuts remain nonprinting; Shift+Enter retains its
normal line-break behavior. A raw key-down alone does not generate the character
event needed for these default browser actions.

## Verification

Focused checks:

```bash
pnpm -C packages/frontend exec vitest run \
  src/screens/studio/components/__tests__/CdpScreencastViewer.test.tsx \
  src/screens/studio/components/__tests__/cdpScreencastProtocol.test.ts \
  src/screens/studio/components/__tests__/remoteBrowserInput.test.ts \
  src/screens/studio/components/__tests__/sharedBrowserViewer.test.ts \
  src/services/__tests__/browserSession.test.ts

pnpm --filter @instafy/frontend build

cd packages/origin-http-server
cargo test browser_screencast
```
