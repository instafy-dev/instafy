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
requests to browser tools. In a single Browser view, a browser task needs a live page;
if no page is available, the composer keeps the message instead of submitting an invalid browser job.
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

Without an exact resume target, one eligible live Shared session is reused;
multiple sessions require an explicit choice. A missing target and failed
discovery never silently allocate or select a different browser. Reconnects stay
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

The Studio always owns the address bar, Go/history controls, status, errors, action ticker, and AI cursor. The runtime owns the page and profile.

Connection failures show brief recovery guidance. If the runtime provider is not configured,
the message explains that browsing needs setup; **Technical details** keeps the original error
available for troubleshooting without making it the main instruction. Retry remains available.

On narrow screens and split panes, the address bar keeps participant avatars on its
right. Open the avatars to see the participant list, where a cursor icon marks the
current controller. **Request control** appears below the list; this
asks the current driver to hand over input, rather than sending a chat message.
Pending requests show a badge for the current driver. A compact page-count picker
beside the address switches browser tabs. **Browser options** contains history
navigation, reload and **Expand browser** so the toolbar stays on one row. AI
takeover and **Let AI continue** are in the same participant controls;
clicking the shared page can still open the takeover confirmation.

Personal and Shared Browser use one `BrowserAddressField` and the common Instafy
`Input`, `Button`, `IconButton` and `Checkbox` primitives for their address, actions
and settings. Navigation state, permissions and control ownership stay in each
browser controller; the shared components supply consistent themes, keyboard focus
and touch targets.
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
the destination can be read. Origin approval does not authorize an action.

In the default **Ask** mode, every navigation, click, type, form submission, and key press receives a
separate one-shot action prompt bound to the run, runtime generation, page,
fresh snapshot/target where applicable, destination, and payload fingerprint.
The default-focused action is **Deny**. Only the initiating user with live
`browser.control` authority can decide; another teammate, another page, an
expired request, or a replay cannot satisfy it. Scroll is allowed only after
the page origin has been approved because it changes no remote state. Typing
authentication, payment, or identity secrets remains blocked outright and is
not made possible by approval.

In Ask, the first site prompt also offers **Always allow routine browsing for this turn**
when the runtime advertises `approvalModes: ["ask", "routine"]`. This is an
explicit grant across HTTP(S) sites for the exact current run, initiating user,
runtime generation and selected page—not permanent site trust, a project-wide
default, or permission inherited by the next turn. A run on the space's own
machine starts with the same grant, scoped the same way. Under routine browsing,
ordinary navigation, clicks, non-sensitive field filling and non-activation keys
proceed without another site/action prompt, including an address typed for a
site the run has not used yet. Steps in a named risk category (below), risky
addresses, form submissions, buttons whose label commits a change (such as
Save, Speichern or Buchen, even when page script runs them without a form), and
Enter/Space activation still require one-shot confirmation. Menu items, tabs,
tree items, disclosure and menu openers and navigation items are navigation: a
commit word in their label (such as Neue Rechnung, Start or Neu) does not make
them ask. A control of any kind whose label records, finalizes or pays
(Festschreiben, Buchen, Speichern, Als bezahlt markieren, Mark as paid, Delete)
is consequential and still asks; a menu item that only names a list
(Buchungen, Zahlungen) stays navigation. Secret entry,
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

A control with no accessible name or visible text is named from its own
hints rather than its index: a tooltip attribute or described-by text, its
image's alt text or svg title, a generic noun for its icon, and where it sits,
for example "profile picture button in the top right". The name is masked like
any other control name before it reaches a snapshot, a prompt or the action
log.

Routine mode deliberately relaxes universal confirmation. Its consequence
classifier uses page descriptors and URL text; it cannot prove that arbitrary
website JavaScript has no side effects or recognize every language/custom control.
A plain link whose address has side effects but is not on the risky-address list,
a control with neither a risky nor a commit word in its label, or a menu item,
tab or navigation item whose only risky word is a commit word outside the
consequential list (such as "Neu" or "Weiter" in a menu), can still act without
a prompt. **Ask** reviews every state-changing interaction; a run on the
space's own machine cannot be switched to it yet (see "Remaining work").

### Redaction, step categories and downloads

The controller embeds the private workspace package
`@instafy/browser-action-policy` (`redaction.js` and `actionPolicy.js`), the same
plain scripts the Desktop Personal Browser uses. runtime-agent compiles the
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

