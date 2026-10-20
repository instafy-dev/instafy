# Browser profiles and login continuity

A browser's **profile** owns its cookies and site data. Its **runtime** is where
the page executes. Its **viewer** is how you see and control that page. These are
different choices: a native Desktop window can display a remote Shared Browser,
and Personal Browser uses a runtime-agent that runs locally on your device.

## Choose the profile, not just the viewing device

| Profile | Page execution | Who shares its login state? |
| --- | --- | --- |
| **This device** | Electron's bundled Chromium on your computer | Stored for your Instafy account across projects on this device. Explicitly approved tab control or Explore can use that account; the profile stays local. |
| **Workspace browser** | Chromium in the managed project runtime | Project members viewing that same browser, including from web, mobile, and Desktop. Input still requires control permission. |
| **Fresh — no saved logins** | A fresh headless Chromium context on an explicitly enabled self-hosted Linux runtime | Nobody inherits a previous login. The owner-local observation tool starts fresh for each call. |

Studio's location menu offers **This device** and **Workspace** behind one
computer or globe icon. The local tab starts private; **Private** opens its
audience picker and becomes **Sharing** while shared. These labels describe who
can view the tab; private does not mean incognito or erase saved logins.
The location menu explains which profile and account state each option uses.
Fresh is a tool capability, not an interactive browser option in that selector.

Personal is separate from installed Chrome, Safari, and the system browser used
for OAuth. It imports neither their profiles nor their cookies. Opening the
Shared Browser does not copy Personal logins into it, and the fresh observer
cannot import either profile.

## Opening and continuing a browser task from Chat

Octo opens Instafy's browser on its own whenever a web page would help: to look
something up, to check a page, or to walk the person through a provider's screens.
Every interactive Chat turn carries that rule, whichever skills it loaded. When an
interactive browser is not attached to the turn, Octo returns an **Open browser and
continue** card. In the desktop app, for a person on their own AI connection, Studio
presses it by itself once the turn is finished, in the browser on this device. Everywhere
else, including Instafy's hosted browser on the web, the card waits for the person's
press. Either way the task goes to that exact browser once it is ready, and the chat
records a one-line notice ("Octo opened Instafy's browser at dashboard.stripe.com") in
place of the task, which the record keeps as the dispatched prompt. Studio starts a card
by itself only:

- in the desktop app's browser, for a person on their own AI connection. It never opens
  Instafy's hosted browser by itself: the controller does not record who started a
  running browser session, so Studio cannot tell the person's own session from a
  teammate's, and opening a new one would start a machine or switch the space's own
  machine to the browser, which stops whatever it still runs, such as a preview, a dev
  server or a terminal session, and Studio cannot see those;
- in the tab whose prompt started the run that sent the card, by the person who sent
  it; never for history, another viewer or device, a reload, an automation, a space
  review or a multi-agent worker;
- for the newest card, within ten minutes, with nothing written after it, and never
  for a card a browser turn sent;
- for addresses the person could have seen: in their own messages, or in replies of the
  conversation they could read from before the turn that sent the card. A skill setup's
  address counts once a reply has shown it. Tool output, status lines, reasoning, request
  cards and hidden rows do not count. An address Octo read on a page or in a tool's
  output, such as a search result, leaves the card to the person, who sees its host
  first, and so does an address Studio cannot compare: localhost, an IPv6 literal, an
  internationalized host, a host written with a fullwidth dot, or an address that does
  not parse;
- once the tab is visible, once per card, at most once per conversation in ten
  minutes, and never after the person closed, paused or stopped the browser there;
- when no one else is using the browser, the composer holds no draft, and side-by-side
  view is on in a layout wide enough to show the browser beside the chat.

