# Sharing a local browser tab

Status: initial Electron implementation. Physical Android/iOS qualification,
constrained-network measurements and multi-controller routing remain open.

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
available backing surface; higher requests never upscale an image. JPEG images
are limited to one MiB, with at most five
captures per second per view. Private frames are delivered only to their assigned
connection. Controller snapshots cannot create a native view without a local
owner approval. No generic JavaScript, host shortcut or debugger API is exposed.
Older Desktop bridges remain compatible and do not advertise Explore.

Each Explore view has its own pending capture; a navigating or stalled page cannot
delay captures for other participants. Follow and Explore suppress byte-identical
JPEGs between two-second image heartbeats. Changed images are published on the next
capture, subject to the existing socket backpressure limit. This reduces static-page
bandwidth without reducing the requested image resolution or raising the capture rate.
It does not remove the cost of capturing a static page.

The first native implementation stalled while navigating hidden pages. Explore
now uses Electron's capture lease, drops up to three transient missing-surface
frames and bounds capture waits. The Desktop shell explicitly tracks Studio
windows so authentication callbacks, credential refresh, updates and activation
cannot select a hidden Explore renderer.

## Viewing on a narrow screen

The viewer offers **Expand**, **Fit to view**, and local zoom at 100%, 150% and
200%. Expand opens a fullscreen dialog; Minimize or Escape returns to the
conversation without reconnecting. Zoomed views scroll locally to pan the
received image. While viewing, they do not send clicks or scrolling to the host.
While controlling, input goes to the shared page; **Pan view** temporarily switches
back to local inspection. Neither Follow nor canonical control changes the source viewport or requests
a different page layout. Approved Explore uses its own responsive page. New frames retain the viewer's pan.
Stop and removal clear both docked and fullscreen pixels.

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
- The first transport relays bounded JPEG frames over authenticated WebSockets.
  The publisher requests at most five captures per second, capped at 1600 × 1200
  pixels and one MiB per image. The controller retains only the latest frame and
  closes slow consumers instead of accumulating frames. Versioned control messages
  carry the explicit request/grant and bounded tab-input lane described above.
  This is an initial transport, not WebRTC or a performance sign-off.
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
  publisher frame. Closing or hiding the host browser ends the publisher. The
  computer must remain online. Reconnection requires a new explicit share.
- Registry state is process-local and ephemeral. A controller restart ends every
  share. A replicated deployment needs shared session routing/revocation before
  this can be treated as a generally available multi-controller feature.

## Next increments

1. Qualify local-tab touch/keyboard/control on physical Android and iOS alongside
   Electron. The earlier server-browser phone results do not cover this path.
2. Measure native capture, end-to-end latency, quality, CPU and bandwidth on LAN
   and constrained networks. Evaluate event-driven capture and WebRTC/TURN against
   this baseline; qualify reconnect and multiple controller instances.
3. Integrate the browser sharing session with the same generic human/agent
   handover used by server browsers, then extend selected-surface sharing to
   supported desktop applications.

## Verification

Run the frontend unit tests and Desktop tests, then controller tests filtered to
`browser_shares`. The explicit native smoke test requires a graphical Electron
host:

```bash
pnpm --filter @instafy/frontend test:unit
pnpm --filter @instafy/desktop-app test
cargo test --manifest-path packages/runtime-controller/Cargo.toml browser_shares
pnpm --filter @instafy/desktop-app smoke:browser:explore
```

The native smoke uses disposable profiles and a loopback fixture. It covers
independent CSS and capture resolutions, shared cookies, native click navigation
during capture, Back, Reload, resizing and teardown. It does not qualify phone interaction or
end-to-end network latency. Those checks require an owner in Electron and a
separately authenticated participant on the actual device.
