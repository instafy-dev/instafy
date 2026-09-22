# Sharing a local browser tab

Status: Electron supports native WebRTC video with JPEG compatibility. Earlier
JPEG checks exercised touch, keyboard, independent scrolling, rotation and
revocation in physical Android Chrome and the iOS Capacitor QA app. Native video
has separate desktop qualification; those earlier phone checks do not qualify the
new transport. Native Android, physical iOS video, cellular/WAN performance and
multi-controller routing remain open.

The browser's location and its audience are separate choices. The browser location
selector says **This device** and **Workspace**. This device uses Personal Browser
on the owner's Electron device and starts private. Workspace uses the shared
workspace browser and its existing team session/account semantics. **Share tab…** opens an audience
picker, defaulting to **Selected people**. Choose existing members and select
**Start sharing**, or explicitly choose **Everyone with space access**. People in
the chosen audience select **View shared tab** under **Tabs shared with you** in
the conversation. The publisher controls sit beneath the local tab's address bar;
**People** expands the audience list, while **Stop sharing** remains visible. **Stop sharing** returns the tab to
private browsing. No browser runtime is allocated for this viewing session.

The picker includes direct space members and people with inherited organization
access. Selected-person shares are hidden from other members, and knowing a share
ID does not grant access. The owner can remove a person from either audience mode;
all of that person's viewer connections close, and they cannot rejoin that share.
Their space membership stays unchanged. To add people or readmit someone, stop
and start a new share with a new audience. It does not send invitations or grant
new project membership. People join as viewers; the owner can explicitly grant
one viewer connection control of the selected tab. Account cookies, profile files, agent
authority, shell and machine access are never granted to viewers. Pixels can
contain information from the owner's logged-in page. An approved controller can
act through that page's signed-in account. Other existing tabs are not selected. Independent Explore requires a separate
owner approval because it opens another page using this browser session.

## Human control handoff

The viewer selects **Request control**. Beneath the source tab's address bar,
the owner sees the participant's name and chooses **Allow control** or **Decline**.
The grant belongs to that exact connection; another window using the same account
does not inherit it. The viewer can click, type, use standard editing/navigation
keys and scroll the page. **Release control** returns to viewing.

While a viewer controls the tab, the native input shield blocks competing local
page input. **Take back control** in the owner toolbar or **Escape** in the native
page revokes local input immediately, before waiting for the network. Controller
state then catches up through the publisher's one-second heartbeat. Agent control
must be paused before granting a viewer, and cannot resume until human control
ends. Stop, removal and disconnect also revoke the grant.

The Desktop process enforces a four-second lease, renewed only for the existing
grant. A late heartbeat cannot restore a locally revoked grant. Both the controller
and Desktop recheck queued input against the active grant. This first input lane
supports atomic left clicks, bounded wheel/text messages and an allowlist of
editing keys. Dragging, right-click menus, arbitrary shortcuts, host clipboard and
file dialogs are not part of this lane. Older Desktop bridges continue to share
view-only until updated.

## Independent Explore

A viewer selects **Explore independently**, and the owner approves **Allow Explore**
under the source address bar. This creates a separate sandboxed page on the owner's
Electron device, initially at the source URL. Its responsive layout follows the
participant's available viewer area and pixel density. Expand and Minimize resize
that private page without resizing the source. Scroll, focus, input, navigation,
Back and Reload apply to the approved participant's page only. Follow continues
to display the source's shared layout and scroll position.

The new page uses the owner's existing cookies and persistent browser storage;
credentials and profile files never leave that device. It is **not** an independent
login or an isolated website account. Saved changes use the owner's account and
may appear in the source page when the website updates its state. Unsaved forms,
page memory, scroll and navigation remain separate. Websites that require an
in-memory login or prevent concurrent sessions may behave differently. Approval
permits normal web navigation in this session, not just reading the initial page.
The approval row explicitly explains the shared-account behavior.

**Return to follow** destroys the participant's private renderer and rejoins the
canonical stream without reconnecting the viewer socket. **End Explore** lets the
owner do the same. Removal, disconnect, Stop sharing and source closure retire the
view and fence queued input and late frames. A new request requires new approval;
late heartbeats cannot recreate a closed renderer. The exact connection owns the
view, including when another window uses the same participant account.

At most four Explore pages coexist per share. Each has a four-second native lease
and a thirty-minute maximum lifetime. Requested CSS viewports are bounded to
240–1920 by 160–1440; requested DPR is 1–3, reduced when necessary to keep captures
within 1.92 million pixels. Native capture also limits density to the owner's
available backing surface; higher requests never upscale an image. The JPEG
fallback is limited to one MiB and five captures per second per view. Private frames are delivered only to their assigned
connection. Controller snapshots cannot create a native view without a local
owner approval. No generic JavaScript, host shortcut or debugger API is exposed.
Older Desktop bridges remain compatible and do not advertise Explore.