**Refused in every mode, before any prompt.** Revealing or copying a credential
(`step_refused_secret`), sign-in submits, identity-provider sign-in buttons and
typing a sign-in form's account identifier (`step_refused_sign_in`), and file
inputs (`step_refused_upload`). Before a key change or "may show a secret" step
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
only on the conversation's own machine in a space the controller covers, and
only while nobody else has that browser open, controls it, runs in it or is
starting it (see "How Studio opens it" below and
[Browser Profiles](Browser-Profiles.md)). It never starts, stops or replaces a
machine for this, and every other card waits for the person's press. The
continuation is an ordinary Shared turn with consent version `1`. On the space's
own machine it starts in routine browsing, as every run there does (see "Human
approval policy" above); elsewhere it starts in **Ask**, with the per-run origin
approval, and **Allow routine browsing** stays the person's own choice. Studio
never answers a site or action prompt for the person, and neither Studio nor the
job metadata chooses the starting mode. Under routine browsing, steps in a named
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

A denial, an unanswered prompt, a stale request, revocation, storage failure, or
malformed approval protocol is terminal for that browser run. The runtime latches
the failure, rejects later mutations without opening another prompt, and reports
machine-readable terminal-consent state so the job layer does not invoke its
normal missing-action retry. The user starts a new turn if they want to try
again. This keeps “Deny” from becoming a sequence of repeated consent prompts,
and an unanswered prompt from becoming a chain of prompts while the person is
away. What the person reads tells the two apart, with no code: an unanswered
prompt reads "I'm waiting for your OK to continue in Instafy's browser. I
haven't done that step yet.", a denial reads "You declined, so I stopped before
that step.", and every other terminal code reads one plain message. Each speaks
only about the step that asked, because earlier steps of the same turn may
already have opened pages or changed something. The code stays in the run's
`browser/terminal-consent` artifact. The tool result tells
the model that an unanswered prompt is not a denial and that it must end the
turn without retrying.

A run also stops when Instafy's browser goes away under it. The controller
exits with code 75 when it cannot connect to the browser over CDP, when the
run's own tab is gone, or when Playwright reports that the tab or browser
closed during the command; the runtime judges that by the exit code alone,
never by error text a page could shape. Two such tool calls in a row latch the
terminal code `browser_unavailable` like an approval code: later calls do not
start the controller, status reports `ready: false`, the tool result tells the
model to end the turn, and the person reads "Instafy's browser closed or
stopped responding, so I stopped there. Open the browser again and send a
message to continue." One failed call followed by any other answer starts the
count over, so a single slow connect does not end a turn.
If the client temporarily loses its network, it retains the exact visible
request, shows reconnecting state, and retries the bounded poll/decision path;
the origin's one-use fingerprint and replay checks remain authoritative.

The agent controls the page through one runtime-owned, required MCP server:

```text
instafy_shared_browser.status
instafy_shared_browser.snapshot
instafy_shared_browser.navigate / click / type / press / scroll
instafy_shared_browser.request_human_input
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

A browser that has just started, such as the on-demand browser on a space's own
machine, shows exactly `about:blank`, and a tab opened in the viewer shows the
new-tab page (`chrome://newtab/` or `chrome://new-tab-page/`). `status` and
`snapshot` report these pages as `blank: true` with a constant, empty
observation: nothing is read from the page, no origin is approved, no action can
target it, and the observation is not written to the action log, so it is not
evidence of browser work. A turn that stops on a blank page is retried once with
the instruction to call `navigate` with the task's address, which asks for that
site's approval as usual. Every other page without an http(s) origin (`data:`,
`about:srcdoc`, a blank page with a fragment, other browser-internal pages)
still fails closed with `[origin_not_approvable]`. That error is not a consent
decision and does not end the run; it tells the agent to navigate first. Neither
Studio nor the runtime opens a card's site on its own; the card's hosts are only
shown to the person.

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
shrinks only the visible area. The app's open Keyboard input bar reserves its
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
**Let AI continue** then appears in the existing toolbar. Reduced-motion
preferences use a static edge glow. Agent-requested handoff
uses `request_human_input` with one to eight indices from a fresh snapshot. The
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
is not release proof. **Let AI continue** explicitly starts a new turn on the same
runtime/page with a fresh observation. It sends only a fixed continuation message,
never the user's entered values. Account, conversation, runtime or page changes
invalidate the continuation. Manual navigation drops stale field guidance but
keeps the manual-step controls, so login redirects can finish before continuation starts
a fresh turn. A target change during asynchronous continuation aborts it; no
hidden or stale completion may send it automatically.

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
and WebRTC drivers also get an explicit **Keyboard** control. It opens a local
16px text field so iOS/Android can summon their software keyboard, then sends
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
  `{"version": 1}`, then polls every 500 ms until the browser is ready (at most
  120 s). A viewer is told to ask a space builder, and a poisoned browser says
  the space's machine must restart first. A state Studio does not know is
  polled like `starting`. Studio never ensures, recycles or stops a runtime for
  this. It lets go of the browser runtime claim once the first status read
  shows the space's browser, so generic recovery keeps the space's machine up.
  **Start new session** and the runtime-limit takeover are hidden.
- **Pages while it starts.** The origin answers 503 `browser_host_not_ready`
  until the browser runs. An open browser keeps polling quietly, for at most
  120 s of unbroken `browser_host_not_ready` answers (token and gateway
  failures, as while the machine itself starts, are not counted). Each open
  counts its own run, so closing the browser and opening it again starts over.
  After that the
  address bar reads "Instafy's browser did not start. Try again." in place of
  "Connecting to Shared Browser…", and a card waiting on it says the same. A
  page read that does not answer in 10 s is given up and asked again. A hidden
  one suspends as before, so an idle browser behind a hidden tab is never polled
  and never started. Only the open browser view starts it.