Once the browser is ready and before the task goes out, Studio checks again: if someone
wrote after the card, another run started, a draft appeared, or someone else holds the
browser, the task is not sent and the card keeps its button. Where Studio does not start a
card, it keeps its button, with the reason when there is one, such as "A browser session is
already running in this space. Open it when you are ready." or "This restarts this space's
cloud machine as the browser, which stops anything still running on it." A draft or a
browser in use only holds the card: it is looked at again once that clears. A failed start,
or a continuation the controller did not take, leaves the button and says why, and leaves
no notice. A continuation the controller put in the conversation's send queue, behind a
run that took the lane first, counts as sent: the notice stays and the card reads
**Opened**. A press, or an opened card, reads **Opened** from then on, also after a reload,
so displaying an old message never runs it again. **Try again** on a failed browser run
sends the card's task again through the browser, with the card it continues, never the
notice text. A browser Studio opened by itself grants nothing a press does not. It asks
for routine browsing only from a Desktop whose routine is the owner tier (approval policy
version 2: reading and plain links free, forms, purchases, messages and credentials still
ask), and only when the person has not chosen Ask; on an older Desktop it uses Ask, so it
never requests the earlier routine that submits ordinary forms. A start, pressed or
automatic, also gives an owner-tier Desktop in routine the hosts the card shows (at most
three) as the run's own sites; they are not recorded with the prompt, and an older Desktop
never receives them.
The card shows the host its task opens. The card says nothing about which browsers exist,
because the Workspace browser starts on demand as a runtime of its own; Studio disables the
button, with the reason, only when the Workspace browser is known not to open and there is no
Personal Browser. Until then it counts as available.
A skill setup offers the same card once, to walk to the provider screen that lists a value
the skill asks for (see [Product](Product.md)). In a chat opened with
`/skills import <source> --start` or `/skills start <name>`, the composer stays a chat
composer for the rest of that chat, even while the browser is shown: a reply goes out as a
chat turn, and is never aimed at the open page because of its words. Only the browser's own
controls (the card's button, **Let AI continue**, a new browser page) carry the walk on. When
the chat's opener is older than the loaded messages, a chat titled the way Studio titles a
connector's setup (such as "Connect FreeFinance") counts as one too. On Personal and Shared
Browser turns the agent is told to pause at a sign-in, one-time code or consent step with
`request_human_input`, so the person completes it on the page and chooses **Let AI continue**,
and never to open, or ask the person to open, a screen, dialog or field that shows a
credential value: it stops on the screen that lists it, names the control that opens it, and
asks the person to open that page in a tab of their own browser to see and copy the value.
That is turn guidance for the model, not a block the browser enforces.
Paused native control uses the existing Resume flow with the Browser settings
approval choice. Until the person chooses, it defaults to routine on a Desktop reporting
approval policy version 2 and to Ask on an older one; an explicit choice, either way, is
kept for presses, Resume, Retry and **Let AI continue**. Already active control keeps its
settings. A pending manual step must be finished with **Let AI continue** before another task can start.

Studio first reuses the browser location saved for this conversation on this
device. For a new conversation, it uses the user's explicit location preference,
otherwise **This device** in supported Desktop builds and **Workspace** on web
or mobile. An explicit request for either location overrides that selection for
the conversation without changing the user's default. An unavailable saved
Personal Browser does not silently become a different Workspace profile.

Browser location and the exact Workspace runtime binding are stored locally per
Instafy user, project and conversation, so closing the Studio tab does not erase
them. A live tab keeps its own runtime selection. The controller still checks
access and availability; an expired runtime cannot be restored from an identifier.
If a hidden browser becomes unavailable, polling pauses while its confirmed
session selection remains saved. Reopening retries that session or offers an
explicit choice if it has ended; it does not silently switch browsers.
This record is not synced across devices. Use the existing resume link for a
Workspace session on another device.

The skill carries task-relevant context, such as the site and work already done,
into the browser turn and inspects current state before continuing. This does
not save page snapshots or export cookies. A native app restart preserves the
profile, but not the open page or unsaved form contents; the agent may need to
navigate back using the conversation context. Site-specific carts and login
expiry still follow the site's behavior.

## Remembering addresses

The existing address bar in both **This device** and **Workspace** suggests
recent sites. Focus an empty field or clear it to see recent visits; type to
filter by page title or address. Select a suggestion to open it, or enter a new
address as usual. Arrow keys select suggestions, Enter opens the selection,
Tab completes it without navigating, and Escape dismisses the list.
Suggestions show site icons with a globe fallback. Icons load directly from the
site's `/favicon.ico` without a referrer; no third-party favicon service is used.

On phone widths, tapping the address opens a full-screen editor with the same
suggestions. **Back** cancels editing, **Clear address** shows recent visits,
and **Go** or a suggestion opens the page and closes the editor. Invalid
addresses stay editable. The header and suggestions fit above the on-screen
keyboard. Desktop keeps the dropdown even inside a narrow browser pane.

Studio remembers up to 100 observed page addresses and titles locally for your
Instafy account, and shows up to eight matches. Both browser locations use this
list. Draft addresses and unconfirmed navigation commands are not recorded.
History is not synced to other devices or shared with other participants.
**Clear recent sites** in the suggestions removes this list without clearing
cookies or site data. Clearing a browser profile does not clear this list.
Address recall does not restore open tabs or unsaved page contents.

## What survives a change?

- **Personal, another project on the same device:** the same user's profile is
  reused, but the new project must receive fresh agent control and browsing
  approval. A previous project's routine-browsing grant is not inherited.
- **Personal, close/reopen or app restart:** persistent cookies and site data can
  survive. Signing out of Instafy revokes browser control; it does not erase that
  user's disk profile. Another account gets a different profile.
- **Shared, another viewing device or pixel transport:** it is the same remote
  browser, not a copy. Use **Sessions & resume → Copy resume link** to select the
  exact running session on another signed-in device. Multiple sessions require
  a choice; an unavailable target does not silently create a replacement.
  WebRTC, CDP screencast, and RFB do not select new profiles.
- **Shared, replacement runtime:** recovery requires enabled durable persistence
  and a usable saved snapshot. Persistence is default-off and controller-owned.
  A space whose own machine hosts the browser (`HOSTED_BROWSER_HOST`) has it on,
  so its sign-ins are kept.
- **Shared, separate active runtimes:** there is no live cookie synchronization.
  A stored snapshot is not a continuously shared browser session. Conditional
  saves reject stale writers rather than overwriting a newer profile. After a
  conflict or uncertain save, that process stops saving until it is replaced
  or restarted with a successfully established baseline.
- **Fresh, another observation:** there is no login continuity.

Site expiration, session-cookie behavior, and server-side logout still apply.
Persistent profile storage cannot guarantee that every site's login survives a
restart. Cookies follow domain/path rules, while localStorage and IndexedDB are
origin-scoped; sessionStorage also depends on the browser's page session.

## Viewing and sharing control

Both interactive modes have an **Expand** control, including compact layouts.
It fills the app viewport; it does not create a different browser, profile or
OS window. Collapse returns to the docked browser with the same page.

Shared offers **Always allow routine browsing** at the first site prompt for that
turn. Personal Browser keeps the routine choice in Browser settings. Until the
person chooses, it is on for a Desktop reporting approval policy version 2 and
off (Ask) for an older one; a choice either way is kept. On a version 2 Desktop
the setting reads **Let Octo browse and read without asking for each site**:
reading, tabs, menus and plain links go ahead, while forms, other buttons and
messages still ask. On an older Desktop it reads **Allow routine browsing without
asking each time**, confirms once when control starts, and also covers ordinary
clicks and non-sensitive forms. Uncheck it before Resume for stricter Ask mode.
Routine browsing does not change cookie sharing.
Recognized high-impact actions still ask and secret entry remains manual; a
website can attach unexpected side effects to an otherwise ordinary control.
See each mode's policy for scope and revocation.

**Take over → fill highlighted fields → Let AI continue** is a sequential handoff.
The browser must confirm that agent operations have stopped before manual input
is enabled. **Let AI continue** sends a fixed message without entered values and
starts a fresh browser turn on that page. Shared page contents are still visible to
project members; expansion and manual input do not make a Shared page private.

## Clearing data

**Clear Personal Browser data** clears your Personal cookies and site storage on
this device across all projects. It does not clear another Instafy user's
Personal profile, your Studio sign-in, Shared Browser, or installed Chrome/Safari.
Agent control is paused before the clear.

**Clear Shared Browser data** affects the project browser for everyone. It
requires Builder-or-higher permission, stops managed runtimes that may hold the
profile, and deletes the durable snapshot only after that shutdown is confirmed.
When Instafy's browser runs on the space's own machine, that machine is one of
them: it restarts, which ends its previews, terminals and running work, and
Studio starts the same machine again afterwards. It does not clear Personal
Browser. A failed shutdown leaves the saved profile in place so the clear can be
retried safely.

## Security and verification

Personal keeps its profile on this device. Explicit [local tab sharing](Local-Browser-Sharing.md)
can grant selected members viewing, human control, or an independent Explore page
using that account, without exporting the profile or granting runtime access. Shared grants
access to authenticated pages to project members; use a project-appropriate
account there. Even without a cookie import/export feature, page content an
agent observes may enter the configured AI provider's context.
The current Shared profile boundary does not isolate Chromium from other
processes inside the same project runtime; stronger OS isolation requires a
separate execution boundary, not just a different profile directory or viewer.

The local Electron persistence smoke uses a disposable website and profile. It
sets real persistent and HttpOnly cookies over HTTP, checks their server-side
echo, and covers reopening, application restart, project changes, account
isolation, separate Studio storage, and explicit clearing. It uses no real
website account and submits no AI turn. This is a Personal proof, not proof of
Shared snapshot recovery or cross-runtime synchronization.

For the execution and authorization details, see [Personal Browser](Personal-Browser.md),
[Shared Browser](Shared-Browser.md), and
[self-hosted runtime security](Self-Hosted-Runtime-Security.md).