Each Explore view has its own pending capture; a navigating or stalled page cannot
delay captures for other participants. Follow and Explore suppress byte-identical
JPEGs between two-second image heartbeats. Changed images enter the publisher's
latest-frame queue on the next capture. This reduces static-page
bandwidth without reducing the requested image resolution or raising the capture rate.
It does not remove the cost of capturing a static page.

Current clients negotiate `frameFlowVersion=1` when opening the socket. The relay
acknowledges each uploaded image, and viewers acknowledge after image decoding.
Each connection permits one unacknowledged image. The publisher retains only the
latest waiting image for each view, serving those views in turn; the relay retains
only the latest image while a viewer is busy. A slow connection therefore lowers
the update frequency instead of accumulating a replay of old frames. Input and
revocation messages do not wait for image acknowledgement. An acknowledgement
missing for five seconds ends the affected connection. Older clients/controllers
keep their existing protocol; both ends must support this negotiation for the
bounded image delivery behavior.

The first native implementation stalled while navigating hidden pages. Explore
now uses Electron's capture lease, drops up to three transient missing-surface
frames and bounds capture waits. The Desktop shell explicitly tracks Studio
windows so authentication callbacks, credential refresh, updates and activation
cannot select a hidden Explore renderer.

## Native video and receiver quality

Current Desktop and viewers negotiate `videoVersion=1` on the existing authorized
socket. Main captures the approved tab into an isolated, bundled Chromium worker;
JPEG encoding and WebSocket image delivery are bypassed once that exact viewer
has decoded video. Older peers and unsuccessful negotiations keep the JPEG path.
A source still supplies JPEGs while any of its viewers needs them. Failed video
connections fall back and retry with fresh signaling; changing Follow/Explore
closes the old peer and clears its pixels.

The default is up to **30 fps**, with a 4 Mbit/s sender ceiling and a detail content
hint. Unchanged pages can emit very few frames. Each viewer requests resolution
from its available area and DPR, capped by the actual capture and the pixel limit.
Changing receiver resolution does not change the Follow page's layout. Explore
continues to resize its independent page. Expansion/rotation reacquires capture
without replacing the peer; it releases the old capture first so Chromium cannot
retain the smaller source's pixel limit. H.264 is preferred with supported-codec
fallback. Hardware encoding depends on the platform and dimensions; inspect
`encoderImplementation` and `powerEfficientEncoder` instead of assuming it.

Native qualification can request 60 fps with an 8 Mbit/s ceiling. It is not the
shipping default: short local samples on an M1 Max reached approximately 27–30 fps
at 30 and 46–60 fps at 60, with higher CPU cost and inconsistent 60 fps latency.
These samples include source, encoder and receiver and do not establish phone,
WAN or large-group performance. Encoding scales with viewer count; capture is
shared between viewers of the same source. No SFU or simulcast service is added.

Signaling carries only a connection's own peer to that viewer. The controller
chooses its Follow/Explore source, enforces the existing audience and derives
short-lived TURN credentials using the existing `CONTROLLER_BROWSER_TURN_*`
configuration and `CONTROLLER_BROWSER_WEBRTC_PROJECT_IDS` allowlist. Configured,
allowed projects use relay-only ICE; configured but unlisted projects keep JPEG.
With no TURN configuration, direct connectivity is attempted and JPEG remains
the remote-connectivity fallback. Media does not traverse the controller socket;
input, approvals and revocation continue to use it. No data channel, audio,
camera/microphone permission or screen picker is introduced.

Main owns a four-second video lease renewed through the authorized publisher.
Stop, removal, source retirement and loss of authority destroy the corresponding
native peer. A lease can renew an existing peer but cannot recreate one. Pending
negotiations expire, repeated starts are bounded, and established streams retain
their transport while the share remains authorized. Reconnects mint fresh TURN
credentials. This uses the existing process-local sharing registry and does not
solve cross-controller routing.

## Viewing on a narrow screen

The viewer offers **Expand**, **Fit to view**, and local zoom at 100%, 150% and
200%. Expand opens a fullscreen dialog; Minimize or Escape returns to the
conversation without reconnecting. Zoomed views scroll locally to pan the
received image. While viewing, they do not send clicks or scrolling to the host.
While controlling, input goes to the shared page; **Pan view** temporarily switches
back to local inspection. Neither Follow nor canonical control changes the source viewport or requests
a different page layout. Approved Explore uses its own responsive page. New frames retain the viewer's pan.
Stop and removal clear both docked and fullscreen pixels.