- **Bounded requests.** Each `GET browser/host` and `POST browser/host/start` of
  the 120 s wait ends after 10 s, or at the end of the wait, and is polled again
  like a gateway error, so a hung request cannot outlast the wait.
- **Cold press.** When the space is covered and a press finds nothing to open,
  or the exact pin names the space's own machine while it is stopped or no
  longer listed, Studio first starts that machine through the generic hosted
  ensure. It then polls status every 2 s, for at most 180 s, until the machine
  can take work. It waits on the pinned machine or the conversation's machine
  only when that is the space's own Instafy Cloud machine, never a Desktop,
  self-hosted or separate browser session machine; otherwise it waits for the
  first live host. If the machine comes up without `sharedBrowserHost`, Studio
  takes the legacy path at once. A press for Instafy's browser may take up to
  four minutes in all; the browser on this device keeps two.
- **Press on a card.** A press never waits silently. Once the browser view
  shows an error, the card says so at once: in that error's words when they are
  plain (such as "This space's machine is stopping. Try again in a moment."),
  otherwise "Instafy's browser could not open. See the browser for details,
  then try again." On the conversation's own machine the press also reads
  `GET browser/host`, at once when the browser was already open, otherwise
  after 3 s, then every 3 s: a poisoned browser ends the press with the
  restart copy, and one that failed again in a new start (a newer
  `generation` than the one read when the press asked the view to attach
  again) with "Instafy's browser did not start. Try again." The run that had
  failed before is not the press's answer. A browser that was already open but
  shows no page, or whose machine's browser went idle, is stopping or failed
  (after the view had 10 s to start it), is asked once to attach again, as the
  person's own Retry does: it reads the host again, starts it when idle, and
  keeps the last frame meanwhile. A press never attaches again while another
  run or person holds the browser, an open browser that shows its page and
  only waits for the conversation to be idle is left as it is, and an
  automatic start never attaches again.
- **Viewers reconnect within a bound.** A fatal viewer error with no other
  viewer to fall back to schedules a reconnect (at most five within a minute,
  also when a connection succeeds in between) and then shows "Browser session
  disconnected. Click Retry to reconnect." An error and the socket closing
  after it count once. A browser that has its connection but waits for its
  roster to know which viewer this participant may use gives up after 20 s
  with "The browser did not finish connecting. Try again."
- **Only the person starts the machine.** An open Studio restored by itself (a
  reload, or a return to a conversation whose browser was left open) never
  wakes the space's machine: it says the machine is not running and starts it
  only when the person presses Retry. An open that Studio started by itself
  (`attachOnly`) never starts a machine either. In both, the person's own
  Retry or Clear data inside that browser does.
- **Hands-free.** For Octo's `request_browser` card, Studio opens Instafy's
  browser by itself only on the conversation's own machine, when that machine
  is live, can take work, has an origin and reports `sharedBrowserHost`, and
  the response says `sharedBrowserHostPolicy: "covered"`. It reads
  `GET browser/host` first (a reading that arrived more than five seconds ago
  is read again, and a read that does not answer in ten seconds fails) and
  leaves the card a button when a separate browser session is running,
  when the browser is poisoned or failed, or while someone else has it open,
  controls it, runs an agent in it or is starting it. A card held that way is
  read again every ten seconds while the tab is visible, and opens once the
  browser is free; a card that keeps failing to read, or stays held, stops
  being read once it is too old to open by itself. Studio then opens that exact
  machine's browser as `attachOnly`, so it may start the browser but never the
  machine, and sends the task only once the browser shows that machine's first
  page, the browser's roster has connected and a fresh `GET browser/host` read
  after the open says `ready`. It waits for each of these within the two-minute
  bound, which also ends a read that has not answered, and refuses only on a
  known conflict: someone else has it open or controls it, or another person's
  run works in it. A stopped machine, a machine
  without `sharedBrowserHost` and an uncovered space keep the press. The
  person's own Retry or press inside the browser still may start the machine.
  Only a draft in the composer holds a card ("Opens by itself once your draft
  is empty.", shown only on a card that would otherwise open by itself, and
  only while the draft holds it); a narrow pane or side-by-side view turned off
  does not, and the browser takes the view as a press does. A card that asks
  to continue in Instafy's browser while that same browser is already open on
  the conversation's machine continues there without a press, even within ten
  minutes of the last automatic start; the declined check, the browser-turn
  check and every check before sending still apply.
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

- `browser.view` covers capabilities, page metadata, actions, pixels, and the
  browser host's state (`GET /browser/host`);
- `browser.control` covers focus, navigation, pointer, and keyboard input, and
  starting the browser host (`POST /browser/host/start`);
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
never the path or contents. Disable traces, video, and automatic screenshots before exercising this
flow, use disposable local accounts and projects, and verify that the turn is recorded as BYOC with
no managed-credit debit. Hosted canary accounts and orchestration are deployment-private.

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
