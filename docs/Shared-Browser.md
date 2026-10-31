# Shared Browser

> **Status:** the implementation supports CDP screencast with HiDPI RFB fallback, plus an
> optional WebRTC transport. WebRTC and durable profile persistence are default-off and must be
> enabled deliberately by each deployment after connectivity and privacy validation.

Shared Browser is the project-scoped, web/mobile-compatible browser identity. Cookies, tabs, storage, and network location stay in the project runtime. The Electron app renders the same remote session and never imports it into the device-local Personal Browser profile. Profile separation is not an OS sandbox from other processes in that runtime; see [browser profiles and login continuity](Browser-Profiles.md).

## Runtime eligibility

Shared Browser is an Instafy Cloud collaboration surface, not a way to expose a contributor's self-hosted runtime. Studio accepts only the exact canonical managed `instafy-cloud` route. The controller independently enforces the same rule before origin view/control grants, browser-only job creation, durable browser-profile GET/PUT, profile reset, and privileged provider authentication. An ordinary or custom self-hosted runtime remains private to its immutable controller-attested owner even when its project is shared; a cloud-looking provider label or prefix cannot create managed-cloud authority. The Personal Browser runtime and stored profile remain private; owners can separately share an individual tab through [Local browser sharing](Local-Browser-Sharing.md).

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
valid exact-provider webdev launch attestation for that same generation, or
when a space's own machine hosts the browser on demand: it reports
`browserHost` `{ "version": 1, "modes": ["lazy"] }` and its active lease
carries the controller's browser-host attestation for that same generation
(see [Browser on the space's own machine](#browser-on-the-spaces-own-machine-controller-policy)).
This capability records trusted Shared Browser agent-lane provenance; it is not a
grant for any origin or action. The human confirmation policy below remains
the authorization boundary.

There is no Team runtime mode. Adding one later requires host-local consent, separate browser/workspace/shell/network/hardware grants, visible viewer/controller identity, expirations, an immediate kill switch, audit events, live socket revocation, and an OS sandbox. See [Self-Hosted-Runtime-Security.md](./Self-Hosted-Runtime-Security.md).

## Resume on another device

On wide screens, the Chat composer remains a workspace conversation while a browser
or file is open beside it. Showing a browser does not restrict ordinary file and coding
requests to browser tools. In a single Browser view, a browser task needs a live tab.
A browser that just started (or came back with its machine) shows only a blank tab; the task
is bound to that tab by its CDP target id, and the blank tab is never named in the message.
Until the browser has connected and has a tab, Send stays off and the composer's status says
why ("Instafy's browser is still connecting." or "Instafy's browser has no page open yet.");
a message sent with Enter is kept instead of submitting an invalid browser job.
Unsent text drafts survive same-tab reloads in session storage, scoped to the account and
space. They are not sent to other participants or restored on another device; attachments
and file contents are not included.

**Browser options** (the toolbar's three-dot button) opens sessions, a **Copy resume link**
action and browser-data controls. The raw resume link, runtime identity and login-recovery
status are under **Session details**; no extra session row is shown while browsing. The link contains
only the space and runtime UUIDs; it grants no access
and transfers no cookies, webpage URL, field values or browser-control token.
Open it while signed in on another device to request that exact live Shared
session. The new device is a separate participant and must acquire input control
through the existing collaboration controls.

In a space whose browser runs on its own machine, a press on a card opens the
conversation's own machine by name, as Studio opening a card by itself does,
so a press never asks which machine.
Without an exact resume target, one eligible live Shared session is reused;
multiple sessions require an explicit choice. A missing target and failed
discovery never silently allocate or select a different browser. When an open
needs that choice (several sessions and none named, or a named one that is
gone), **Browser options** opens by itself with the running sessions and
**Start new session**; otherwise only the three-dot button opens it. Reconnects stay
pinned to the resolved session, and **Start new session** is an explicit
Builder-or-higher action. Choosing or starting another session updates an incoming
resume link once that session resolves, so closing, reopening or reloading keeps
the new selection without replaying the original link. This resumes the runtime's currently focused live tab,
not a per-device tab selection or a saved browsing-history record. If a runtime
has ended, profile recovery and its limitations below still apply.
Local resume preferences are scoped to the signed-in account, space and conversation;
an account switch does not inherit another account's saved session choice.
Runtime-status reads use a single ten-second deadline across credentials, request
and response body, so a stalled read can settle and discovery or session refresh
can be retried. This is a read deadline, not a limit on runtime startup time.

## One browser shell, three pixel transports

The Studio always owns the address bar, history controls, status, errors, action ticker, and AI cursor. The runtime owns the page and profile. Enter in the address bar goes, as in every browser; only the phone's address editor keeps a Go button beside the field.

On a wide pane the toolbar reads Back, Forward, Reload, the address, **Send page to Octo**, the participants, **Browser options** and Expand. Where the browser runs (**This device** or **Workspace**, under **Run browser on**) is a setting, so it is in **Browser options** (the Personal Browser's **Browser settings**) at every width, not in the toolbar.

Who controls the browser shows only when someone else could: another participant (another person, or your own other device) is in the browser, someone else holds control, or Octo is driving it. Alone there is nothing to hand over, so neither the control chip nor **Release control** shows; **Take control** still shows when control is free, so a person left alone is never locked out. A pressed control action shows the shared pending spinner (`isPending`, so keyboard focus stays on it) until the browser answers, then shows the new state. When the browser does not answer within five seconds it says "The browser didn't answer. Try again." beside the action, and "Not connected to the browser. Try again in a moment." when the connection is down, instead of doing nothing.

Connection failures show one plain sentence and at most one button (see
[What the browser view shows](#what-the-browser-view-shows)). If the runtime provider is not
configured, the sentence explains that browsing needs setup. The original error stays out of the
way: it is in the card's `data-debug-reason` attribute, and under **Technical details** only while
runtime debug is on (`localStorage["instafy.runtime.debug"] = "1"`).

On narrow screens and split panes, the address bar keeps participant avatars on its
right. Open the avatars to see the participant list, where a cursor icon marks the
current controller. **Request control** appears below the list; this
asks the current driver to hand over input, rather than sending a chat message.
Pending requests show a badge for the current driver. A compact page-count picker
beside the address switches browser tabs; in a chat's Browser view it lists only
that chat's tabs (see One tab per chat). **Browser options** contains history
navigation, reload, **Expand browser** and where the browser runs, so the toolbar
stays on one row. AI
takeover is in the same participant controls; clicking the shared page can still
open the takeover confirmation. **Let Octo continue** sits in a row of its own
under the toolbar, which nothing folds away (see Manual input handoff).

### The agent's tabs

While the agent holds the browser (the origin publishes it as the control
owner), the tabs it holds carry its name: in the tab picker each option reads
"Octo · <title>" and the compact page count turns violet, and the
conversation's Browser view tab shows a violet dot that screen readers read as
"Octo is using the browser". The agent holds the tab its run is
bound to (`browserPageId`) and every tab the page list reports with
`openedBy: "agent"`; `openedBy` is optional, only `agent` and `person` are
kept, and an absent value is the person's tab. A compact **Octo is reading**
row under the toolbar lists those tabs as host and title text (page titles are
shown as text only, never followed; never a tab's number such as "Octo's tab 1",
the label Octo's own prompts use) with one **Take over** button. A tab still
loading another address is named by the site it opens, with no title until that
page arrives: DevTools' tab list gives the new address with the title of the page
the tab is leaving (a blank tab's "about:blank"), so `GET /browser/pages` drops a
title while the tab's history does not yet show the listed address, and reads each
title back from the list's HTML escapes ("Laptops & PCs", not "Laptops &amp; PCs"). A tab an
earlier run left open (`leftover: true`) is not one of them: it reads "Octo's
earlier tab" in the tab picker. Take over
is the same action as the toolbar's take-over, without a confirmation: it
cancels the run, and ending its runtime-wide agent marker returns every tab to
people. Taken on one of the agent's own tabs, it first keeps that tab (the
keep route below, waited on for at most 1.5 s), so the page the person took
stays open when the run's other tabs close. On a tab the agent opened itself,
take-over finds the runtime's one browser run; a person's own tab never falls
back to a runtime-wide run. Once control is gone, no tab carries the agent's
name.

Personal and Shared Browser use one `BrowserAddressField` and the common Instafy
`Input`, `Button`, `IconButton` and `Checkbox` primitives for their address, actions
and settings. Focusing the address, by keyboard or by the click that focuses it,
selects the whole address, so typing replaces it; a range dragged on that click is
kept, and later clicks place the caret. A blank tab (`about:blank` or a new-tab page)
shows an empty address with its placeholder. Navigation state, permissions and
control ownership stay in each browser controller; the shared components supply
consistent themes, keyboard focus and touch targets.
In compact Personal Browser panes, **Browser settings** keeps **Back** and
**Forward** available when they are hidden from the toolbar. Choosing a history
action closes the menu and restores the native page; control and history
availability checks are the same as on the wide toolbar.

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

Fallback stays on the same runtime and profile. A fatal WebRTC error moves to CDP; a fatal CDP error moves to RFB. The origin admits each viewer two pixel streams at a time (any transport) and counts a closed CDP stream until it has finished setting it up, so a CDP picture asked for within 2 s of the view closing its last one (it moved to another tab, or its address was renewed) can be refused for that alone: one that ends before the origin said anything is asked for once more 1 s later, and only a second such end counts as fatal. During reconnect the UI captures a bounded frozen frame, keeps the prior page visible, and shows an explicit **Reconnecting…** state once the picture has been gone for 1.5 s (`RECONNECTING_GRACE_MS`); a reconnect that is back sooner shows nothing, so the note never flickers with the live view. CDP is ready after its first painted JPEG. WebRTC controllers wait for both a decoded video frame and the separate input WebSocket; view-only participants are ready from video alone and never open the input socket. CDP has a bounded first-frame startup watchdog; WebRTC also monitors active, visible video for frame stalls.

## Multi-user presence and exclusive control

All project members may join the runtime-scoped collaboration channel. Presence
is additionally tagged with the active CDP page, so a named cursor is rendered
only over the page its owner is actually pointing at. Presence contains bounded
participant IDs, signed display labels, page IDs, normalized x/y coordinates,
and control requests only. Typed text, keys, clipboard contents, field values,
URLs, and page content are rejected by this strict collaboration protocol and
are never placed in Postgres. The separate ephemeral agent action log contains
bounded action labels, URLs, target labels, and key names for the visible cursor
and ticker, masked like the agent's observations, but never typed values,
clipboard contents, or full page content.

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
can reconnect without stealing control, also from another session of the same
person (their other window or device) that joins meanwhile. A Studio page that
unloads (a reload, or its tab closing) leaves as an unmount does: it sends
`leave` on `pagehide`, so control it held, or gets back once Octo is done, is
free at once, and the reloaded Studio, a new session of the same person, takes
it as it joins and can bring its chat's tab forward and type. The UI fails closed while its presence
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

RFB carries pixels and raw input on one stream, so its pass-through lane
(`/browser/vnc`) remains driver-exclusive: the origin rechecks the exact owner
before forwarding every client packet (with a one-second idle poll to close a
quiet revoked bridge). Everyone else watches RFB on its view-only lane,
`/browser/vnc/view` (`browser.view`, the same pixel-stream caps as the other
viewers, closed when the grant expires). That lane parses the client's half of
the protocol instead of passing it through: RFB 3.8 with no security, a shared
session whatever the client asked, and then only the messages that ask for
pixels (pixel format, encodings, update requests, continuous updates and
fences). Key and pointer events, clipboard text, desktop resizes and power
requests are dropped, and any message the lane does not know closes it. The
server's half is passed through, so the display sends no clipboard: RFB would
send every viewer the text copied or selected in the browser, and the runtime
starts Xtigervnc with `-SendCutText=0` (no Instafy viewer reads that text).
Capabilities advertise it as `rfb.viewOnly: true`. Studio uses it while Octo or
another person drives: noVNC connects with `viewOnly` and scales the picture
instead of resizing the shared screen, and moves to the driver's lane when
control comes back. Like the driver's lane, it is open only while the Browser
view is shown. Octo brings the tab it works in to the front, so the view
follows Octo across its own tabs. WebRTC or CDP, when the runtime offers them,
still come first for a viewer.

On a runtime without the view-only lane, a person who may control the browser
while Octo drives keeps a still of the page Octo is on, and who has control
with one **Take over** (the reading row's, when it shows). The still is kept
only for the chat, page and address it was taken on: once any of them changes
the stage says in one line where Octo is ("Octo is on example.com") instead of
showing another page. A viewer that stays connected while its tab moves to
another address (a screencast) can still be captured for the new address.
When nobody holds control the view says to request it. The caption of Octo's
latest step shows only while Octo holds the browser, and only for steps of that
hold: steps already in the log when the hold began, or when the view first read
the log during the hold, are never captioned.

The collaboration roster belongs to the browser, not to a tab: its socket stays
connected while Studio's tab list is empty or reloading, and the participant's
page follows by heartbeat.

Agent control uses the same runtime-wide authority. A Shared Browser job writes
a strict, mode-0600 heartbeat marker under the protected runtime directory
`/run/instafy/browser` before prompt/context preparation and refreshes it for
the turn. The origin publishes the agent as the control owner, rejects every
human mutation, preserves the previous live human driver, and restores that
driver only when the job guard explicitly removes the marker after Codex and
its tool tasks have fully shut down. Codex reports `ShutdownComplete` after it
has aborted the turn and signalled its MCP servers, but it does not wait for
those processes to exit. Runtime-agent therefore gives each run a
process-group registry: the Shared Browser MCP refuses to serve unless it leads
its own process group and has recorded that group with an exclusive create.
After `ShutdownComplete` the runtime seals the registry (so a late MCP cannot
register or serve), sends SIGKILL to every recorded group (active or retired,
including the `node` controller, which shares its MCP's group), reaps its own
exited children, and polls until each group is gone. It never kills its own
group, and a group that is still present about two seconds later (EPERM counts
as present) fails the confirmation. A
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

The composer blocks the send until that runtime is resolved and a page is
selected. Before any job is written, the controller requires the explicit
`runtimeId` and one `browserPageId` in the runtime's CDP target id shape (1 to
256 bytes of letters, digits, `-` and `_`). A request without one is refused
with `400` and code `shared_browser_page_required` instead of becoming a run
that fails on the runtime. An older Studio tab, or a send-queue entry it
created, can omit the page id, and a page the composer inferred from chat
history before the live pages loaded carries its URL as the id. The refusal
asks the person to refresh Studio and write the message again, because "Send
now" on a failed queue entry resends the same stored request. The controller
also rejects conflicting
transport/runtime/page aliases, and canonicalizes the request to one agent, exact
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

How a run's approvals start depends on the runtime, never on the job, the
caller or the model:

- **On the space's own machine** (a lazy browser host the controller attests
  for a covered space, see "Browser on the space's own machine" below), every
  run starts in **routine browsing**. runtime-agent writes that into the run's protected
  approval state before any Codex or MCP process starts, bound to the run's
  owner, run, initiating user and page, and the job fails if the write fails.
  Octo opens, reads and navigates sites without a site prompt; the steps listed
  under routine browsing below still ask.
- **Everywhere else** (the boot-time browser session and self-hosted
  runtimes), a run starts in **Ask** with the per-run site approval described
  next.

In Ask, Shared Browser defaults to confirmation, rather than a site denylist,
as its sensitive-site policy. Before the agent can observe a page, the user who
started the run must approve that exact normalized origin for the current run.
Cross-origin navigation or controls require a separate origin approval before
the destination can be read. Origin approval does not authorize an action,
with one exception: opening a plain address on that site in the same tab.

A site prompt raised by a step that loads a page (`navigate`, `open_tab`, or a
link, form or key that leads to another site) names the exact address the step
will load, host and path, masked like a snapshot's address and cut with "…"
when long, and is bound to that address. Studio shows that page instead of
only the site. A site already approved in that tab opens its pages without
another prompt, and the prompt that approves it also covers the navigation it
was raised for: a plain navigation asks at most once. A risky address
(sign-out, unsubscribe, exports and files, one-time links, action addresses)
still asks for the step itself, in every mode.

In the default **Ask** mode, every other navigation, click, type, form submission, and key press receives a
separate one-shot action prompt bound to the run, runtime generation, page,
fresh snapshot/target where applicable, destination, and payload fingerprint.
The default-focused action is **Deny**. Only the initiating user with live
`browser.control` authority can decide; another teammate, another page, an
expired request, or a replay cannot satisfy it. Scroll is allowed only after
the page origin has been approved because it changes no remote state. Typing
authentication, payment, or identity secrets remains blocked outright and is
not made possible by approval.

Two steps never ask, in Ask too:

- **A pressed card's site.** A browser card names the site its task opens ("For
  www.example.com"), and the person's press on it is their OK for that site.
  Studio names the sites of every card the person pressed in the chat
  (`browserCardSites` in the turn's metadata: plain host names, at most eight,
  never a card Studio opened by itself, and never a teammate's press in a
  shared chat, which is that teammate's OK), and the runtime starts each later
  Shared Browser run of that chat with those sites' `https` origins approved on
  the person's page, as an answered site prompt leaves them. The controller
  keeps the key only on the person's own signed-in message (never a service,
  runtime or agent token), and the runtime takes only plain public host names
  (no address, IP literal, port or local name). It approves the site only:
  every step on it still asks as before, Octo's own tabs approve sites for
  themselves, and link-only sites, private addresses and risky addresses are
  refused or ask exactly as before.
- **A cookie banner's refusal.** A click on a button with a refusal's words
  ("Reject all", "Only necessary", "Alle ablehnen", "Rejeitar todos", …) inside
  a cookie or consent banner (the page describer's `consentContext`: a
  container named for it, a dialog titled for it, or a small container close
  by that speaks of cookies) shares nothing, so it runs without a prompt. It
  must not be a link or send a form, and its step lets no form post leave the
  tab, not even to the page's own site. The same words outside a banner (a
  document editor's "Reject all") still ask.
- **A cookie banner's accept is refused.** In the same banner, a control or a
  link whose words accept, agree or consent ("Accept all", "I agree", "Agree
  and close", "Consent", "Alle akzeptieren", "Einwilligen", "aceitar e
  continuar", "Toestemming geven", …, in the refusal's languages), or that
  only allows ("Allow", "Allow all cookies", "Autoriser", "Alle Cookies
  zulassen"), is refused in every mode before any prompt
  (`step_refused_consent`): accepting is the person's step, and Octo reads on
  under the banner. A link is refused too, which plain-link navigation would
  otherwise take. Only these words count: a banner's "Disagree" toggles, its
  cookie policy link, its settings ("Manage consent", a "Consent" tab) stay
  ordinary steps, and an accept word with "not", "no" or "without" up to two
  words before it ("Continuer sans accepter", "No estoy de acuerdo") is a
  refusal. An accept limited to the necessary cookies or to a selection
  ("Accept only necessary", "Nur essenzielle Cookies akzeptieren", "Accept
  selection", "Save and accept") is how a refusal made in the banner's
  settings is saved, so it is not refused: it asks once in every mode, a link
  too, because pre-ticked purposes could ride along.

The browser view's prompt asks in the chat row's words: "Octo wants to use
example.com." with **Deny** and **Allow site** (or "Octo wants to click “Search”
on example.com." with **Allow**), which name the exact site or page it is
about. A control whose name says more than the text it shows is named by that
text first ("Agree and close" (also called "Agree and close: Agree to our data
processing and close")), each name cut on its own. A step that sends a form
lists the fields it sends, by the names the page gives them and never their
values ("Sends: Customer name, Telephone, E-mail address"). Under the sentence,
"Goes to httpbin.org" names where a step on the page goes when the sentence
does not: a step that leaves the site, or one that sends fields. A step that
stays on the site and sends nothing (Space on a toggle, a click on a box in a
form) says nothing of where it goes. It offers no routine-browsing choice: a
run on the space's own machine starts in routine browsing, which is what
users' spaces get.

Routine browsing is a grant across HTTP(S) sites for the exact current run,
initiating user, runtime generation and selected page—not permanent site
trust, a project-wide default, or permission inherited by the next turn (only a
run that continues it with **Let Octo continue** keeps it, see "Manual input
handoff"). A run on the space's own machine starts with it; the runtime still
honours a decision of `allow_routine` on a site prompt from an older client. Under routine browsing,
ordinary navigation, clicks, non-sensitive field filling, choosing an option in
a list and non-activation keys proceed without another site/action prompt,
including an address typed for a site the run has not used yet. Steps in a named risk category (below), risky
addresses, form submissions, buttons whose label commits a change (such as
Save, Speichern or Buchen, even when page script runs them without a form), and
Enter/Space activation still require one-shot confirmation. The one form
submission that does not is a **site search**: Enter in the page's own search
box, or typing into it with submit, when all of these hold
(`isFreeSiteSearch` in `@instafy/browser-action-policy`):

- the classifier allows the submit as a same-site GET search (a search field by
  structure, no risk word in the form's labels, not a sign-in form);
- the browser's own submission (formSubmission.js) is known: Enter submits the
  form implicitly and is not blocked, it is a GET in the same tab, not a dialog,
  not a field inside a submit button, and not a search box without a form
  (which page script handles, so it still asks);
- its address has the page's own origin (scheme, host and port: another
  subdomain asks), is public (no loopback, private or local address), and it
  is not on the link-only list (refused before any prompt, as always);
- the address it sends is not a risky address (sign-out, export or file
  format, a one-time link, an action address). That is the action with the
  form's entries as its query, as the browser builds it, so a hidden
  `format=csv` makes the search an export that asks, as a navigation to the
  same address would;
- nothing it sends looks like a key: the field is not a password, code or
  payment field (refused anyway), and the redaction rules mask none of the
  entries it sends, alone or as `name=value` (so a hidden `code=482910`
  asks): the field with the typed text and the form's other controls, hidden
  fields and the default button included. They are read from the controls
  and through the form's own list of them, which a control named `elements`
  cannot hide, never with `new FormData()`, which would run the page's
  handlers; they are tested and kept nowhere. A form with a file chooser, a
  form-associated custom element or more than 64 entries asks, and so does a
  field with no name, which sends nothing typed and is the page script's box;
- the run is under routine browsing, which covers the run's page and Octo's
  own tabs alike. In Ask mode it asks like every other step.

While a site search runs, the step's guard lets no form post leave the tab, to
the page's own site included: a page script that turns the search into a post
is stopped before it leaves the browser, and the step fails saying so. The
step's result says `"approval": "free"` in its `activity` (below). A GET
search sends nothing a plain navigation to the same address could not, apart
from the form's hidden values, which go back to the origin that wrote them; a
site whose GET search has a side effect is the same accepted trade-off as a
plain link under routine browsing (below). Menu items, tabs,
tree items, disclosure and menu openers and navigation items are navigation, and
lists (a select, combobox or listbox) and their options hold values: a
commit word in their label (such as Neue Rechnung, Start or Neu) does not make
them ask. A control of any kind whose label records, rebooks, files, issues,
finalizes or pays (Festschreiben, Buchen, Umbuchen, Ausbuchen, Abbuchen,
Stornobuchen, An FinanzOnline übermitteln, Einreichen, Abgeben, Rechnung
ausstellen, Speichern, Als bezahlt markieren, Mark as paid, Delete) is
consequential and still asks; a menu item that only names a list (Buchungen,
Stornobuchung, Zahlungen) stays navigation. Buttons whose label fills in,
reconciles, closes or voids a record (Beleg erfassen, Abgleichen, Erledigt,
Fakturieren, Verrechnen, Stornobuchung, Reconcile, Void, Write off, Issue
refund, File tax return) also ask as commit buttons; "Issue" and "File" count
only with such an object, so a "File" menu or "Choose file" does not. Secret entry,
fresh-target checks, exact authority, denial and cancellation boundaries are
unchanged. Stopping or completing the turn ends the grant.

Button descriptors retain the browser's normalized type. An ordinary
non-submitting button inside a form can therefore use the routine grant, while
submission controls still ask. Consequential-action checks remain in force for
both kinds of controls. They read a control's own names (label, accessible
name, visible text, title, value, id, name, address, tooltip and image text),
never its structure: a `<button>` without a `type` attribute reports the type
`submit` even outside a form, and a control in a POST form reports the method
`post`, so neither alone makes a step ask.

A control that only opens or closes part of the page is a disclosure toggle
and free like a menu opener: it has `aria-expanded`, `aria-haspopup`,
`aria-controls` naming an element on the page or a Bootstrap-style
`data-bs-toggle` (or `data-toggle`) of `collapse`, `dropdown`, `offcanvas` or
`sidebar`; or its whole name is a toggle name such as "Menü ein-/ausklappen",
"Seitenleiste ein-/ausblenden", "Toggle menu", "Menu" or "Expand/collapse"; or
it has no name and a hamburger, caret or kebab icon. A risk or commit word in
its name, a risky icon, a reveal word, a dialog or a form submit still decides.
An icon-only control whose icon is a trash can, a paper plane, a cart or card,
a share or add-user, a download or a sign-out asks in that category, and one
whose icon is a floppy disk, pencil or plus asks as a commit button.

A control is named by its accessible name or the text it draws. The text it
draws leaves out what never draws: scripts and styles, parts the page's CSS
hides (`display: none`, as the `hidden` attribute does unless the page's own
style shows it), and an svg's metadata, title, description and definitions
(an Inkscape icon's `<dc:format>image/svg+xml</dc:format>` once named a search
button "image/svg+xml"); the HTML in an svg's `<foreignObject>` is drawn. Risk
words still read every text inside the control. An image button is named by
its alt text and an input button by its value, and text that names nothing,
such as a bare media type in lower case as software writes it ("image/png",
never "Audio/Video"), is never a name or a tab title (`isPlaceholderName`). The page describer reads all of this with the
shared in-page rules (`controlNameRulesInPage` in
`@instafy/browser-action-policy`), which the Desktop Personal Browser runs too.

A list (a select, a combobox or a listbox) is named by its own label ("Start"),
or by the option it shows when it has none, never by its options run together:
the shared rules read what a select draws as the option it holds, and a label
that holds the list is read without the list's options. Octo sets a select
with `choose` and an option's label as the open list shows it (case, accents
and spacing aside), never by clicking it; a list that holds several options at
once is left to the person. An option the list does not have, or one the page
turned off, chooses nothing, and the answer lists the options, except on a
page that may show a secret. The option is chosen by its label and its place
together, so a list that moves its options meanwhile chooses nothing. A choice
is judged like a click on a radio button named by the list's own label and that
option (`classifyStep("choose", target, { option })`): signing in with another
account ("Sign in with GitHub") is refused, as a click on those words is, their
risk words ask in their category ("Delete selected" in "Bulk actions"), in a
credential context it may show a secret, an option that accepts in a cookie
banner is refused, and a list whose own names, or whose form, name
authentication, payment or identity details is refused, as typing there is.
The list's other options never count. Nothing else asks under routine
browsing: choosing does not send the form, and the form's own button sends it
and asks. While the option changes, the page may post a form to its own site,
as it may while text is typed (an older site that reloads a list when it
changes), whether routine browsing took the choice or the person allowed it;
a post anywhere else is stopped, as is any post from one of Octo's own tabs,
which are for reading. The prompt names the option and the list by its own
label: "Octo wants to choose “São Bento” in “Start” on transit.example.", or
the option alone for a list with none. The Desktop Personal Browser's tools are
its own list, which has no `choose`.

A control with no accessible name or visible text is named from its own
hints rather than its index: a tooltip attribute or described-by text, its
image's alt text, svg title or an inner element's label or title, a generic
noun for its icon (its classes or its svg sprite's symbol), the short text
right beside it ("button next to “Idioma”", at most 40 characters and never
another control's), read only when it has no name of its own, and where it
sits, for example "profile picture button in the top right". The text beside
it names only what it sits next to, never the control itself. An inner
element's label and the text beside it never set the step's category; like
any name, their words can only make a routine step ask (the consequential
floor), never let one go. The name is masked like any other control name
before it reaches a snapshot, a prompt or the action log.

Every step's result carries `activity: {step, url, approval}` for the turn's plain-language
activity line ([Chat activity line](Chat-Activity.md#browser-steps)): the step's kind
(`navigate`, `open_tab`, `snapshot`, `search`, `submit` for typing that sends a form that is not
a search, `click`, `type`, `choose`, `press`, `scroll`, `tabs` or `status`), the masked address of the page
the step left the tab on, only on a site the run may read, and how it was allowed: `once` when
the step waited on a prompt (its site's or its own) and the person allowed it, `routine` when
routine browsing took an acting step without one, `free` for a site search, and nothing when the
step needed no answer. It comes from the browser's own state, never from page text, and
runtime-agent keeps only the step, the host, a key of the address and the approval. In the chat,
a prompt shows as one row inside Octo's turn, to the person who started the run, and once
answered the turn's line says so ("you allowed a search");
see [Browser prompts](Chat-Activity.md#browser-prompts).

Routine mode deliberately relaxes universal confirmation. Its consequence
classifier uses page descriptors and URL text; it cannot prove that arbitrary
website JavaScript has no side effects or recognize every language/custom control.
A plain link whose address has side effects but is not on the risky-address list,
a control with neither a risky nor a commit word in its label, or a menu item,
tab or navigation item whose only risky word is a commit word outside the
consequential list (such as "Neu", "Weiter", "Erfassen" or "Abgleichen" in a
menu), can still act without a prompt. **Ask** reviews every click, typing,
form submission and key press. Its one relaxation is the plain address: on a
site already approved in that tab, an address that is not on the risky-address
list opens without a prompt, so such an address with side effects can act
without one, as under routine browsing. A run on the space's own machine cannot
be switched to Ask yet (see "Remaining work").

### One tab per chat

The Shared Browser is shared by the space's chats, so Studio gives each chat a
tab of its own, and a chat's browser turns run there, never on a page another
chat left on screen (under routine browsing nothing asks before a page is
read, so that page would go into this chat's reply and Details):

- **Later turns** run in the tab the chat's last browser turn ran in (its
  `browserPageId`), while that tab is open. A tab the person chose in this chat
  since (the browser's own tab list, or an address typed in its bar) takes its
  place: that page is theirs to choose. A tab another chat took since (a turn
  of another chat ran in it later, or the person chose it in another chat
  later) is that chat's now, and this chat's next turn gets a tab of its own.
  Turns from before one tab per chat ran in whatever tab was on screen, so
  several chats' turns may name one tab: it is the chat's whose turn ran there
  last.
- **A chat's first browser turn** gets a blank tab: one that no chat's turn was
  sent for (the one tab of a browser that just started), or a new one Studio
  opens with `POST /browser/pages/new` (`browser.control`). That opens
  `about:blank` behind the tab on screen, so whoever watches or drives keeps
  their page. The browser refuses it while Octo works in it for another task
  (a page that appears during one of Octo's steps is closed as a window the
  step opened, and fails the step), when Studio says the browser is busy and
  sends nothing. Once it has 24 tabs, the tab used least recently makes room:
  it closes once the new one is open (never the tab on screen, the one used
  last, or one of Octo's). Nobody closes a tab by hand, and the browser
  brings its tabs back when it starts again under new ids no chat knows, so
  tabs would otherwise pile up. A chat whose tab closed gets a new one. The
  browser advertises it as `controls.newPage` in
  `GET /browser/capabilities`. The turn
  then starts on a blank page, and its blank-page rule takes it to the task's
  address or the official site of what the task is about.
- **The chat's Browser view shows that tab, and only that tab.** When the view
  comes on screen for a chat, and when the chat gets a new tab, Studio brings
  the chat's tab to the front, once this person holds the browser's control
  (only the driver may bring a tab forward; until then the view waits). The stage draws a picture, and the address bar
  shows an address, only while a tab of the chat is in front: its own tab, or
  Octo's tabs of the chat's turn while the browser lists them as Octo's
  (during the turn, and after it until the tab list names the one Octo read in
  last as the chat's page, which the view then does not move away from). A tab
  of Octo's the list named before the chat's turn started is an earlier turn's,
  never this one's. With RFB or WebRTC, which send the browser's whole
  screen, whatever tab is in front, the stage draws no picture while someone
  else in control (another person, or the person's other window) shows a tab
  that is none of the chat's. Any
  other tab in front, or none the browser names in front (never its first tab
  in its place), leaves the stage blank, with no address, and the person's
  input does not reach the page. While a browser turn of another chat holds
  the browser, the view shows none of it, only "Octo is working in another
  chat": in a team space that page may be another person's, signed in. While
  the stage is blank, for either reason, the view asks for no picture at all:
  its viewer (screencast, WebRTC or RFB) is not connected, so no frame of
  another chat's page reaches the person's device, not even under the blank
  stage, and no still is kept from it. The view counts as open meanwhile,
  also when it opens during such a turn, and its picture connects again once
  a tab of the chat is in front (a view that has drawn no picture yet says
  "Opening Instafy's browser…" while it loads, never "Reconnecting…").
  Behind the Chat tab, a screencast view whose chat's tab is in front keeps
  its picture (it asks for that one page), so it shows the page at once when
  it comes on screen. RFB and WebRTC connect only while the view is shown:
  behind Chat nobody sees which tab is in front, so a still of the chat's
  page stands in until their picture is back. The address bar's tab list
  names only the chat's tabs, never another chat's page by its title, and
  with one tab there is no list. Once
  that turn or another person is done and no browser turn is under way, the
  chat's tab comes forward again; the chat's own turn leaves the browser where
  it ends (its page, or a tab the person took over, which is the chat's tab
  from then on when it is one the view shows: Take over pressed over the blank
  stage, while another chat's page is still in front as the turn starts, leaves
  the chat its own tab). A chat with no tab yet gets its own blank one (as for its
  first browser turn), once while the view is on screen, and again once a tab
  it had is gone (the browser started again, or Clear data); a chat with
  nothing sent yet too, and that tab stays its tab once its first message
  gives it an id. While a turn of the
  chat is on its way and its page is blank or not in front yet, the stage says
  "Octo is starting…" (or where Octo is going). On "Reconnecting…" the stage
  keeps only a still of the chat's page in front, never the last picture the
  view drew, which may be of another tab. It never undoes the person's own
  pick.
- **The page a browser turn leaves the chat.** A turn works on the chat's tab
  (see Octo's own tabs). When it ends with Octo reading last in a tab of its
  own that shows a page, or with the chat's tab still blank, the tab Octo
  worked in last stays open (see Closed at the end, unless kept), and `GET /browser/pages` names
  that turn on it (`leftByRun: <run id>`, from runtime-agent's
  `chat-tabs.json`). Once the turn has ended, that tab is the chat's tab: the
  page the person is left with is the one Octo read last, after a reload, on
  another device and for other members too.
- A follow-up stays in the tab of the turn it continues (the tab that turn
  left the chat, when it left one), while no other chat took that tab since
  the turn started; otherwise the message is an ordinary
  chat turn. Let Octo continue stays in the tab the person worked in when the
  chat's view shows it, else in the chat's own tab; never another chat's page
  in front, nor the browser's first tab when it names none in front, and with
  no tab of the chat's it sends nothing. A message aimed at a page goes out in the
  person's own words: the page reaches the turn only as its bound tab, never as
  a sentence naming it, and a card's continuation sends the card's task alone.

An older browser that cannot open a tab (its capabilities say so) keeps the
earlier behaviour: the turn is bound to the tab on screen. Until the browser has
said whether it can, Studio asks it to open one, and when it does not, nothing
is sent. For an older browser runtime-agent remembers, per page,
which conversation's run held it last (in memory, the newest 32 pages). When a
run starts on a page a run of another conversation held last, the turn gets a
note for that turn only, next to its browser policy: the page was left by a
task in another chat, it is not this task's earlier work, so Octo does not
describe it as resuming there. When the person's message is about that page,
Octo uses it as it is; otherwise it starts this task's own step (`navigate`
that page, or a tab of its own). The chat's next turn without such a page
withdraws the note. The first run on a page, a later run of the same chat, and
a runtime that restarted get none.

### How Octo finds a page

Every Personal or Shared Browser turn carries the `instafy-browser-automation`
skill, whatever its words: the router loads a skill by the words of a request,
and a browser turn's often has none of the skill's ("Now find how to get there
by tram", or a task that names an address). On a fresh thread the skill loads
first of the turn's skills, so the snapshot's budget never runs out before it.
Most browser turns resume their chat's browser thread instead, which loads no
snapshot, and a browser turn cannot read a skill file, so such a turn is given
the skill's "Finding a page" section again, from the space's own copy. A chat's
browser thread holds only its browser turns: each starts from what it is asked
(the person's words or a card's task), and a new or lost browser thread is
given the chat's earlier browser turns, never Octo's building turns, files or
command output. Codex withdraws the space's `AGENTS.md` from a
turn without the workspace, so it is given that file's "Replies" too (how a reply
reads: plain words, no error codes, file paths or inside words, "not checked" on
a fact no page read this turn states, and only steps the turn started). The
"Finding a page" section, which the
`instafy-web-research` skill points to (a research turn without the browser
skill prints just that section with one command), says how every reader finds a
page: an address the person, a skill or a search result gave, a link on a page
read, or the official site's home page, never a search engine or a guessed
path; a missing page's own site search; a page that fails (busy, blank or an
error page such as a 504) sends the turn to the place's own site at once, in the
same turn, and then to another official source; facts from a place's
own page, not a listing or a kiosk page; "not checked" on anything not read this
turn; and a cookie banner's refusal, so the banner does not cover the page. A
sign-in, a bot check, a paywall or a refused read ends that page, never the task:
nothing a turn carries tells it to stop there, so neither a card's task nor the
reply rules end the research after a failed page. The research and comparison evals
(`packages/instafy-bind/tests/web-research-eval.test.mjs`,
`packages/instafy-cli/test/web-compare-eval.spec.ts`) grade these rules on
fixture sites.

A page that is not blank but reads with no text and no controls has not drawn
yet (it is still loading, or hidden while it loads). A snapshot of it, and the
read that follows a step, answers as a page too busy to be read does: its
masked address alone, no title, and "The page is still busy, so it could not be
read yet. Take a snapshot in a moment." It is never handed back as an empty
page, which a turn would report as "no readable content", and its line reads
like `status`, not as a page read.

### Octo's own tabs

Octo works on the page the person chose for the run, the chat's own tab, so the
page the person is left with is one it read (`navigate`; the browser policy and
the `instafy-browser-automation` skill say so). Only to keep a second page open
at the same time does it open a tab of its own, up to three, in the same
browser. The
Shared Browser MCP server has `list_tabs`, `open_tab {url}`, `select_tab {tabId}`
and `close_tab {tabId}`; `snapshot` and `navigate` also take a `tabId`, and every
other tool acts on the tab `open_tab` or `select_tab` last chose. The Personal
Browser has tabs of its own (see Personal-Browser.md).

- **Visible, badged and shared.** A tab opens blank in the run's own browser
  context, is recorded in the run's `tabs.json` before anything loads, and is
  brought to the front whenever Octo works in it. `GET /browser/pages` marks
  it `openedBy: "agent"` with its `agentTabNumber` (and `kept: true` once a
  person keeps it), for every viewer and every conversation on the machine.
  The action feed attributes each step to the tab it ran in.
- **One label per tab.** A run numbers its tabs 1, 2, 3, … as it opens them,
  never gives a number twice, and a tab keeps its number while it is open.
  Prompts ("Octo's tab 2: …"), `list_tabs` (`label`, `number`), tool results
  (`tabLabel`) and Studio's tab list ("Octo's tab 2: <title>") all use that
  label.
- **Only its own tabs.** Octo can use the page the person chose and the tabs it
  opened in this run, never another tab a person or a page opened, and it can
  close only its own tabs.
- **Approvals bind to the tab.** A site approved in one of Octo's tabs is
  approved in that tab only (the run's page and the other tabs ask again), and
  prompts name the tab by its label. `open_tab` asks once, for the site in the
  new tab, with the address it opens; the site's approval in that tab covers
  opening it and later plain navigations on that site there. Step approvals carry the tab in
  their payload fingerprint, and snapshot ids and targets are bound to the
  tab, so a snapshot of one tab is never a target in another. Routine browsing,
  where the run has it, covers the run's tabs alike.
- **Reading only.** Octo's tabs take only the steps routine browsing takes
  without asking: reading, plain links, menus, ordinary clicks, typing that
  does not submit, non-activation keys and, under routine browsing, a site
  search of the page's own origin. Any other form submission, a commit button,
  a named risky step (purchase, message, download, sign-out and the others), an
  activation key, a risky address, a step that may show a secret and a manual
  field handoff are refused there in every mode, before any prompt.
- **Never a link-only site, in any tab.** A `no-agents` site on the
  web-research skill's link-only list (its terms bar AI agents or automated
  access; a site with no kind, or an unknown one, counts; runtime-agent embeds
  the skill's `link-only-sites.json` into
  the controller, with `@instafy/browser-action-policy`'s `linkOnly.js`, the
  matcher `instafy web read` and the Personal Browser use too), or a
  translator's, cache's or archive's copy of one (the list's `wrappers`, such as
  `www-example-com.translate.goog` or `web.archive.org/web/…/<address>`), is
  never opened or read by Octo, in its own tabs and on the
  page the person chose alike. Sites and wrappers the space's own copy of the
  list adds (`.agents/skills/instafy-web-research/references/link-only-sites.json`,
  passed to the controller as `INSTAFY_SHARED_BROWSER_SPACE_LINK_ONLY_FILE`)
  count too; that copy can only add or make a site stricter (the strictest
  kind of every entry that matches wins), and a copy that is not a plain JSON
  file of the list is left out (`status` reports it in `linkOnlyListWarnings`)
  while the bundled list still applies. A `no-reuse` site (its terms bar
  copying its content, not reading it) is not refused; the web-research skill
  says how its content may be used. `open_tab`, `navigate` and a link, form or
  activation key that leads there are refused before any prompt, and a
  redirect one of Octo's steps causes is stopped by the step's request guard
  before the request leaves the browser. A copy nested in another wrapper (a
  translator's copy of an archive's copy) counts, and so does an answer that
  says it is a copy of a link-only site (an archive's Memento
  `Link: <…>; rel="original"`, which names the page even at a short address
  such as `archive.ph/AbCdE`): the guard stops it when the answer arrives,
  before the page renders. The guard watches the tab's own
  document: a frame an ordinary page embeds from a link-only site (a map, a
  sign-in button, a captcha) loads as the page asks, since Octo neither reads
  nor drives frames, and does not fail the step. A page that is on a
  link-only site, because the person went there or the page moved there by
  itself, is neither read nor used: every step there is refused before any
  prompt, and the refusal tells Octo to ask the person to use **Send page to
  Octo** or to do it themselves. A snapshot checks the page again once it has
  read it, so a page that moved on to a link-only site, or to any other site,
  while it was read (a timed redirect, or a load the guard does not see, such
  as a back/forward cache restore) reports nothing, and the action feed names
  only the site of a link-only page. Octo can only take the tab elsewhere, or
  close one of its own. Without the list, Octo opens, reads and does nothing
  in any tab. The person's own browsing is unchanged.
- **No other windows.** A form step whose submission opens another window is
  refused before any prompt. A step of Octo's, in any tab, that opens another window
  (a `target="_blank"` link, a script) has that window's requests stopped
  before they leave the browser, the window closed, and the step reported as
  refused. A window a page in one of Octo's tabs opens by itself between steps
  (a timer, or a script still holding the activation of Octo's last click) is
  closed too: runtime-agent closes it, and any window it opens in turn, as
  soon as the browser reports it while the run holds the browser, and each
  controller command closes any that is left before it runs. Windows the
  person's own pages open are left alone. Octo opens tabs only with
  `open_tab`, so every tab it uses is counted, badged and closed at the end.
- **Octo's tab or the run's page in front.** When Octo closes one of its tabs,
  a window, or a new tab the person denied, the tab it now acts on (else the
  run's page, else another of its tabs) comes to the front instead of whatever
  neighbour Chromium shows, which may be a person's tab. While Octo holds the
  browser, Studio offers **Take over** in the Reading row and the toolbar
  whichever tab is on screen. Stopping a run needs its job, so Take over is
  offered for a run of the conversation on screen; a run another conversation
  started is stopped from that conversation, and its tabs are badged
  everywhere.
- **Control.** Agent control stays runtime-wide: while a run holds the marker
  the origin refuses human input on every tab, and Pause, Escape or taking over
  ends the run and with it every tab's agent control. A tab the person closes
  leaves the run; the next step in it reports that and does nothing.
- **Closed at the end, unless kept.** When the run's tool processes are
  confirmed gone, runtime-agent closes Octo's tabs through the loopback
  DevTools endpoint (`GET /json/close/<id>`), apart from the ones kept through
  `POST /browser/pages/:id/keep` (`browser.control`, recorded in the run's
  `kept-tabs.json`). Studio keeps the tab on screen when the person takes over
  on one of Octo's tabs; it shows no separate **Keep tab** button, which was
  unexplained to a first-time user, since the person now watches Octo's tab
  live while Octo works in it. When the person kept none, the tab Octo worked
  in last is kept the same way, as the chat's page, with no reload: it stays
  as Octo left it, a refused cookie banner included. That is the tab Octo acts
  on at the end (`currentTabId`) when it is one of Octo's own and shows a page
  (`GET /json/list` says an `http(s)` address): Octo read there after the
  run's page (the chat's own tab), whatever that page shows. A tab whose page
  never loaded (blank, or the browser's error page) is not kept that way. When
  Octo ended on the run's page, or in such a tab, one of Octo's tabs is kept
  only while the run's page is still blank (`about:blank` or a new-tab page):
  the newest that shows a page, else the one Octo worked in last. runtime-agent names the kept tab with the
  run in `chat-tabs.json`, the newest 24 such tabs, a record that outlives the
  run like the leftover record and grants nothing; the page list reports it
  as `leftByRun` on that tab while the tab is not one of Octo's. Then that tab, or else the run's
  page once any of Octo's tabs closed, comes to the front
  (`GET /json/activate/<id>`): Chromium would otherwise show a neighbouring
  tab, which may be another chat's page. A tab kept as the chat's page is one
  more of the person's tabs: once the browser has more than 24, the one used
  least recently closes, as when Studio opens a chat's tab (never the kept tab,
  the run's page, the tab used last, or one of Octo's). A tab the person kept stays where they
  are. A kept tab stays
  an ordinary tab no later run can use, and both records are cleared with the
  run's approval directory.
- **No orphan tabs.** A tab of Octo's that is still open when its run's
  records are revoked (the run ended without a confirmed shutdown, so the
  runtime restarted, or the browser did not answer the close) is carried into
  `leftover-tabs.json`, which outlives a run like `chat-tabs.json` (above);
  these two are the only files in the approval directory that do. It grants nothing and Octo cannot use those tabs. The origin keeps
  badging them `openedBy: "agent"` with `leftover: true` and no number, since
  the next run numbers its own tabs from 1 again: Studio calls each one
  "Octo's earlier tab", and the Reading row and the count of the tabs Octo
  holds leave them out. runtime-agent closes them at the next confirmed
  shutdown, runtime start or browser start, and the keep route on one makes
  it an ordinary tab at once. Both rewrite the record under a lock on the
  approval directory (`flock` on the directory itself), and runtime-agent
  applies only what its own closing pass changed, so a tab a person keeps
  while the tabs close is never put back, and a tab still open is never
  dropped. A browser that starts again has new tab ids, so the record's tabs
  are then settled as gone; a tab Chromium's session restore reopens is an
  ordinary tab.
- **Records being written.** Every writer of the approval directory (the
  controller, the origin and runtime-agent) publishes a record through a
  temporary `.instafy-approval-*` file that it then renames. A step that
  starts while one exists runs as usual; any other unexpected entry still
  fails the step closed.

### Redaction, step categories and downloads

The controller embeds the private workspace package
`@instafy/browser-action-policy` (`redaction.js`, `actionPolicy.js` and
`pageCapture.js`, whose `pageSecretSignalsInPage` answers the page's secret
checks), the same plain scripts the Desktop Personal Browser uses. runtime-agent compiles the
source into its binary and passes the composed controller script to Node on
stdin, because together they exceed the 128 KiB Linux limit for one argument.

**Redaction, on every site and in both modes.** Snapshot text, title, address,
control names and link targets, `status`, the action log (`actions.jsonl`, which
anyone with read access to the project can see), approval labels and the
controller's error text are masked before they leave the controller. Known key
formats become `[redacted secret]`; unknown random values are masked near a
credential word; sensitive address parameters become `REDACTED`. In the action
log, approval labels and errors every random-looking run is masked, while an
address in them is masked like the snapshot's address and keeps its host and
path. Element roles and `autocomplete` values in a snapshot are masked like
control names. The page
computes yes/no secret signals in the page and never returns the values it
tested. A page that shows a key becomes a secret screen: its text is withheld,
`secretScreen: true` is set with a fixed message, and control names stay
(masked) so the agent can name the control. The document keeps a
non-configurable mark, so it stays withheld across the run's separate controller
processes until a new page loads. When the page's own checks fail (for example
while it is still changing documents), the controller retries once; if they
still fail, that observation is withheld but the document is not marked, so the
next snapshot reads it normally.

**Step categories.** Every click, typing step, submission and key press is
classified from the element's structure (tag, role, link shape, form method and
password fields, enclosing dialog, navigation, menu or pagination, credential
context from headings, dialog titles, table headers and rows). Under routine
browsing these ask with **Allow once**: purchase, money transfer, message,
sharing or access change, key or password change, download or export, delete,
cancel or sign out, and "may show a secret" (an entry in a credential context).
Ordinary record changes still ask only when they submit. Risky addresses
(sign-out and unsubscribe, exports and files, one-time invite or reset links,
action words followed by an id) ask by address alone, for navigation too. The
earlier consequential-word check stays as a floor, and a step whose structural
facts are missing asks. The category leads the approval label, for example
`Download or export: Export CSV`, so the request shape is unchanged for Studio
and the origin. In Ask mode every step still asks.

**Form steps are judged by what the browser submits.** The page describer runs
the shared form rules (`@instafy/browser-action-policy/formSubmission`, the
same ones the Desktop Personal Browser runs) and reports the submission a step
makes, not just the form's `action` and `method`:

- A submit button's `formaction`, `formmethod`, `formenctype` and `formtarget`
  replace the form's. Enter in a field submits through the form's default
  button (its first submit button in tree order, one outside the form joined
  with `form=` included); a disabled default button blocks it, and the step is
  then judged by what that button would send. Enter in a checkbox, radio, date
  field or select clicks the first submit button that is not disabled, as
  Chromium does. The default button is found however many controls the page
  has.
- A click is followed up its event path, as Chromium dispatches it, through
  slots and shadow roots and however deep: a label of a submit button, or
  anything inside one that passes the click on (text, a label, a plain button,
  a text area), submits with that button; a link, checkbox, radio, file or
  colour chooser, reset button or details summary takes the click instead. A
  field or select inside a submit button submits through that button when
  clicked and through the default button on Enter, which can go elsewhere, so
  its form steps are refused before any prompt.
- Addresses are absolute and resolved against `<base href>`; an empty action,
  or one of only spaces, is the page itself. An empty target takes the
  `<base target>` as a missing one does. `method="dialog"` closes a dialog and
  sends nothing, so it has no destination.
- The step's destination, its link-only check, the prompt for another site
  ("Allow this form destination for this run") and the approval's destination
  binding all use that submission. The classifier allows a same-site GET
  search only when its submission is a known GET of the page's own site in the
  same tab, to an address that is not risky; the Shared Browser takes one
  without a prompt only under the stricter site-search rule above (the page's
  own origin, nothing key-like sent, routine browsing).
- A form step whose submission opens another window (`_blank`, a `<base
  target>`, or a name that is no frame of the page) is refused before any
  prompt.
- The step's guard holds the page to that judgement on the request itself.
  While a step runs on a page, a form the tab posts to another site goes out
  only when the step is a form step approved for that site; an ordinary step
  (one routine browsing takes without asking) posts to the page's own site
  only, and a site search posts nowhere. A form the page moved after the check (a keydown or click handler
  changing the default button or its `formaction`), or one sent through a
  submit button the describer cannot see (in a closed shadow tree, or laid
  over the control), is stopped before it leaves the browser and the step
  fails saying so. A step the person approved that sends no form of its own
  is not limited, since a page may build and send one after it, and neither
  is a page the step went on to load. Like the link-only check, the guard
  covers the tab's own document, not the page's frames: a form the page sends
  into one of its own frames (a keydown handler pointing the default button's
  `formtarget` at an iframe, say) goes out like any other request the page's
  script makes.

`packages/browser-action-policy/formSubmissionCases.json` is one table of form
steps both browsers run: `scripts/shared-browser-form-submission-e2e.mjs`
checks every case against what real Chromium sends and drives the production
controller through a hostile default button, a label of a hidden submit
button, a form that opens a window, a `<base href>` to another site, a
keydown handler that moves the form after approval, submit buttons in a closed
shadow tree and laid over a control, and fields and controls nested inside a
hostile submit button.

**Refused in every mode, before any prompt.** Revealing or copying a credential
(`step_refused_secret`), sign-in submits, identity-provider sign-in buttons and
typing a sign-in form's account identifier (`step_refused_sign_in`), file
inputs (`step_refused_upload`), and a cookie banner's accept
(`step_refused_consent`). Before a key change or "may show a secret" step
runs, the page is marked withheld, and so is the page it leads to: the step
records the document it ran on (the main frame's CDP loader id, which page
scripts cannot set) in the run's approval directory as `withhold-next.json`, and
the next snapshot of any other document marks and withholds that document,
however late it loaded, then clears the record. An address the agent opens
itself clears the record, as on Desktop. The record is cleared with the rest of
the approval directory when the run starts and ends.

**Downloads are denied.** The hosted browser has no copy-out, so a download would
only land where an ordinary turn could read it. Two blocks cover it:

- Each controller connection sends `Browser.setDownloadBehavior` with `deny`.
  Playwright's own connection otherwise lets downloads into its temporary
  folder, and a CDP session that allows downloads overrides the profile
  setting. The override ends when the connection does. Playwright allows
  downloads for the few milliseconds between connecting and that deny; the
  controller closes every connection with `browser.close()`, which leaves
  Chromium running and deletes that temporary folder.
- The runtime entrypoint writes `download_restrictions: 3` (block all
  downloads, the preference behind Chromium's DownloadRestrictions policy) into
  the profile before every Chromium launch, keeping the rest of a restored
  profile. This holds after the controller disconnects, when viewers drive the
  page. It blocks downloads for the people using the Shared Browser too, not
  only for the agent.

Printing is not blocked: a viewer who prints the page to PDF writes a file
inside the runtime, where an ordinary turn could read it. The agent cannot
print, because its allowed keys exclude the print shortcut.

`scripts/shared-browser-cobrowsing-e2e.mjs` proves both in real Chromium: an
approved agent click on an export link writes no file, a controller's deny
followed by a reconnect and a trusted viewer-style click downloads on a plain
profile (the control), and the same sequence is blocked on a profile the
entrypoint prepared. `scripts/runtime-image-browser-smoke.sh` repeats the
reconnect check inside the runtime image with its entrypoint.

Redaction and classification are heuristics and advisory hardening, not an
isolation boundary: every viewer still sees the pixels, page scripts run in the
same world the controller reads, and a value in an unknown format with no
credential word nearby can slip through.

Studio opens the Shared Browser by itself for Octo's `request_browser` card
on the conversation's own machine in a space the controller covers, whether
that browser runs yet or not, unless someone else has it open, controls it,
runs in it or is starting it (see "How Studio opens it" below and
[Browser Profiles](Browser-Profiles.md)).

A message that names Instafy's browser, or whose work happens on a website,
goes to the browser from its first message. The routing step that runs before
each of the person's messages may answer `browser`, or `browser_then_build`
when Octo builds from what it finds; the browser skill's last section,
"Routing preflight", says when, and a space whose copy of the skill lacks it
keeps today's routes. A message that names the browser still stays with Octo
when the browser turn could not do it alone: it sees only the person's words
and the chat's earlier browser turns, so a message that needs what this space
or another chat holds, a site that runs in this space, or a message that says
not to use the browser is not sent there. The routes are offered only for the
person's own words (never a prompt Instafy wrote for a command such as
`/learn`) on an interactive turn that could ask for the browser itself (not a
hand-back, a worker, a plan, an unattended run or a browser turn) and that
Octo answers for sure (not a group chat's message that Octo first decides
whether to answer at all), with no attachments. That message's job then runs
no model turn of its own: it posts one card marked `routed`, whose task is the
person's own words, and no reply. Studio opens it as it opens any card, and
the chat reads it as one turn: the turn's line says "Opening Instafy's
browser…" until the browser turn shows something, and neither the card nor
the continuation (which repeats the person's message) is shown. A routed card
Studio cannot open by itself shows as any card does, with its reason; once the
person presses it, or once its browser turn fails or is stopped before it
shows anything, it reads Opened as any card does, since nothing is opening it
any more. The card's
browser turn, its hand-back and every check on them are a card's, except that
its browser turn is the person's own turn for billing (its task is their
words; [Credits and billing](Credits-Billing.md)), and its hand-back gives the
building turn the message's words as the person's request: that building
thread never saw the message. A building or chat turn that finds mid-task that
it needs the browser still asks with its own card. It never starts, stops or replaces a
machine for this, and every other card waits for the person's press. The
continuation is an ordinary Shared turn with consent version `1`. On the space's
own machine it starts in routine browsing, as every run there does (see "Human
approval policy" above); elsewhere it starts in **Ask**, with the per-run origin
approval, and **Allow routine browsing** stays the person's own choice. Studio
never answers a site or action prompt for the person, and neither Studio nor the
job metadata chooses the starting mode (Let Octo continue only names the run it
continues; runtime-agent decides what carries, see "Manual input handoff").
Under routine browsing, steps in a named
risk category still ask, because the browser runtime enforces them.

This is an additive runtime-origin policy choice, not caller-authored job metadata.
Consent version `1` continues to attest the bounded browser lane and its one-shot
policy for the steps that ask. The authenticated origin bridge accepts the new `allow_routine`
decision only on an exact pending origin prompt, and the runtime stores it only
inside that run's protected approval state. Older runtimes do not advertise it
and reject that decision; older clients retain the existing Ask-only choices.
No database migration, cookie copy or broader controller/workspace grant is added.

A person has two minutes to answer the prompts of one browser step. The
approval script's default window is 120 seconds and its cap is 300 seconds; the
origin accepts a request that lives up to the same 300 seconds, and the two must
move together, or the origin refuses the request and the sheet never shows
(`shared_browser_tests.rs` checks that they agree). One tool call's prompts share
one deadline counted from the call's start, so in Ask a site prompt and the step
prompt after it fit in the same two minutes. The Shared Browser tool's Codex
timeout is that budget plus 60 seconds for the navigation, settling and snapshot
that follow the last answer (180 seconds by default), well inside the
600-second turn cap. `INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS` overrides the
window for tests, from 100 ms to 300 seconds; production never sets it.

A step's own work has one time limit: 20 seconds, not counting a prompt that
waits for the person (the clock stops while one is on screen). A page can hold
a step far longer, with a script that keeps the page busy or a load that never
settles, and the view and the turn's line would freeze while the step waited.
When the time is up, the step takes no further action (no prompt, click, key,
typing or navigation it had not started) and answers with the page as it is: a
snapshot read within 8 more seconds, or, when the page is too busy to be read,
its masked address alone, with no text and no controls. The answer carries
`stepTimedOut: true` and a note that tells Octo to check what the step did
before it acts again (it calls the read "the page as it is now" only when the
page was read), and the Shared Browser policy says to take a snapshot
and go on from there: only an approval's own outcome is final. On the turn's
line it reads as a page read when the page was read, and like `status`
("Browsed <site>") when only its address was, so it adds no new wording and
never says a page was read when none was. A step that started a load (a
`navigate`, an `open_tab`, or a link, form or key that opens a page) whose site
(one that is down) had not answered when the step stopped waiting for it (its
time up or, sooner, a click's or a key's own 15-second wait for the page it
opens) stops that load, whatever page the tab showed before, the blank page or
a page that had loaded: while it waited, Instafy's browser could not be reached
by the next step, and it would have landed after the step ended. So the step
opened nothing, and it fails with "The site did not answer in time, so nothing
was opened and the page is still blank." (or "…and the tab still shows the page
it showed before."), followed by "Open the place's own site now (the venue's or
the operator's), or another official source if this was it.": never the blank
page's "Call navigate", which sent Octo to load the same site again, nor the
page the tab still shows, which was read as that step's page, nor the click's
own timeout. Its line reads as the step it tried ("Tried opening <site>" for a
navigation). Whether the site answered is judged by the load's own request,
never by the tab's address, which a page's script may change while the load
waits. A site that answered as the step stopped waiting has its page, which is
read as it is, and a load the browser does not confirm stopped fails as a busy
page instead. Only a load that sends nothing (a GET, through every redirect) is
stopped: a form the tab posted has reached its site even when no answer came,
so its load runs on, and the step answers as a busy page does and says to check
what it did, never that nothing was opened. The step's guards still hold while
the page is read, then end as a step's guards end: a window the step opened
is closed by its target (a busy page's window may not be a page Playwright can
show yet) and fails the step as it would have in its time, as does a
link-only load or a form post the guards stopped. A hand-off whose fields were
not all highlighted in time leaves no prompt behind.
`scripts/shared-browser-step-time-e2e.mjs` shows these in Chromium: a search
whose results page keeps the page busy for a minute answers after about 29
seconds, a loaded page whose content is still hidden reads as busy, a prompt
answered after 23 seconds is waited for, a click that opens
a window and keeps the page busy fails with the window closed for good, a
hand-off on a page too busy to highlight in time leaves no prompt, and a load
of a site that does not answer is stopped (a navigation, from a blank tab or
from a page that had loaded, after about 20 seconds; a link clicked on a page
once the click stops waiting, after about 15): the next step reaches the
browser at once, and the site's late answer never loads.

In a Shared or Personal Browser turn, a code-mode cell that waits on a browser
step yields to the model only after the browser server's tool timeout (180
seconds for the Shared Browser, 40 for the Personal Browser), not after Codex's
default 30 seconds. Each earlier yield was one more model call, with the whole
context, that could only wait for the same step again.

A declined site is the one denial a run survives, once. The site stays closed
for the rest of the run without another prompt (the run's state lists it in
`declinedOrigins`), and the tool tells Octo to take another route that fits the
person's request, such as opening the site they named directly, or to end the
turn and ask. Declining a second site, or declining a step, ends the run. A
denial of a step, an unanswered prompt, a stale request, a page that left its
site after the person's yes or a second yes left unused because its control
changed (`approval_stale`), revocation, storage failure, or malformed approval
protocol is terminal for that browser run. The
runtime latches the failure, rejects later mutations without opening another
prompt, and reports machine-readable terminal-consent state so the job layer
does not invoke its normal missing-action retry. The user starts a new turn if
they want to try again. This keeps “Deny” from becoming a sequence of repeated
consent prompts, and an unanswered prompt from becoming a chain of prompts
while the person is away. What the person reads tells the two apart, with no code: an unanswered
prompt reads "I'm waiting for your OK to continue in Instafy's browser. I
haven't done that step yet.", a denial reads "You said no, so that step didn't
happen, and nothing from it was sent.", `approval_stale` (the page changed
after the yes) reads "The page changed after you said yes, so I didn't do that
step. Send a message and I'll ask again.", and every other terminal code reads one plain
message. Each speaks
only about the step that asked, because earlier steps of the same turn may
already have opened pages or changed something. The code stays in the run's
`browser/terminal-consent` artifact. The tool result tells
the model that an unanswered prompt is not a denial and that it must end the
turn without retrying.

A run also stops when Instafy's browser goes away under it. The controller
exits with code 75 when it cannot connect to the browser over CDP, when the
run's own tab is gone, or when a command fails and the browser then shows the
connection dropped, the run's tab closed, or the tab is no longer among its
pages. Playwright reports a closed tab or browser with a plain `Error` whose
message can quote page markup, so the controller asks the browser and never
reads the error; any other failure exits 1. The runtime judges that by the exit
code alone, never by error text a page could shape. Two such tool calls in a row latch the
terminal code `browser_unavailable` like an approval code: later calls do not
start the controller, status reports `ready: false`, the tool result tells the
model to end the turn, and the person reads "Instafy's browser closed or
stopped responding, so I stopped there. Open the browser again and send a
message to continue." One failed call followed by any other answer starts the
count over, so a single slow connect does not end a turn.
A page that did not load (a Chromium `net::ERR_…` code in the controller's
error) fails with a plain reason as the result's text, and the code only in
`structuredContent.error.details`: "Instafy's browser couldn't reach that
site: …" for a connection that did not happen or did not last (the proxy
answers a denied, refused or silent site alike), "couldn't find that site",
"That site's secure connection failed…" or "kept redirecting". `ERR_ABORTED`,
which a file to download (downloads are blocked) or a replaced navigation
ends with, says the page stopped loading before it opened; any other code says
only that the page didn't load, so no reason claims the site was unreachable
when it answered. The browser policy and the
`instafy-browser-automation` skill tell Octo to give the person that reason in
plain words and never to paste a raw error code into a reply. Any other failed
call keeps the controller's masked error text.
If the client temporarily loses its network, it retains the exact visible
request, shows reconnecting state, and retries the bounded poll/decision path;
the origin's one-use fingerprint and replay checks remain authoritative.

Studio also shows a pending prompt as a card in the run's own conversation, for
the person who started the run only (the run's controller-set `initiatingUserId`).
The card names the step and the page it loads (the site, for a prompt that
names no page), counts down to the prompt's expiry and
offers **Deny** and **Allow once** (**Allow site** for a site prompt); routine
browsing stays a choice of the browser view's sheet. Its poll uses the running
job's own machine and page (the run's `browserRuntimeId` and `browserPageId`, which
the prompt is bound to) and its own `browser.view` + `browser.control` grant, never
the browser view's pages list, host read, picture or grant. So the prompt stays
visible and answerable while the browser view reconnects, shows an error, is
hidden behind the Chat tab, collapsed in a narrow pane or was never opened in this
tab. The browser view's sheet shows the same poll for that machine, so both
surfaces share one state: an answer in either settles both, and the card then says
**Allowed**, **Denied** or, after the window, **Expired**. A press answers only the
prompt that surface shows: a newer prompt the poll found first, or another run's,
is never answered by it, and the card's buttons are off while it still shows a
prompt that is no longer the one waiting. The pending and decision
endpoints, their scopes and the origin's initiator and page checks are unchanged.
A teammate polls nothing and sees no card.

Prompts are raised only inside a run, and only the agent writes the action log,
so the browser view reads both fast only while work can produce them. While a
run is active in the space or the agent controls the browser, it reads the
action log every second while it keeps finding new actions; each read that
finds none doubles the wait up to 4 s (the agent spends most of a turn
thinking between actions), and the next action found brings back the 1 s tail.
It reads the pending prompt 1.5 s after each answer (every 400 ms while a
prompt is shown). Reads that fail in a row wait twice as long each time, up to
10 s, and the prompt says "Approval connection interrupted. Reconnecting…"
only once reads have kept failing for 2 s. Two reads are never closer than
400 ms when the poll stops and starts again, or comes back to a machine, page
or grant it read recently (one it has not read yet reads at once), so a page
that changes back and forth costs no read per change. The tab list and action
log polls likewise read "at once" at most once a second while they are
switched off and on, or while their pace keeps changing: a change soon after
the read for the change before it owes one read a second after that read, and
later changes neither add reads nor put it off. With neither, it reads the action log every
10 s and the prompt every 15 s, 30 s each once nobody has touched the tab for
three minutes. A run starting, or the agent taking control, reads both at once;
a run ending takes one more read of the action log, so a human-input request
written at the end of the turn still shows. Nothing is read while the tab is
hidden, not even the read a run starting or ending asks for; coming back makes
that read at once, along with whatever else is due.

The agent controls the page through one runtime-owned, required MCP server:

```text
instafy_shared_browser.status
instafy_shared_browser.snapshot
instafy_shared_browser.navigate / click / type / choose / press / scroll
instafy_shared_browser.request_human_input
```

It exposes only status, bounded snapshots, navigation, click, type, choosing an
option in a list, key press, and scroll operations. The runtime replaces every project-configured MCP server
with this one bounded server for the turn, disables shell and patch tools, and
connects to the runtime's loopback CDP endpoint internally. The model cannot
author Playwright/CDP scripts or receive a raw debugger endpoint. Click, type,
choose and every key press must carry both an index and the SHA-256 `snapshotId` from
the observed page. The selected CDP target is part of that fingerprint, so even
two tabs with identical URLs and DOM cannot replay each other's snapshots. The
controller recomputes that fingerprint before it judges or asks about a step and
uses a concrete element handle, so reordered or relabeled DOM cannot silently
retarget an action. Once the person has answered the step's prompt, the page
elsewhere may have changed by itself while they read it (a carousel's slide, a
clock, a live count), so the step checks the control they were asked about
rather than the whole page. It acts on that very element, still shown, with
the same fingerprint (its names, where it leads, its form and that form's
text), the same destination, the same address (its fragment too, which some
sites keep their page in) and the same text around it: that of the nearest
element around it whose text is more than its own (its card, its form's
labels, its row), when that is a small part of the page. So a look-alike shown
in its place (a shop carousel's next "Add to cart"), another order in the
address, or another product drawn beside it in place is never taken for it. A
control the page drew again in its place stands for it only on a page that
reads exactly as Octo's snapshot did. The run's authority is read again last,
so a take-over or a new run still ends the step there, and the step stays on
its tab and its site. A control that changed is not used: the step fails
without ending the run, and Octo takes a fresh snapshot and, if the step still
fits, does it again, which asks the person again. The run ends
(`approval_stale`) when the page left its site after the yes, and at the second
yes in the run left unused this way, so a page that keeps changing beside a
control (a countdown in its form) never turns into a chain of prompts. A page
that left its site while nobody was asked only fails the step. A failed step the person allowed still
says so (`approval: "once"` beside its kind on the controller's stdout, and
`changedAfterYes` when its yes went unused, which runtime-agent counts), so
Details list that yes. `scripts/shared-browser-allowed-step-e2e.mjs` plays each
of these in real Chromium. It resolves `aria-labelledby` references into the raw safety
descriptor before classifying sensitive and consequential targets; Delete,
Backspace, Enter, and the rest of the key allowlist cannot bypass that
classification. CSS selectors are not accepted. The embedded controller loads
Playwright only from the image-installed absolute module path and runs from the
runtime-agent binary directory, never from project `node_modules`. Actions
return concrete observed page state, including the final URL and title.

A snapshot lists what a person can see. A control or run of text is left out
when it is not rendered or is transparent, sits under `aria-hidden="true"` or
`inert`, lies wholly where the page cannot be scrolled to (a closed off-canvas
drawer), or is clipped to nothing by an `overflow: hidden` or `clip` box it is
laid out in (a menu collapsed with `max-height: 0`). A scroll container with a
real size only scrolls, so what it holds still counts. An open modal dialog or
popover, or a fullscreen element, is drawn over the page, so no box around it
clips it. A native checkbox or switch drawn by a library stays listed when it is
transparent over the styled control or operated through a visible label.
Collapsed menus therefore no longer fill the 200-control limit, and opening one
shows up in the click's own result: after an action the controller waits, at
most a second, for running transitions and animations that end, so a menu that
opens with a transition is observed where it lands. `omittedControls` counts
the controls left out, so a list cut short by a closed menu, or by a box the
page scrolls itself, does not read as the whole page.
Snapshots and actions build the list with the same function, so indices and the
`snapshotId` agree. Whether a page is a secret screen is still judged on all of
its rendered text and every control's name, seen or not, so leaving hidden
parts out never lifts withholding. Each control carries only its non-empty
fields; `expanded` reports a toggle's state and `area` the part of the page it
sits in (`header`, `nav`, `menu`, `dialog`, `tabs`, `search`, `footer` or
`aside`), and a link on the page's own site is given as its path. `navigate`
takes that path too and resolves it against the current page's site; a path
that names another host is refused, and a blank page needs a full address. The
text reads a closed select's chosen option as a word of its own, and the select
says which option it holds in `chosen` (none on a secret screen). The control's
box stays inside the controller for the visible cursor, and the MCP text result
is compact JSON beside the same structured content.
On the page the person chose, a page with sign-in fields (a password or
one-time code field, or the account identifier that typing into is refused as a
sign-in, as the shared policy's `isSignInField` tells them) names them in its
result's `signIn.fields`, with what comes next: when the person asked to sign in,
or a step they asked for needs it, the turn pauses there with
`request_human_input` and ends, and they sign in on the page and choose **Let
Octo continue**. A page with no sign-in fields yet names the link or button that
opens the sign-in page instead (`signIn.open`: named exactly "Sign in", "Log in"
or the like, outside any form with a password, as `isSignInOpener` tells), so a
turn that starts on a site's home page reaches the fields. That holds for
`snapshot`, `navigate` and every step whose result reads the page. Octo's own
tabs, which are for reading, never name them.

Otherwise Octo never signs in: it uses what the page shows without it, and a
page that shows only a sign-in (one read for research) ends there, not the task.
Neither hint says a page ends, so a readable page with a "Sign in" link stays
readable. The Shared and Personal Browser policies, the browser skill and the
turn that writes a card's task state the same rule. A run on a resumed provider
thread is given its own policy as well (once, when it differs from the one the
thread last read), and the hint says the rule again where it applies. The
turn's reply after a pause says "Sign in or fill in the highlighted
fields on the page in Instafy's browser, then choose Let Octo continue. I don't
ask for those details in chat."

A browser that has just started, such as the on-demand browser on a space's own
machine, shows exactly `about:blank`, and a tab opened in the viewer shows the
new-tab page (`chrome://newtab/` or `chrome://new-tab-page/`). `status` and
`snapshot` report these pages as `blank: true` with a constant, empty
observation: nothing is read from the page, no origin is approved, no action can
target it, and the observation is not written to the action log, so it is not
evidence of browser work. The agent's policy, the blank observation itself and
the retry all tell it to call `navigate` first: with the address the task names,
or, when the task names none (a research or comparison card carries no address),
with the official site of what the task is about. A turn that stops on a blank
page with no step the browser answered (below) is retried once with that
instruction, and `navigate` asks for the site's approval as usual. Every other
page without an http(s) origin (`data:`, `about:srcdoc`, a blank page with a
fragment, other browser-internal pages) still fails closed with
`[origin_not_approvable]`. That error is not a consent
decision and does not end the run; it tells the agent to navigate first. Neither
Studio nor the runtime opens a card's site on its own; the card's hosts are only
shown to the person.

Every high-level snapshot/action appends the cursor/action-ticker telemetry
owned by the Shared Browser shell. The runtime records the action-log position
before the turn and accepts completion only when it sees both a completed call
from the exact `instafy_shared_browser` server and new action evidence, or a
`navigate`, `open_tab`, `click`, `type` or `press` from that server that the
browser answered, also with an error (a site that did not answer, a page that
changed, a step the policy refused): the turn has seen why the step failed and
says so, and a retry would only send it back to the same address. A call that
could not reach the browser at all is no such answer (its result is marked
`browserUnavailable`), so that turn is still retried; a second one in a row
ends the run instead. A tool
event from another MCP server, a status-only narration, or prose success is not
accepted. Missing evidence gets one browser-specific retry that again requires
the bounded server and a fresh snapshot. If the retry still has no instrumented
action evidence, the job fails closed instead of presenting an unverified prose
success. The person reads one plain sentence for it ("Octo couldn't open a page
in the browser, so this turn stopped."); the artifact beside it keeps the
machine-readable reason.

Page content is untrusted. Browser-only turns therefore have no local execution
environment, project MCP servers, web search, plugins, image generation, child
agents, patch/file tools, or learned-memory tools. Browser capability variables
are also stripped from shell children in ordinary turns. The runtime agent
clears `RUNTIME_METADATA`, whose launch environment can carry TURN credentials,
from its own environment at startup. The hosted browser is
still in the same runtime OS boundary as ordinary workspace execution; moving
Chromium/control into a separate sidecar user or container is the remaining
defense-in-depth step against a deliberately hostile workspace process.

At normal desktop widths Studio follows the runtime preference, so WebRTC is the primary low-latency lane when it is available. At compact widths Studio deliberately selects CDP screencast when advertised: CDP resizes the actual Chromium viewport and lets the page reflow, while a fixed-aspect video would otherwise be scaled or letterboxed. Returning to a wide layout restores the preferred WebRTC viewer without changing the Shared profile or page state.

## Responsive and touch behavior

Expanded Shared Browser keeps its toolbar and viewport inside the device's
safe-area insets, including macOS window controls and mobile cutouts. The
background still fills the screen; ordinary web browsers with zero insets
retain the full viewport. Insets update when a device rotates.

The expanded portal also follows the visual viewport when a mobile keyboard
shrinks only the visible area. The app's open keyboard input bar reserves its
own space above that keyboard, so it does not cover the remote page. These
layout changes keep the same session, control lease, and focused app input;
they do not automatically expand or reopen a browser.

After a driver-authorized viewport shrink, the origin waits for Chromium to
acknowledge the resize, rechecks input control, and scrolls an already-focused
editable into view without changing focus or reading its value. This adjustment
covers the main document and open shadow roots, not fields inside iframes.

Navigation and expansion use the common icon-button styling; the address Go
control also keeps a 44px minimum touch target on coarse-pointer devices.

### Manual input handoff

While another participant controls the view (human or AI), a faint glow flows
slowly around the outer 20 pixels of the page. Soft, overlapping pools of light
drift at different speeds, with a brief bloom when the controller changes.
The existing toolbar identifies
the controller. Your own control and independent browsing have no glow. The
center stays clear on light and dark pages independently of the Studio theme.
The cue is presentation only; it does not grant input or block local viewer pan
and zoom. Human control still uses the existing request/grant/release actions.
For AI control, clicking the page or toolbar control icon opens a **Take over** dialog.
Canceling leaves control unchanged; confirming starts the existing handoff.
**Let Octo continue** then appears in a row under the toolbar. Reduced-motion
preferences use a static edge glow. Agent-requested handoff
uses `request_human_input` with one to eight indices from a fresh snapshot. When
it comes in while the chat is open, Studio switches the person whose turn it is
(the run's `initiatingUserId`) to the Browser view, where the highlighted fields
are (once per pause; history, a reload and other members' pauses switch
nothing). While it waits on the person's fields, a row of its own under the
toolbar, at every width (a narrow toolbar folds its controls into a menu), says:
"This space's browser keeps you signed in for its chats until you clear it.",
or "…for its chats and members…" when other people can open the space (see
Sign-ins on a browser host), beside **Let Octo continue**. The same row holds
**Let Octo continue** after a take-over. When nobody holds the browser's
control (after **Release control**, say), the press takes control first, as
**Take control** does, and continues once the browser confirms it; without an
answer within five seconds it says "The browser didn't answer. Try again." While
someone else holds the browser, the row shows the note alone (the toolbar says
who holds it), and a press whose control went to someone else first ends
without a notice. The
trusted helper highlights those exact editable elements with fixed amber outlines
and emits bounded, page/initiator-bound guidance through the existing action feed.
The guidance contains generic labels, not field values or page text. Highlights
follow the actual elements through scrolling/reflow and are removed by the next
fresh agent snapshot; a replacement element does not inherit a stale highlight.

Outside a manual handoff, paused native agent control uses one **Resume** button
in the toolbar. It remains disabled while another participant controls the tab.

The tool latches later agent observation and action for that turn. It does not
remove the agent-control marker: manual input remains locked until the existing
confirmed-shutdown path restores the human driver. A canceled controller run alone
is not release proof. **Let Octo continue** explicitly starts a new turn on the same
runtime/page with a fresh observation. It sends only a fixed continuation message,
never the user's entered values, and says only what is true whether or not the
person used the browser meanwhile. Account, conversation, runtime or page changes
invalidate the continuation.

The continuation keeps the run's approvals. Studio names the run it continues
(`browserContinuesRunId`, the newest ended Shared Browser run of the
conversation on that runtime and page that the person started). runtime-agent
keeps, in its own memory, what the last run to hold the browser left once its
tools were confirmed gone: the sites approved on the page the person chose,
and routine browsing if they allowed it. The new run starts with them only when
the run it names is that last run, for the same person on the same page, and
ended less than ten minutes ago. Any other run uses the record up, so a run in
between, another person, another page, a restarted runtime or browser (new
page ids), or a run that ended without a confirmed shutdown starts with
nothing, as every other run does. Octo's own tabs close with the run, and the
sites approved in them go with them, apart from the tab the run left the chat
as its page (`leftByRun`): a run that continues it there, as a follow-up does,
starts with the sites approved in that tab and routine browsing, never the
sites approved on the run's own page. Job metadata can only name the run; the
runtime decides what carries. Manual navigation drops stale field guidance but
keeps the manual-step controls, so login redirects can finish before continuation starts
a fresh turn. A target change during asynchronous continuation aborts it; no
hidden or stale completion may send it automatically.

A follow-up typed in the chat keeps them too. When the conversation's newest
run is the person's own Shared Browser run on the browser that is open, it
succeeded less than ten minutes ago, its tab is still open and no other chat
took it since (see One tab per chat), and it did not
continue a card Octo builds from (`browserHandsBack`), a message from the chat
composer goes on in that tab as a browser turn, as one from the browser's own
composer would, and names that run (`browserContinuesRunId`,
`sharedBrowserFollowUp`). It needs no new card or press, and the site the
person already allowed does not ask again. A browser turn has only the
browser's tools, so this never happens silently: while it applies, the
composer shows **Goes to Instafy's browser** in its own row, beside the view switch,
and its × ("Don't send it to the browser") keeps the next message in the chat,
where Octo can also build, until a newer browser turn ends
(`useSharedBrowserFollowUp`). After the browser turn of a card Octo builds
from, the building turn keeps the chat, as with the hand-back. A skill setup's
replies, a message with a picture, a message for a new tab and a send the app
makes for the person stay chat turns.

Action/cursor polling runs only while Shared is visible and filters the selected
page. If the agent requests input while Chat is visible, the field guidance is
loaded when Browser is reopened; there is not yet a separate conversation badge
for manual-input requests. Site/action approval attention remains independent.

This is stop-and-continue, not simultaneous human/agent editing or a paused live
tool lending away control. Other teammates retain the ordinary Shared Browser
visibility boundary; manual entry here is not a private Personal Browser session.

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
and WebRTC drivers also get an explicit keyboard control: an icon in the
browser's toolbar, beside its options, while the person controls the page,
never a button floating over the page. It opens a local 16px text field at the
bottom of the page so iOS/Android can summon their software keyboard, then sends
bounded text, paste, IME composition, Backspace/Delete, Enter, Tab, Escape, and
arrow keys through the same origin-authorized input socket. The control
uses neutral capitalization with autocorrection and spellcheck disabled because
it cannot infer the remote field's type, and disappears immediately when human
authority is revoked. RFB remains the final
noVNC fallback and uses noVNC's own input path; the app-owned mobile keyboard
bridge is intentionally not shown there.

Shared Browser uses its compact toolbar at pane widths up to 900px, including
narrow panes inside a wide desktop window. The address and participant controls
stay on one row; history and expansion are in **Browser options**. Narrow-screen
targets are at least 40px, with 44px coarse-pointer variants where applicable.
Personal Browser retains a separate controls row at narrow viewport widths.

## Enabling the ladder

A safe initial configuration is:

```bash
VITE_INSTAFY_SHARED_BROWSER_CDP_SCREENCAST=1
VITE_INSTAFY_SHARED_BROWSER_WEBRTC=0
TURN_ENABLED=false
BROWSER_PROFILE_PERSIST_PROJECT_IDS=
HOSTED_BROWSER_HOST=off
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

## Browser on the space's own machine (controller policy)

The controller can launch a space's own managed machine ready to host the
browser on first use, so opening it neither starts a second machine nor
restarts the space's machine. The policy is off by default:

```bash
HOSTED_BROWSER_HOST=off            # off | projects | all
HOSTED_BROWSER_HOST_PROJECT_IDS=   # required with projects; comma-separated UUIDs
```

Controller startup rejects any other mode, `projects` without a UUID, and a
malformed UUID. When the policy covers a space, each new lease of that space's
machine on the exact managed provider gets a controller-owned attestation next
to the webdev one:

```json
{"_instafyManagedBrowserHost": {"version": 1, "mode": "lazy", "generation": "<leaseId>"}}
```

- **Which launches.** Not a webdev launch (a browser session of its own), not a
  request for the boot-time browser (`INSTAFY_ENABLE_BROWSER_SESSION=1`), not a
  tenant lease, and not a multi-agent worker slot. A worker is recognised by its
  lease `source` and by any earlier lease of the same runtime that a spread
  launched, because a reconnect or requeue launches a successor with its own
  `source`. Reuse keeps a worker lease's `source`, so a reconnect to its live
  lease does not erase that record.
- **Request boundary.** The key and its launch settings are not on the request
  allowlist, so a client cannot set them. Reconnect metadata drops the old
  generation's key, and the successor lease gets one only when the controller
  decides so again.
- **Reuse.** Reuse rewrites the lease's metadata, so the controller writes the
  live generation's attestation again while the policy still covers the space.
  A bare reuse never answers 409. With the policy turned off, the reused lease
  loses it.
- **Launch settings.** After the runtime and provider metadata are merged, an
  attested lease launches with the boot-time browser off, viewport-only
  rendering and CDP screencast on. WebRTC is off
  (`INSTAFY_BROWSER_WEBRTC_ENABLED=0`, no `INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN`,
  no ICE servers), even when managed TURN serves the project, and a preferred
  WebRTC viewer becomes CDP screencast. The browser shares the machine with the
  space's terminals and model tools, which run as root; the origin hands each
  negotiation's fresh TURN relay credentials to a loopback WebRTC sender, so a
  root shell could capture them. WebRTC returns for hosts once the browser runs
  in a container of its own (Phase 2). CDP screencast is the viewer, with RFB as
  the fallback. A provider's static ICE list is removed, and the origin proxy
  mints no relay credential for an origin whose runtime holds a stored
  `browserHost`: its `browser/capabilities` and `browser/webrtc/offer` requests
  carry the `disabled` WebRTC policy instead.
- **Registration.** The runtime reports `browserHost`
  `{"version": 1, "modes": ["lazy"]}`. The controller always removes the
  reported `browserHost` (and `browser_host`) and, only when the active lease
  carries the attestation for that same generation, stores its own value with
  Shared Browser agent consent:

  ```json
  {"browserHost": {"version": 1, "mode": "lazy", "generation": "<leaseId>"},
   "_instafySharedBrowserAgentConsent": {"version": 1}}
  ```

  A report without the attestation, or an attestation without the report,
  grants neither. Webdev consent is unchanged.
- **Status.** `GET /projects/:project_id/runtime/status` adds
  `"sharedBrowserHostPolicy": "covered" | "off"` to every response, and
  `"sharedBrowserHost": {"version": 1, "mode": "lazy"}` to the entry of a
  registered host whose lease is live (not released, failed or quarantined by
  a stop), that is not a private self-hosted runtime, while the policy covers
  the space. Neither field names a lease or a person.
- **Origin routes.** The controller proxies exactly `GET`/`HEAD browser/host`
  (`browser.view`) and `POST browser/host/start` (`browser.control`, body at
  most 4 KiB). Both answer 404 `origin path not found` with the code
  `browser_host_policy_off` unless the policy covers the origin's space.
- **Dispatch.** Shared dispatch to a registered host answers 409 when the
  policy does not cover its space, and the request is not sent to another
  runtime. Registration does not read the policy: the stored consent lasts
  until a reuse with the policy off drops the lease's attestation, or until the
  machine's next lease. This check is what enforces the policy, so turning it
  off stops new browser turns at once.
- **Sign-ins are kept.** A space the policy covers also has durable profile
  persistence, through the same encrypted store, `agent.browser_profile` token
  scope and launch settings that `BROWSER_PROFILE_PERSIST_PROJECT_IDS` enables
  (see [Shared profile persistence and clearing](#shared-profile-persistence-and-clearing)).
  Persistence is always on for a covered space, so the attestation carries no
  persistence switch.
  The persistence rollout barrier below therefore applies before turning the
  policy on. **Clear shared browser data** still stops every managed machine
  of the space that may hold the profile, which includes a browser host: the
  space's own machine restarts, which ends its previews, terminals and running
  work, and Studio's browser-host attach starts the same machine again
  afterwards.

A runtime image without the lazy host ignores the attestation and reports no
`browserHost`, so it gets neither consent nor the status field. A runtime-agent
that has it acts on it only when all of these hold: Linux, the boot-time
browser off, the attestation names exactly this process's `RUNTIME_LEASE_ID`,
the metadata marks neither a webdev launch nor a multi-agent worker slot, and
the image carries the host's entrypoint (always
`/usr/local/bin/runtime-entrypoint`; `INSTAFY_RUNTIME_ENTRYPOINT` is ignored
here, because `$CODEX_HOME/.env` on the workspace volume can set it), private
Node and private Playwright. Then, before any thread starts, it fixes the environment that
origin, the Codex MCP copy and the profile code read: CDP on 19223 (no CDP URL),
RFB on `127.0.0.1:15900`, `INSTAFY_BROWSER_WEBRTC_ENABLED=0` with no TURN
requirement or ICE list, egress isolation on with the unsafe-dev override
removed, the host's profile directory and the private Playwright and Node. It
reports `browserHost: {"version": 1, "modes": ["lazy"]}` at registration, starts
no browser at boot, and runs Shared Browser turns only while its host is Ready
(see [On-demand browser host](#on-demand-browser-host)). WebRTC stays off on a
host even when the controller launched it with managed TURN: the origin then
refuses an offer before it reads any relay credential, which keeps TURN
credentials away from model shells that share the machine. Viewers use CDP
screencast, with RFB as the fallback.

The browser shares the runtime container with ordinary
workspace processes, the same boundary described under
[Human approval policy](#human-approval-policy). Rollback is `HOSTED_BROWSER_HOST=off`:
status hides the host at the next read, the proxy answers 404 for
`browser/host*`, and Shared dispatch to a host answers 409. Persistence for those
spaces stops at once at the profile API and at the next registration renewal in
the token scope. A browser already open keeps running until it stops or the
machine's next lease, and machines already launched keep their launch settings
until then.

### How Studio opens it

Runtime status tells Studio about the policy and the host. The response always
carries `sharedBrowserHostPolicy` (`"covered"` or `"off"`), and an entry
carries `sharedBrowserHost: {"version": 1, "mode": "lazy"}` only while that
machine's live lease is attested for it. A response without the policy comes
from an older controller, and Studio keeps its earlier flow. An entry without
the field takes the legacy path, and Studio ignores the field on every entry
unless the policy is `"covered"`.

- **Attach.** When the resolved session, or the exact pinned one, is the
  space's own machine with `sharedBrowserHost`, Studio opens it in place. It
  reads `GET browser/host`. If the browser is idle or failed and the person may
  control the browser, Studio posts `POST browser/host/start` with
  `{"version": 1}`, then polls until the browser is ready, every 500 ms at first
  and less often while it keeps starting (two reads at each of 500 ms, 1 s,
  then every 2 s; a start it asks for begins again at 500 ms), for at most
  120 s. A viewer is told to ask a space builder, and a poisoned browser says
  the space's machine must restart first. A state Studio does not know is
  polled like `starting`, and so is a start refused with `machine_stopping` or
  `browser_host_stopping` (asked again after a second, within the start
  budget). Only the machine's own 404 (code
  `browser_host_absent`, or `not_found` with the origin's `{error, code}` body
  from an origin that predates it) reads as "Instafy's browser is off." Any
  other 404 on `browser/host` comes from
  the controller or something in front of it and says nothing about the browser:
  it is polled within the same 120 s and logged as `browser-session:host-404`.
  A 404 with the code `browser_host_policy_off` ends the wait with "Instafy's
  browser is turned off for this space." Studio never ensures, recycles or stops
  a runtime for this. It lets go of the browser runtime claim once the first
  status read
  shows the space's browser, so generic recovery keeps the space's machine up.
  **Start new session** and the runtime-limit takeover are hidden.
- **Pages while it starts.** The origin answers 503 `browser_host_not_ready`
  until the browser runs. The composer reads the pages every 2.5 s only while
  the open browser view is opening or live; while it is off, did not open or
  cannot open, nothing reads them. Even then the 2.5 s cadence holds only while
  a run is active, someone else is in the browser or controls it, or the view
  is on screen and the person has used the tab in the last three minutes;
  otherwise the pages are read every 15 s, and never while the tab is hidden.
  A read that finds the tabs exactly as they were doubles the wait up to 5 s;
  any change brings back 2.5 s, and reads that fail or find the browser still
  starting keep it. A failed capability read is not asked again while the tab
  is hidden. Capabilities stay, so the attach can go on
  once the view opens again; a capability read that failed is not asked again
  while the view is off, and is asked at once when it opens. While it opens it
  polls quietly, for at most
  120 s of unbroken `browser_host_not_ready` answers (token and gateway
  failures, as while the machine itself starts, are not counted). Each open
  counts its own run, so closing the browser and opening it again starts over.
  After that a card waiting on it says "Instafy's browser did not open. Try
  again." The address field stays empty and disabled whenever the view is not
  live; the view's own card says why. A page read that does not answer in 10 s
  is given up and asked again. A hidden one suspends as before, so an idle
  browser behind a hidden tab is never polled and never started. Only the open
  browser view starts it.
- **Bounded requests.** Each `GET browser/host` and `POST browser/host/start` of
  the 120 s wait ends after 10 s, or at the end of the wait, and is polled again
  like a gateway error, so a hung request cannot outlast the wait.
- **Cold press.** When the space is covered and a press finds nothing to open,
  or the exact pin names the space's own machine while it is stopped or no
  longer listed, Studio first starts that machine through the generic hosted
  ensure. It then reads status until the machine can take work: every 2 s for
  the first minute after the press, then every 10 s, for at most ten minutes
  from the press (the controller gives up on a launch that never comes up after
  15 minutes). A first launch on a new node can take minutes while it pulls
  the image. A minute after the press, also while the ensure has not answered
  yet, the view says "Still starting this space's machine…"; its pill and its
  lack of a button stay as they were. Once the machine is up, the view says
  "Opening Instafy's browser…" again while that browser starts. It waits on the pinned
  machine or the conversation's machine only when that is the space's own
  Instafy Cloud machine, never a Desktop, self-hosted or separate browser
  session machine; otherwise it waits for the first live host. It waits only
  while that machine's launch is on its way: a booting status, never seen on
  this launch, a `launchRequestedAt`, and no person's stop since. A launch the
  controller replaced keeps its runtime id with a new `launchRequestedAt`, so
  the wait goes on. The ensure's two 45 s attempts can both time out behind the
  controller's launch lock while the launch goes on, so an ensure that did not
  answer is followed by one status read: when the launch is on its way, the
  wait goes on; otherwise (a credits or capacity refusal leaves no launch) the
  view says "This space's machine did not start. Try again." at once. Once a
  launch is known, two status reads in a row that show none on its way
  (stopped or offline without a launch, a person's stop, or the machine gone)
  end the wait with the same sentence; one such read, as while a launch is
  replaced, is ridden out, and a status read that fails counts as neither. If
  the machine comes up without `sharedBrowserHost`, Studio takes the legacy
  path at once. A press on a card still waits at most four minutes before it
  offers its button again; the view keeps waiting meanwhile. The browser on
  this device keeps two.
- **A machine that comes up after the press gave up.** When the view says
  "This space's machine did not start. Try again." and, within five minutes of
  that, a runtime status refresh (registration or health) shows the
  conversation's machine as a live host, Studio asks the view once to attach
  by itself, as for a card. That attempt is Studio's own: it may start the
  browser on the machine but never a machine, and it never ends with that
  sentence again, so it cannot repeat. It reads nothing by itself, and it does
  nothing while the view is off, cannot open, is closed, or shows the browser
  on this device.
- **A browser session machine that stopped answering.** On the legacy path,
  after an open ensures the space's browser session machine, Studio waits until
  that machine can take work (a fresh heartbeat) and lists its origin. An
  origin listed for a machine that does not answer (its runtime started again,
  or the controller has not replaced a silent generation yet) is never used:
  connecting to it could only fail. It reads status every 0.5 to 4 s for the
  first minute, then every 10 s, for at most ten minutes, as the cold press
  does, and after a minute says "Still starting this space's machine…". Two
  reads in a row that show the machine stopped or gone end the wait at once
  with "Instafy's browser did not open. Try again." The controller hands a
  silent generation back to an ensure until the machine's idle time (300 s for
  a browser session) has passed since its last heartbeat, and while a job is
  still active on it; once that time has passed, Studio asks for that machine
  again, once and by its id, which replaces the generation when no job holds
  it, and keeps waiting for the new launch. Only the person's own open
  asks again, never an automatic reconnect or Studio by itself.
- **Press on a card.** A press never waits silently. Once the browser view
  shows an error, the card says so at once, in the sentence the view shows
  when it is one of the view's own (such as "Instafy's browser is off."),
  otherwise "Instafy's browser could not open. See the browser for details,
  then try again." On the conversation's own machine the press also reads
  `GET browser/host`, at once when the browser was already open, otherwise
  after 3 s, then every 3 s: a poisoned browser ends the press with the
  restart copy, and one that failed again in a new start (a newer
  `generation` than the one read when the press asked the view to attach
  again) with "Instafy's browser did not open. Try again." The run that had
  failed before is not the press's answer. A browser that was already open but
  shows no page, or whose machine's browser went idle, is stopping or failed
  (after the view had 10 s to start it), is asked once to attach again, as the
  person's own Retry does: it reads the host again, starts it when idle, and
  keeps the last frame meanwhile. A press never attaches again while another
  run or person holds the browser, an open browser that shows its page and
  only waits for the conversation to be idle is left as it is, and an
  automatic start never attaches again.
- **Viewers reconnect within a bound.** A fatal viewer error or a closed
  picture with no other viewer to fall back to schedules a reconnect (at most
  five within a minute, also when a connection succeeds in between) and then
  shows "Instafy's browser did not open. Try again." An error and
  the socket closing after it count once. **Reconnecting…** by itself lasts at
  most 60 s; then the browser says the same and offers **Try again**. The
  abandoned attempt is stopped, so it reads and starts nothing more, and its
  late answer does not bring the wait back. A
  person's press is not cut short this way. An attempt that ends with
  the same connection (a cached grant) leaves a picture that is already back,
  or the error on screen, as it is. A browser that has its connection but waits
  for its roster to know which viewer this participant may use gives up after
  20 s the same way. A capability read that does not answer in 10 s is given
  up and asked again.
- **The same browser, or a restarted one.** The view remembers the host
  `generation` it connected to. A reconnect that finds the host ready with that
  generation keeps its connection and last frame and only reconnects the
  picture. One that finds a new generation while the view reconnected by
  itself stops there with "Instafy's browser is off.", because the pages it
  showed are gone. A person's own **Open browser** or press just opens the
  restarted browser.
- **A machine that comes back under a new origin.** Every exit that ends in
  an error, a restart or a deadline drops the view's connection: the picture
  and input sockets, the collaboration socket, the approval poll and the grant
  refresh all stop, so nothing keeps calling an origin the runtime no longer
  has. A reconnect that reads the runtime with the same id but a new origin
  drops the old connection at once (`browser-session:origin-replaced`). The
  grant refresh keeps the controller's status (`requestAccessTokenResult`): a
  400 (not the runtime's online origin any more, with the code
  `browser_origin_replaced` from controllers that send it) drops the
  connection and looks the runtime up once through the bounded reconnect; a
  404 drops it and stops, with no new look-up, so nothing cold-starts; a 401
  or 403 drops it and shows the failed state; any other failure is asked
  again after 5, 10, 20, 40 and then 60 s. No refresh runs while the view
  shows an error.
- **Only the person starts the machine.** An automatic reconnect never starts
  the machine or its browser: an idle browser is off, a stopped machine is
  off, and the host wait never posts `browser/host/start` for it. An open
  Studio restored by itself (a reload, or a return to a conversation whose
  browser was left open) never wakes the space's machine: it says the browser
  is off and starts the machine only when the person presses **Open browser**.
  It may still start an idle browser on a running machine, for hands-free
  browsing. An open that Studio started by itself (`attachOnly`) never starts a
  machine either. In both, the person's own press or Clear data inside that
  browser does. A press counts for its own attempt only, never for a later
  automatic reconnect or Refresh sessions.
- **Hands-free while off.** While the open view is off on the conversation's
  machine, Studio reads `GET browser/host` at once and then every ten seconds
  (the same reading a waiting card uses) and, once an agent or another viewer
  has the browser starting or ready, attaches again without a press. Only a
  reading asked for after the view went off counts: an older one may show a
  run that has ended, or one from before the machine restarted. It attaches to
  each run of the browser (`generation`) once, never starts the machine, and
  stops reading once the view is no longer off. Studio opening the browser for
  a card attaches an open view that is off or did not open the same way; when
  it asks while the view is still reconnecting by itself, the request waits
  for that attempt and acts once it ends off or failed.
- **Hands-free.** One rule the person can predict: on a space whose browser
  runs on its own machine, Octo's `request_browser` card opens by itself,
  whether that browser runs yet or not. A conversation that names no machine
  (a new space's first one) runs on the space's machine: the one live host,
  when the space has exactly one. Studio opens Instafy's browser by
  itself on the conversation's own machine when that machine is up (a status
  that takes work, whatever its last heartbeat said), has an origin and
  reports `sharedBrowserHost`, and the response says
  `sharedBrowserHostPolicy: "covered"`. On that machine a press is no
  approval, so opening by itself skips no check. It reads `GET browser/host`
  first (a reading that arrived more than five seconds ago is read again, and a
  read that does not answer in ten seconds fails) and leaves the card a button
  when a separate browser session is running, when the machine answers it has
  no browser or the browser is poisoned (only a restart of the machine brings
  it back), or while someone else has it open, controls it, runs an agent in it
  or is starting it. An idle, failed or stopping browser is started by the
  open, as a press would. A card held that way is read again every ten seconds
  while the tab is visible, and opens once the browser is free; a card that
  keeps failing to read, or stays held, stops being read once it is too old to
  open by itself. Studio then opens that exact machine's browser as
  `attachOnly`, so it may start the browser but never the machine, and sends
  the task only once the browser lists that machine's tabs (the turn takes the
  chat's own tab, or a blank one no chat uses, whether the chat's Browser view
  is on screen or not; the tabs are read every 2.5 seconds meanwhile) and a fresh
  `GET browser/host` read after the open says `ready` (and, while the Browser
  view is on screen, once its roster has connected). It waits for each of
  these within the two-minute bound, which also ends a read that has not
  answered, and refuses only on a known conflict: someone else has it open or
  controls it, or another person's run works in it. Opening by itself leaves
  the person in Chat, where the reading line and the Browser tab's dot show
  the turn; only a press switches to the Browser view. A stopped machine, a
  machine without `sharedBrowserHost` and an uncovered space keep the press.
  The person's own Retry or press inside the browser still may start the
  machine.
  Only a draft in the composer holds a card ("Opens by itself once your draft
  is empty.", shown only on a card that would otherwise open by itself, and
  only while the draft holds it); a narrow pane or side-by-side view turned off
  does not, and the browser takes the view as a press does. A card that asks
  to continue in Instafy's browser while that same browser is already open on
  the conversation's machine continues there without a press, even within ten
  minutes of the last automatic start; the declined check, the browser-turn
  check and every check before sending still apply.
- **Cards after a press.** A card says what it is for ("Continue in
  Instafy's browser", and the site it is headed for), never what pressing it
  does: older cards carry a line about that, which is not shown. It reads
  **Opening Instafy's browser…** while it opens and a plain **Opened** once it
  was continued, also after a reload. A card a newer card followed offers no
  button and reads **Not opened**: the newer card carries the task on, so two
  live cards never stack up. The one-line record of a continuation names Octo only when
  Studio opened the browser by itself ("Octo opened Instafy's browser for
  …"); after the person's own press it reads "Opened Instafy's browser for …".
  Either way the browser turn is the card's, and costs nothing unless it did
  something in the browser beyond looking at the page it was given
  ([Credits and Billing](Credits-Billing.md#turns-instafy-starts-by-itself)).
- **Hand-back.** Only a card Octo builds from hands back: the runtime's card
  carries `browserRequest.continueBuilding` when Octo is building something (a
  page, a map) and continues it from what the browser finds, and its
  continuation carries `browserHandsBack`. A card for a question has neither,
  and the browser turn's reply is the answer. When a browser turn that
  continued a building card finishes and read at least one page, Studio sends
  one ordinary turn back to the building lane, "Continue building
  with what the browser turn found.", shown as the notice "Octo continued with
  what it found in the browser" and naming the browser job in
  `continuesFromBrowserJob`. It does so only in the tab that sent both the
  card's prompt and the browser continuation, when nobody wrote after the
  browser turn, the turn succeeded within the last ten minutes and did not
  stop for the person (`request_human_input`, or a step whose approval ended
  the turn), and no draft or manual browser step is pending. The controller
  checks the same chain under the conversation's dispatch fence and stamps
  `browserHandBack` with what the browser turn was asked (at most 2,000
  characters), for a card the routing step posted the message's own words as
  `personRequest` (from that message's job, at most 8,000 characters; the
  building turn reads them as the person's request), its final reply (at most
  6,000 characters) and up to six labelled findings `{url, title, readAt, viewer}`
  (plus `stopped` for a page that was not read: `login`, `captcha`, `paywall`,
  `blocked`, `robots`, `download`, `secret` or `link-only`, and any other reason
  counts as `blocked`): the address and title come from the reply's JSON
  finding lines (only a reply without any falls back to the addresses on its
  lines), `readAt` and `viewer` from the job, and an address on a loopback,
  private, link-local or local-only host is never a finding. Only the person
  who ran the browser turn, and whose turn sent the card, can send it, once per
  browser turn, within 30 minutes, only while no prompt was sent in the
  conversation after the browser turn (`browser_hand_back_superseded`), and
  never as a send-queue entry. Like any turn Instafy starts by itself, a hand-back costs nothing
  unless it ends with Octo's reply
  ([Credits and Billing](Credits-Billing.md#turns-instafy-starts-by-itself)), so it carries
  nothing of the person's: dispatch replaces whatever words it was sent with by Studio's own, and
  refuses one with attachments, as it does one that asks for a browser. It also refuses a
  card without `continueBuilding` (`browser_hand_back_not_building`) and a browser turn
  whose findings name no page it read (`browser_hand_back_nothing_read`). The
  runtime shows that record to the building turn as quoted page data: not the
  person's words, not their consent, and no instruction; the turn says what it
  built with it. Any other browser turn reaches the building thread the same
  way, as data: each building job's lease lists the chat's finished browser
  turns since the building thread's last turn (`browser_turns_since`: the
  newest six of this agent's, never the one a hand-back's record carries, and
  whether older ones were left out), each with what it was asked and its reply
  with its finding lines put back, bounded and labelled like the record. A building turn on a restored thread reads them
  as one section of quoted page data; a new or lost building thread reads them
  in its replay of the chat, each browser turn as one quoted block. A Let Octo
  continue press reads as one line there, not as Studio's instructions in the
  person's name. It takes no
  routing step: its route is decided (build in this chat), and the findings it
  builds from are in its own prompt, which a routing step never sees. So it
  runs in the lane a routed build runs in: it edits the space and ends in plain
  words, with no team plan, goal or lookup of earlier chats to offer. A
  hand-back turn never asks for the browser again: the runtime drops its
  `request_browser` card, leaves the browser rule out of its prompt and its
  reply contract does not offer the card (nor does a browser turn's), and the
  controller still refuses a second hop from an older runtime
  (`browser_hand_back_second_hop`).
  A browser turn that continues a building card is asked to end its reply
  with one finding per page, one JSON object per line, as the browser skill
  writes them. Those lines are for Octo: the runtime takes every line the
  controller would read as a finding out of the reply the person reads, and
  posts them as one note of the turn
  (`details.browserFindings: {pages, pagesRead}`), where the controller reads
  them back after the reply for the record. Studio's Details leaves that note
  out. Unless a finding says a page stopped it, the person reads "Finished
  in the browser." in place of the browser turn's own words: the building turn
  says what it made a moment later, and the browser turn's account of what it
  could not build ("this turn is read-only") is no answer. Those words go into
  the note ahead of the findings, so the record still gives the building turn
  what the browser turn did not read. The fixtures in
  `packages/runtime-controller/src/browser_hand_back_fixtures.json` pin the
  three halves together.
- **Stale pins.** A pin to a session that is gone moves to the space's own live
  browser when there is one.
- **Clear data restarts the same machine.** The controller call is unchanged.
  It stops every managed machine of the space that may hold the profile,
  including this one, then deletes the profile. Studio confirms that this signs
  everyone out and restarts the space's machine, which stops its previews and
  terminals (and running work, when there is some). Studio holds the browser
  runtime claim while the clear runs, so generic recovery cannot relaunch the
  machine before the controller's recheck. Afterwards Studio starts the same
  runtime id again through the cold path instead of asking for a new browser
  runtime.

### What the browser view shows

The view shows one state at a time, derived from its status and the kind of
failure it stored with its error (`hostedBrowserViewState`): one sentence,
at most one button, and a neutral status pill. While opening, the view's
sentence is the one loading signal on screen; the pill says **Starting…** only
to screen readers (`startingShownInView`).

| State | Sentence | Button | Pill |
|---|---|---|---|
| live | none | none | Ready (screen readers only) |
| opening | "Opening Instafy's browser…" | none | Starting… (screen readers only) |
| opening, after a minute of a press starting the space's machine | "Still starting this space's machine…" | none | Starting… (screen readers only) |
| opening, while a browser session machine starts its browser again | "Instafy's browser stopped. Starting it again…" | none | Starting… (screen readers only) |
| off | "Instafy's browser is off." | Open browser | Off |
| failed | "Instafy's browser did not open. Try again." | Try again | Off |
| failed (machine) | "This space's machine did not start. Try again." | Try again | Off |
| blocked | its own: turned off for this space, ask a space builder, the machine must restart, or "Instafy's browser stopped and did not start again. Restart this space's machine to open it." | none | Off |

Off covers a machine or browser that stopped, a browser that started again
while the view reconnected, and a machine without its browser. A view is
live only while it has a connection. Outside live the address field is empty
and disabled, and the collaboration controls stay hidden unless the roster is
known on a connection. The view reports its state to ChatPanel
(`onViewStateChange`), which reads the composer's pages only while it is
opening or live, and tells a waiting card the same sentence. The status pill
says **Unavailable** only for the Personal Browser and the site preview. Every
sentence is short and plain and has no em dashes.

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

The viewer that drives sends its size whenever its view is on screen with its input, unless the browser already took that size: its answer to a resize (`viewport`), or, for a view that could already drive when its input socket connected, the size the origin set then. The origin's `ready` echoes the size a view asked for even when it set nothing (it sets it only for the current driver), so a view that gets its input later sends its size once `ready` is in. A phone's view then re-renders the page at phone width, and a desktop's at desktop size again.

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
destinations. A denied request gets `403` with a fixed body for the person and the
agent reading the page: `destination denied`, the reason when it is one of a fixed
list (such as `prohibited IP` or `port is not allowed`, never the requested host),
and that a site running in the space is seen as a Studio preview
(`instafy preview open`). The listener is loopback-only; request/response headers, resolver
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

- `browser.view` covers capabilities, page metadata, actions, pixels, and the
  browser host's state (`GET /browser/host`);
- `browser.control` covers focus, navigation, pointer, and keyboard input,
  starting the browser host (`POST /browser/host/start`), and reading a page for
  **Send page to Octo** (`POST /browser/pages/:id/capture`, below);
- CDP/WebRTC pixels require `browser.view`; their separate input requires
  `browser.control` plus the live driver lease; RFB requires both and is
  driver-exclusive.

`fs.read` and `fs.write` do not authorize browser routes. See [Shared-Browser-Authorization.md](./Shared-Browser-Authorization.md) for the exact mapping.

The high-level facade rejects privileged schemes, credential-bearing URLs,
unknown fields, oversized values, arbitrary CDP, and raw JavaScript. CDP and
the WebRTC sender remain loopback-only. The egress proxy blocks runtime-local
and control-plane destinations for Chromium navigation. Chromium reports every
CONNECT the proxy does not complete as `net::ERR_TUNNEL_CONNECTION_FAILED`,
whether the policy denied the address, its name did not resolve, or the site
refused or never answered, so the proxy logs each failed destination to its log
(`browser-egress-proxy.log` in the runtime's state directory) as
`browser egress tunnel failed (port 443): the site did not answer in time`: the
request kind, port and a fixed reason, never the host, path or address. A
request Chromium gave up on itself (it navigated away or dropped a speculative
connection) is not a failed destination and is not logged. At most 30 lines a
minute are written; the next minute's first line says how many were left out. The per-origin plus
one-shot confirmation policy above is the sensitive-site action policy for
otherwise public sites; a future denylist may reduce prompt volume but is not
an authorization substitute.

### Send page to Octo

**Send page to Octo** in the Browser toolbar adds a copy of the page on screen to
the person's next chat message, like a paste. `POST /browser/pages/:id/capture`
reads that page once for the person who pressed it:

- It needs `browser.control`, never `browser.view`, so a viewer's polling and
  pixels never carry page text. It does not need the driver lease: reading sends
  no input, so it works while Octo or another member controls the page.
- The origin creates a fresh isolated world in the page's main frame and runs
  `redaction.js` and `pageCapture.js` there, so page scripts cannot reach the
  reader or the masking. Only the masked address, title and text (at most 50,000
  characters, cut after masking) and up to 200 masked web links leave the
  machine, with `readAt` and `Cache-Control: no-store`. runtime-agent's reader
  carries `linkOnly.js` and the skill's link-only list, so a link to a
  link-only site carries the site's name; without the list no links are sent,
  and `javascript:`, `data:` and other non-web links never are. The origin
  refuses an answer whose links the reader could not have produced.
- A secret screen, a page the agent's controller marked withheld (read in the
  page's own world, failing closed), the page a credential step of the agent's
  run opened before the controller marked it (`withhold-next.json` in the
  approval directory, read only; an unreadable record withholds every page) or
  a page whose checks failed answers with `secretScreen: true` and no title or
  text. A tab with no web page, or a page
  that loaded during the read, answers 409.
- runtime-agent supplies the reader (`set_browser_page_capture_script`). An origin
  without it, or one that predates the route, answers 404, and Studio says this
  browser cannot send pages yet. The controller's origin proxy allows exactly
  this path for `POST`.
- Nothing is kept: no marker, approval, listener or agent authority changes, and
  the next press reads again.

Studio stages the copy as a Markdown chat attachment (see
[Chat attachments](Chat-Attachments.md#pages-sent-from-the-browser)).

## Shared profile persistence and clearing

The **Sessions & resume** panel reports controller-owned save metadata. **Login
recovery off** means the project's persistence policy is disabled, not that its
current remote browser cannot be shared. When enabled, a missing snapshot is
shown as not ready; otherwise the panel shows the last acknowledged save time
and whether that snapshot came from the currently selected runtime. An older
snapshot may remain stored after policy is disabled. A failed or incompatible
status request is **unknown**, never assumed to mean enabled or disabled.

`GET /projects/:project_id/browser-profile/status` requires an authenticated
user with project read access, including viewers. It returns only `enabled`,
`lastSavedAt`, and `savedByRuntimeId`, with `Cache-Control: no-store`; it never
reads or decrypts the archive and grants no runtime or input authority. The
panel refreshes while open and visible, suppresses overlapping requests, and
discards responses belonging to a previous account or project. This is a record
of successful stored snapshots, not a live health check of every runtime's
snapshot writer or a guarantee that the latest page changes were saved.

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

### Sign-ins on a browser host

A browser host on the space's own machine (see
[On-demand browser host](#on-demand-browser-host)) uses the same store and
versioned writes, with its own writer state in runtime-agent. The boot-time
persistence above and the host's never run in one process: the host needs
the boot-time browser off, and the boot-time persistence needs it on.

- **Restore before every start.** While the host is down, runtime-agent reads
  the stored version and archive (within 30 seconds) and compares the
  archive's SHA-256 with what this process last stored or sent. If it is this
  process's own last save, or a save whose result was unknown and is now
  settled by that hash, the local profile is used as is. Otherwise the stored
  copy is installed as an exact baseline. If the store cannot be read, a
  process that can still write keeps its local profile; one that installed a
  baseline earlier keeps it with saves off; one with neither starts with an
  empty profile (removed without following symlinks).
- **Saves while Ready.** Every `INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS` (the
  controller sets 30 for covered spaces) the profile is packed and uploaded
  when it changed. What each upload sends is recorded before it is sent. A
  save that first has to settle an unknown result gives up its read as soon
  as the host stops being Ready, so it never delays the stop's own save.
- **Saves at every stop.** An idle or explicit stop first ends the periodic
  saves and waits for an upload in flight (it is never aborted). It then
  closes Chromium over CDP (`Browser.close`, with the private Node and
  Playwright and only `PATH` in the environment), waits up to 5 seconds for
  the host to report that Chromium exited, and only then packs and uploads.
  Only an `exited chromium` status line that comes before any other final
  line confirms the close (with exit status 71 when the host's exit arrives
  first); another child's exit, a killed host or a missing line does not. A
  close that cannot be confirmed falls back to SIGTERM and never packs a
  live profile. A host stop does not end saving: later starts in the same
  process save again.
- **The runtime's shutdown** does the same within its 10-second budget,
  before the runtime stops itself. If a periodic upload is still running when
  the budget ends, there is no final save. The final upload is bounded by the
  remaining budget, and nothing saves after it. With no host running, a
  profile whose last stop confirmed the close is saved once more, so a stop
  save that failed or stayed unknown is retried (nothing is sent when it is
  unchanged).
- **Results.** A 409 means another writer won: saving stops until the next
  start installs the stored copy. A refusal (400, 401, 403, 404, 413 or 428)
  stored nothing, so the writer is kept. That same copy is not sent again,
  except after a 401, which concerns the agent's token or lease rather than
  the copy. An unknown result (network error, timeout, 5xx or an unexpected
  acknowledgement) stays recorded and is settled by the next save's read or
  the next start, by comparing hashes. Unlike the boot-time persistence, one
  uncertain save does not stop saving for the process.
- **Its own late writes.** The process remembers the last few copies it sent
  since the local profile last came from the store. If the stored copy is one
  of them (an upload settled as not landed that committed later, so the
  resend got a 409), it is recognised as the process's own: the newer local
  profile is kept, and the next save sends it on top.
- **No save** after a poisoned host or for a deleted space: the last
  successful save stands.
- **Cookies without an expiry.** Chromium keeps a cookie that has no expiry
  across a clean close only when it continues its last session. The host
  therefore writes `session.restore_on_startup = 1` into the profile's
  `Default/Preferences` on every start, next to the download block. Neither
  preference is packed, so tabs open at a stop reopen at the next start only
  within the same container. Sign-ins a site meant to end with the browser
  ("don't remember me") are therefore kept, on later machines too, until
  Clear data. The `--lazy` image smoke requires a persistent cookie and one
  without an expiry to survive a clean close and the next start, both on the
  same profile directory and on a fresh one holding only the packed files.
- **Loss window.** A controller- or provider-initiated machine stop fences
  the lease before the runtime's shutdown, so its final upload is refused.
  A sign-in made less than about one save interval (plus Chromium's own
  cookie commit delay of about 30 seconds) before such a stop can be lost.
  The host's own idle stop saves while its lease is active.

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
while deletion is in flight. For Instafy's browser on the space's own machine,
the clear stops that machine too (it may hold the profile), and the fresh
browser is that same machine started again under its runtime id (see
[How Studio opens it](#how-studio-opens-it)).

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
never the path or contents. Connecting from the Your AI panel keeps an available Instafy AI the
default, so the proof then presses Make default on the new connection before its turn. Disable
traces, video, and automatic screenshots before exercising this flow, use disposable local accounts
and projects, and verify that the turn is recorded as BYOC with no managed-credit debit. Hosted canary accounts and orchestration are deployment-private.

The runtime entrypoint gives a newly launched headed Chromium up to 30 seconds to answer on its CDP
port, and stops waiting as soon as that process exits. The first launch on a cold machine is the
slow one; later launches are ready in under a second. On success it logs
`[instafy] Headed Chromium ready (CDP) on 127.0.0.1:<port> after <seconds>s`. Otherwise it writes
`/tmp/instafy/playwright/chromium-warning.txt` saying whether Chromium was still running at the
deadline (it is then stopped) or exited, with its exit status. `INSTAFY_CHROMIUM_CDP_READY_TIMEOUT_SECS`
changes the wait for the boot-time launch (whole seconds, clamped to 1 to 300). The relaunch after
a persisted-profile restore runs through runtime-agent's helper environment allowlist, so it always
uses the 30-second default. That launch happens after registration and before the first heartbeat,
and the default keeps it inside the controller's 60-second heartbeat window for queued-job recovery.

### When the boot-time Chromium exits

On a browser session machine (`INSTAFY_ENABLE_BROWSER_SESSION=1`, no lazy browser host) the
entrypoint launches Chromium once, and runtime-agent keeps it running (`boot_browser.rs`). Once it
has seen Chromium run, it checks the process every two seconds (by pid and start time, so a reused
pid is not taken for the browser). When Chromium exits it starts it again through
`runtime-entrypoint launch-chromium`, the same launcher the profile restore uses, under one lock so
the two never launch at once:

- after 1, 5, 15, 30 and then 60 seconds for exits in a row; a browser that ran for two minutes is
  healthy again, and its next exit waits 1 second;
- at most 5 starts in any 10 minutes. Past that it gives up: it writes
  `/tmp/instafy/playwright/chromium-warning.txt` ("Instafy's browser stopped again after 5
  restarts in 10 minutes and was not started again. Restart this machine to open it.", a start
  that did not come up counting as one) and starts nothing more until the machine restarts. A browser something else starts (a profile restore) is watched again.

While Chromium is not running, origin's page, page-command, pixel and input routes answer 503
before any CDP request or WebSocket upgrade: `browser_restarting` with `Retry-After: 2` while it
starts again, and `browser_stopped` once the watch gave up. Studio reads the pages once before it
connects a view to such a machine: while the browser restarts the view says "Instafy's browser
stopped. Starting it again…" and reads every two seconds, for up to two minutes, then connects; once
the machine gave up it says "Instafy's browser stopped and did not start again. Restart this space's
machine to open it." with no Try again. An origin without these codes, or any other answer, lets the
view connect as before. A Shared Browser job sent to a machine whose watch gave up is refused with
the same reason instead of starting a turn without a browser.

Each step is one log line with an `event` field, so the machine's logs say which of two things
ended a browser that "did not open":

| `event` | When | Fields |
|---|---|---|
| `chromium_exited` | Chromium exited by itself | `pid`, `status` (its exit status or signal, such as `killed by signal 9 (SIGKILL)`, when runtime-agent is its parent and reaps it), `uptime_secs`, `oom_kills_since_watch_start` (the memory cgroup's OOM kill count since the watch began), `agent_run_active` |
| `chromium_restart_scheduled`, `chromium_restarted`, `chromium_restart_failed`, `chromium_restart_gave_up` | the watch's restarts | `delay_ms`, `pid`, `restarts_in_window` |
| `runtime_exit` | runtime-agent exits with status 70 because a turn's end could not confirm its browser tools stopped | `cause` (`unconfirmed_tool_shutdown`, or a marker or approval cleanup that failed), `reason` (`run_deadline_before_shutdown`, `run_cancelled_before_shutdown`, `codex_shutdown_unconfirmed`, `mcp_processes_not_gone`, ...), `run_id`, `exit_code`, and `chromium`: the watch's last view of the browser (`running (pid N)`, `restarting`, `stopped`) |

On a lazy browser host the same unconfirmed end logs `event = "browser_host_poisoned"` and closes
the host instead of ending the process. A Chromium that is alive but no longer answers on CDP is not
detected by the watch.

### On-demand browser host

Both runtime images also carry the stack for a browser that starts only when it
is needed, on the space's own machine. `runtime-entrypoint start-browser-host`
starts the egress proxy, X/VNC, the window manager, Chromium and, with
`INSTAFY_BROWSER_WEBRTC_ENABLED=1`, the WebRTC sender. Only runtime-agent calls
it, and only on a lease the controller attested as a browser host (see
[Browser on the space's own machine](#browser-on-the-spaces-own-machine-controller-policy)).
Elsewhere it is inert: the boot path and the boot-time Shared Browser are
unchanged, and a machine that never opens a browser runs no browser process. The base image
keeps its earlier boot behaviour too: with `INSTAFY_ENABLE_BROWSER_SESSION=1` it
may start the egress proxy but starts no display or browser at boot, because
it carries that stack only for the on-demand host.

The caller passes every location and port in the environment
(`INSTAFY_BROWSER_HOST_HOME`, `_PROFILE_DIR`, `_STATE_DIR`, `_DISPLAY`,
`_CDP_PORT`, `_VNC_PORT`, `_EGRESS_PORT` and, for WebRTC, `_WEBRTC_PORT`). The
display and ports must differ from the boot-time defaults (`:1`, 5900, 9223,
9225, 9226). The profile directory is used as given and never wiped, so a
persisted profile keeps its sign-ins across starts; a stale Chromium lock from
another machine is cleared, and a profile that a running Chromium holds is
refused. Chromium uses `--password-store=basic`, so a persisted profile's
cookies are encrypted the same way on every machine and image. Each start
also sets the profile to continue its last session, so Chromium keeps
cookies without an expiry across a clean close. One host runs per
state directory at a time; a second start for it fails with `host_in_use`. Each
start launches fresh processes: the host never reuses pid files, deletes X
locks or kills processes it did not start, and an occupied display or port
fails the start instead of being taken over.

The host leads its own process group at nice 10 with OOM score 1000, so the
workspace keeps priority and signalling the group stops the whole browser,
including Chromium's own helpers. Its children get the same positive
environment allowlists as the boot-time helpers, and the WebRTC sender never
receives `INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON`; it takes ICE servers from
each offer. A host started with that variable re-executes without it, so it is
not left in the host's own process environment either. The caller still owns
the rest of the host's environment and should pass only the settings above.
Chromium runs Debian's real binary rather than its `/usr/bin/chromium` wrapper
(Playwright's Chromium in the webdev image), with a capped HTTP cache
(`INSTAFY_BROWSER_HOST_DISK_CACHE_MB`, 64 by default).

The host prints one status line on stdout: `ready` with its display, ports,
WebRTC state, render scale and start time; `failed <reason>` (`config_invalid`
64, `port_reserved` 65, `display_in_use`/`port_in_use`/`profile_in_use` 66,
`host_in_use` 66, `stack_missing` 67, `egress_unavailable` 68, `display_failed`
69, `chromium_failed` 70, `host_error` 72 for any other failure such as a full
disk); `exited <child>` (71) when the egress proxy, X server or Chromium stops on
its own; or `stopped` after SIGTERM. Publication and the image scan require
`scripts/runtime-image-browser-smoke.sh --lazy` for both flavors: the image must
boot with no browser process (the base image also with the browser session on),
and the host must start on the agent's own root and ports with WebRTC off,
keep a persistent cookie and one without an expiry across a close with the
agent's CDP close helper, and start again on that profile and on one holding
only the files the agent packs.

On an attested lease, runtime-agent supervises the host with one actor that
owns the child and makes every state change:

- **Fixed settings.** Display `:47`, CDP 19223, RFB 15900, egress proxy 19226,
  no WebRTC port. Its directories are `/var/lib/instafy/browser-host/{profile,home,state}`
  in the container's writable layer (not a workspace volume, and not `/tmp`,
  which model tools clean), created with mode 0700; a symlink there, or at
  `/var/lib/instafy`, fails the start closed. Chromium is the pinned `/usr/lib/chromium/chromium` when
  present, and the render scale is the launch value of
  `INSTAFY_BROWSER_RENDER_SCALE`.
- **Environment.** The host starts from an empty environment: the helper
  baseline without `HOME`, the egress, viewport, ad-block, render-scale, VNC
  geometry and CDP-timeout settings, and the locations, ports,
  `INSTAFY_BROWSER_EGRESS_ISOLATION=1` and `INSTAFY_BROWSER_WEBRTC_ENABLED=0`
  that the agent sets itself. It never receives relay credentials, the
  unsafe-dev egress override, `RUNTIME_*` settings, `NODE_PATH` or a token. The
  host leads its own process group.
- **States.** `idle`, `starting`, `ready`, `stopping`, `failed` and `poisoned`,
  with a new generation per start. A start is single-flight and never waits:
  the host has 75 seconds to print `ready` with exactly these ports, the
  egress proxy on 19226 and `webrtc=off`, or it is killed and fails with
  `start_timeout` or `host_error`. A host that ends on its own reads
  `stopping` until its group is confirmed gone, then `failed`.
  A failure keeps the host's reason, or `exited_<child>` (egress proxy,
  display, Chromium), `spawn_failed` or `unconfirmed_shutdown`. The next start
  after a failure runs a new generation; the container stays up.
- **Stops.** A stop sends SIGTERM (the host stops its group), kills the group
  after 10 seconds, and confirms the group is gone. With sign-ins kept
  (below) a stop first closes Chromium over CDP and saves the profile once
  Chromium's exit is confirmed. A Ready host with no
  Shared Browser job and no use for 15 minutes stops on its own; opening it,
  any viewer activity and the end of a job count as use. The idle stop
  decides and moves to `stopping` in one step, so it never lands under a job
  that was admitted. Registration renewals
  never stop it. The runtime's shutdown stops it within 10 seconds after origin
  went down; a deleted space kills it at once.
- **Fail closed.** When a Shared Browser turn ends without confirmed tool
  shutdown, a lazy host is poisoned instead of the runtime exiting: its group
  is killed, it refuses every start until the process exits, and the
  agent-control marker stays, so origin keeps refusing human input. A group
  that outlives its host by 5 seconds poisons it too.
- **Profile.** With `INSTAFY_BROWSER_PROFILE_PERSIST=1` (always set for a
  covered space), every start restores the space's stored profile, saves run
  while the host is Ready, and every stop saves after a clean close, so
  sign-ins survive idle stops and machine restarts (see
  [Sign-ins on a browser host](#sign-ins-on-a-browser-host)). An idle stop
  never wipes the profile.
- **Jobs.** A Shared Browser job holds the host for its whole run (taken
  before the readiness check) and is refused with "Instafy's browser is not
  open on this space's machine. Open it, then try again." while the host is
  not Ready. The action log is emptied at a start only when no job holds the
  host, and only when it is a regular file with one link (never a symlink,
  hard link or FIFO). The Codex Shared Browser MCP runs with the private Node
  (`INSTAFY_SHARED_BROWSER_NODE_BINARY`, which accepts only `/usr/bin/node` or
  `/opt/instafy/browser-host/bin/node`), and model shells never see that
  setting.

#### Host endpoints

Origin serves the host only when the process that runs it hands it one
(runtime-agent, through `OriginHttpServer::set_browser_host`). Desktop, the
boot-time Shared Browser and the multi-tenant gateway have none: there
`/browser/host` and `/browser/host/start` answer 404 with the code
`browser_host_absent`, and every other browser route behaves as before. The
code tells origin's own answer apart from a 404 that the controller (its
`browser_host_policy_off`) or anything else in front of origin gives.

- `GET /browser/host` (`browser.view`, `Cache-Control: no-store`) answers
  `{"version":1,"mode":"lazy","state":"idle|starting|ready|stopping|failed|poisoned","generation":"<uuid>|null","failure":"<token>|null","startedByYou":false,"othersPresent":false,"controlledByOther":false,"agentRunActive":false,"agentRunStartedByYou":false}`.
  `generation` is new for every host start. `failure` is set only in `failed`
  or `poisoned`, and only to a known token: a start reason above, or the
  agent's `exited_egress_proxy`, `exited_display`, `exited_chromium`,
  `exited_unknown`, `start_timeout`, `spawn_failed` or `unconfirmed_shutdown`;
  anything else reads `host_error`. The flags are relative to the caller and
  name nobody: `othersPresent` means a collaboration participant with another
  subject, or another subject the agent saw in the last 30 seconds (which
  outlives an origin restart); `controlledByOther` means a person with another
  subject holds control; `agentRunActive` follows the agent-control marker and
  is true when the marker cannot be read; `agentRunStartedByYou` means the
  active run is the caller's. The same person on several tabs counts as the
  caller.
- `POST /browser/host/start` (`browser.control`) takes exactly
  `{"version":1}` (unknown fields and other versions are 400, more than 1 KiB
  is 413). It never waits for the browser: it answers 200 with the same body
  when the host is already ready and 202 otherwise, and the caller polls
  `GET /browser/host`. It answers 409 `machine_stopping` while a pre-stop
  flush holds the machine's stop fence, and 409 `browser_host_poisoned` or
  `browser_host_stopping` when the host refuses, each with a fixed message.
- With a host, `/browser/pages`, the page focus and command routes, CDP
  screencast, the input socket and RFB answer 503 `browser_host_not_ready`
  with `Retry-After: 1` until it is ready, before any CDP request or WebSocket
  upgrade. Capabilities, actions, approvals, collaboration and the WebRTC
  offer stay available. The controller's proxy accepts a WebSocket upgrade
  before it reaches origin, so a client behind it sees the screencast, input
  or RFB socket close instead of the 503: open those sockets only once
  `GET /browser/host` reports `ready`.
- Joining collaboration, every accepted collaboration frame (heartbeats
  included), page reads and commands, and the pixel and input sockets count
  as a use of the browser for the host's presence and idle clock. Reading
  `GET /browser/host` does not.

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

- Evaluate further risk-based prompt reduction only after deployment evidence;
  keep one-shot confirmation for the named risky steps, commit buttons,
  submissions and activation keys in every mode.
- On the space's own machine, let a person choose Ask for their runs (a
  downgrade the runtime honours, never an upgrade), show in Studio that a run
  started in routine browsing, and give the routine start a kill switch of its
  own; today turning it off means turning off the browser host policy or
  shipping a new runtime image.
- Under routine browsing, a plain link whose address has side effects but is
  not on the risky-address list still opens without a prompt.
- Prove TURN and forced-relay WebRTC from signed Electron and normal web clients.
- Turn the shipped CDP frame/relay telemetry into capacity alerts and limits before considering a new direct media path.
- Close the profile snapshot's sub-30-second hard-kill edge and add per-user private keys for a private tier.
- Run the responsive proof on real iOS Safari and Android Chrome hardware; the current automated phone/tablet matrix uses Chromium viewports plus a real Electron window at phone dimensions.