Control groups wrap into the available width. On short viewports, such as a
landscape phone, explanatory text is hidden to leave more room for the page;
the status and action buttons remain visible.

The streamed image disables native image selection, callouts and dragging so
iOS image gestures do not cancel repeated shared-page swipes. Follow-mode zoom
and local panning remain available.

The expanded viewer follows the device's visible viewport when the software
keyboard opens. It reserves space for the remote input bar and temporarily hides
zoom controls and explanatory text, keeping navigation and release controls
available. An Explore page resizes with that available area; Follow continues to
fit the owner's original layout.

Fitting a desktop article into a phone-width view makes text very small. Zoom
makes details readable but requires sideways panning through desktop lines. This
is useful for watching/inspecting. Approved Explore provides the separate responsive
layout and independent page scrolling described above.

## Implementation and limits

- Electron captures only its current owner-bound Personal Browser WebContents.
  Capture is explicit and supports HTTP(S) pages. Each completion rechecks the
  exact owner, project, selected contents and capture generation. Stop, close,
  account re-attestation, release, or replacement invalidates pending captures.
- A separate controller registry owns the sharing session. Creation requires a
  human user session and space write access; joining requires current space read
  access plus inclusion in the session audience. Only the creator can publish,
  stop, inspect the viewer list or remove viewers. Private runtime authorization is
  unchanged. Scoped runtime/agent credentials cannot join these routes.
- Native video is preferred when both peers support it. The JPEG compatibility
  transport relays bounded images over authenticated WebSockets: at most five
  captures per second, 1600 × 1200 Follow pixels and one MiB per image. The relay
  retains only the latest image and closes stalled consumers. Both transports
  preserve the explicit control grants and bounded input lane described above.
- Session tokens are sent in the initial socket message, never the URL. Space
  access and token validity are rechecked every ten seconds, with a five-second
  authorization timeout. Explicit Stop and publisher disconnect retire the whole
  session and its viewer sockets. Explicit person removal signals their sockets
  directly and prevents fresh connections, without waiting for the membership
  polling interval. Only the owner receives audience names and connection status.
  Up to 32 people can be selected; a session retains at most 256 removals. Viewer
  capacity is eight concurrent connections; registry capacity is
  eight sessions per space, one per owner and 64 per controller process.
- A session lasts at most one hour and expires after twenty seconds without a
  publisher frame or video heartbeat. Closing or hiding the host browser ends the publisher. The
  computer must remain online. Reconnection requires a new explicit share.
- Registry state is process-local and ephemeral. A controller restart ends every
  share. A replicated deployment needs shared session routing/revocation before
  this can be treated as a generally available multi-controller feature.

## Next increments

1. Qualify native video on physical Android and iOS with an active network,
   including rotation, software keyboard, background/resume and revocation.
   USB forwarding without an active Android network is not a WebRTC sign-off.
2. Measure real LAN/WAN input-to-photon latency, text quality, CPU, battery and
   bandwidth under loss, network changes and multiple simultaneous participants.
   Tune 60 fps and codec selection from these results before exposing quality modes.
3. Add shared session routing/revocation for replicated controllers. Integrate
   browser sharing with generic human/agent handover, then add authorized capture
   and input adapters for supported desktop applications. Separate native-app
   layouts still require separate app views/sessions; video alone cannot supply them.

## Verification

Run the frontend unit tests and Desktop tests, then controller tests filtered to
`browser_shares`. The explicit native smoke test requires a graphical Electron
host:

```bash
pnpm --filter @instafy/frontend test:unit
pnpm --filter @instafy/desktop-app test
cargo test --manifest-path packages/runtime-controller/Cargo.toml browser_shares
pnpm --filter @instafy/desktop-app smoke:browser:explore
pnpm --filter @instafy/desktop-app smoke:browser:video
```

The Explore smoke uses disposable profiles and a loopback fixture. It covers
independent CSS and capture resolutions, shared cookies, native click navigation
during capture, Back, Reload, resizing and teardown. It does not qualify phone interaction or
end-to-end network latency. Those checks require an owner in Electron and a
separately authenticated participant on the actual device.

The video smoke uses the real native permission boundary, distinct receiver
resolutions, hardware statistics, navigation, rotation, expansion from an initially
small capture, revocation and native lease expiry. It must run explicitly on a
graphical host; a missing device or graphical environment is not a passing result.

For the iOS regression check, expand Explore and swipe repeatedly in both
directions, including after opening/closing the keyboard and rotating the phone.
The participant must keep scrolling while the owner's scroll stays fixed. Test
both software-keyboard taps and rapid printable key sequences with mixed case,
spaces and accented characters; the saved text must match exactly. Finally,
return to Follow, grant control, revoke it, and stop sharing to verify that input
and pixels disappear at their respective boundaries.
