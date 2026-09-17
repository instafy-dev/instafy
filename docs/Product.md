# Product Overview

Instafy Studio is a browser-based AI workspace for chatting with a runtime controller and editing space files. The Studio prioritizes three surfaces: Assistant, Files, and Credits.

## Public entry

The landing page renders immediately, including while a saved sign-in session is being restored.
Entry links go to Studio, which checks authentication before downloading the workspace. Signed-in
visitors see **Open Studio**; signed-out visitors see **Get started** and are sent through login
with their destination preserved. Opening the public homepage itself does not require signing in.

Pending route and authentication handoffs use a neutral full-screen loading surface: one Octo
swimming above “Getting things ready…”, without a wordmark. The canonical animation stops for
reduced-motion preferences, and the loading surface disappears once the destination or login
form is ready. Login forms keep their static Octo mark.

Studio keeps that same loading surface while resolving the initial space, so entry does not
flash a second loading card. A stalled space-access lookup times out, keeps write capabilities
disabled, and recovers through the normal access refresh. The workspace shows a retry notice
while access remains unresolved. Successful entry has no added minimum display time.

Once the workspace is open, loading stays inside the affected panel. File fetching and editor
initialization use the same local status. Indicators announce their progress and respect
reduced-motion preferences. A failed first chat-history load shows an explicit Retry action instead of looking
like an empty chat. Previously loaded messages remain visible during background refresh failures.

Files, Changes, reviews, and settings/management panels download their code when first opened.
Chat and Home remain immediately available with the workspace. Panel downloads keep navigation
and drawer Close controls available, show a local loading status, and offer Retry or Reload app on failure.
Subsequent visits reuse the loaded panel code.

The shared-browser viewer also downloads when activated. Its loading and retry notice keeps
Close, Back to chat, and the browser selector available. Returning to a loaded viewer reuses
its code, and switching to chat or the personal browser keeps an active shared viewer mounted.

An optional timing observer measures Studio startup and chat, space, and team switches; the
public app sends no timing data by default. Its memory buffer holds at most 32 anonymous samples
containing only the operation, outcome, duration, message-count bucket, narrow/wide viewport, and
whether a readiness check was still waiting (`loadingShown`)—no identities, URLs, or message content.
That flag includes access checks, discovery, conversation selection, and content loading; it does
not prove that a spinner was painted or indicate a cache hit or miss. Readiness means the selected main chat or panel
has committed and had a paint opportunity, including its code download; it does not wait for
every later panel-data refresh. Trusted build-time integrations can subscribe and choose their
own opt-in transport.
Run-thread tabs use their displayed message count and wait for their parent chat's initial
history. Explicit chat-history retries start a new timing attempt after a failed navigation.

Settings lists keep their current-space rows visible during refresh. Automation refresh failures
keep previously loaded rows with a persistent Retry notice; explicit access denial removes the
cached rows. Secret and guest directories withhold protected records after a failed access check
and show Retry rather than an empty-state claim. Switching account or space isolates loading
results and closes space-specific editors.

The hero sits on the tentacle artwork with its crew presence cursors (Ada, Kim, Octo, and the
purple agent label that follows the active scenario), fading into the page below. Cursors that
would sit partly behind the example card are left out at that viewport size. The landing
workspace is an explicitly labeled interactive example that never creates a real session.
Its three scenarios advance on their own every 8 seconds. Rotation waits while the pointer is
over the example or focus is inside it, holds for 20 seconds after a visitor picks a scenario,
stops while the pause control is pressed, and never runs under reduced motion, offscreen, or in
a hidden browser tab. Picking a scenario always works, and rotation never moves focus or shifts
the layout. Octo's existing thinking animation appears only beside the example's active work and
follows the same pause rules. Header marks remain static.

## Studio Surface
- **Assistant**: conversational control of the workspace, runs, and file changes.
- **Files**: Monaco editor + file explorer backed by the controller workspace.
- **Credits**: team-scoped credits, plan selection, and Stripe-backed subscription management.

## Chat readability

Chat messages separate paragraphs with 16px of space and use a soft background for inline code.
Code snippets longer than 80 characters or containing a newline appear in a bounded, wrapping
block; short snippets stay inline. This presentation preserves the original message and code
text, including punctuation. Existing fonts, line height, heading structure, list indentation,
and interactive file references retain their behavior. Explicit fenced code blocks preserve
their source whitespace and scroll horizontally when needed.

## Header
The Studio header is owner-first: `Team/Personal > Space`, followed by runtime status and the user menu.

In wide desktop browsers, **Get desktop app** sits above the sidebar profile and becomes
an icon with a tooltip when the sidebar is collapsed. Compact desktop browser windows keep
the action in the profile menu. It appears only when a verified desktop release is available.
Mobile browsers show **Get the app · Soon** in the profile menu, linking to the mobile
availability section; iOS and Android downloads are marked coming soon. Native apps hide
these acquisition actions and retain their existing update controls.

## Switching teams and chats

The team switcher opens the most recently visited space in the selected team, falling back to
alphabetical order. Accessible spaces are cached for the signed-in user during the app session,
so changing teams can use the existing list immediately. Authentication, access changes and
returning to the app refresh discovery in the background. First-time discovery still needs the
controller. Failed discovery preserves the saved list, retries three times with backoff, and
offers Retry. The current-team indicator changes only when the destination space becomes active.
An unmatched space search shows **No matching spaces**, distinct from an empty space list.
Space discovery, organization lists, access summaries and conversation lists have a 10-second
deadline covering authentication and response reads; navigation cancels superseded reads.
Failed conversation-list reads show an error and Retry after the first failed attempt while
automatic recovery continues. Cached chats stay visible during refresh failures.

On desktop and wide browser layouts, **Team & spaces** opens in the same resizable side
panel as **All chats**, Files and Changes. These panels share one slot, so opening one
replaces the other while the current conversation stays visible. Team and space selection
keeps its existing grouped list; choosing a space closes the picker. The close control or
Escape returns to the sidebar. On narrow layouts the picker remains a drill-in inside
navigation, with Back returning to the recent chats list. Browser history remembers the
picker through `workspaceTab=workspaces`.

Open conversation tabs are remembered per space in the current browser. Previously loaded chat
history stays visible while refreshing, including when a refresh fails; transient failures retry
without replacing saved messages with an empty conversation. Recent history is cached in memory
for up to 30 inactive minutes. Inactive chats share a budget of 10 conversations and 8 MiB of
estimated serialized payload, with at most 20 pages (about 1,000 messages) retained per chat.
The least recently visited entries are released first. The active transcript can load additional
pages while being read; leaving it applies the inactive budget. This is a payload budget, not a
cap on total browser memory, and histories are not persisted to disk by this cache.

Rapid revisits reuse cached data immediately. While visible, the selected chat refreshes its
newest page every 10 seconds; older pages are fetched on demand. If the newest response no longer
overlaps cached history, pagination restarts from that response so intervening messages cannot
be skipped. Superseded reads are canceled, each read has a 10-second deadline, and sign-out,
account changes or explicit access denial release the affected protected history.

Long transcripts reuse measured row heights and defer offscreen plain-message bodies near the
visible window. Interactive cards remain mounted, and message shells keep scrolling stable.
Geometry is weakly associated with cached messages rather than retaining another history copy.
Draft edits do not retokenize unchanged message content. Browser Find, text selection, and the
keyboard/screen-reader action to read all loaded messages expand the full loaded transcript;
browsers without searchable hidden-content support keep the full renderer.

Reading position follows the first visible message and its offset, including after older cached
pages are trimmed. If that message is no longer loaded, the view starts at the oldest available
message, where earlier history can be requested. Conversations left at the bottom keep following
new messages.

## Navigation and reading positions

Studio uses the browser/React Router history in every shell. Back and Forward retrace visits;
**Open parent conversation** opens the parent as a new visit, and **Home** always opens Home.
Desktop shells expose explicit Back/Forward controls because they do not have a browser toolbar.
Touch layouts below the desktop breakpoint keep three bottom destinations — Home, Chats and
Spaces — only on those overview screens, in both mobile web and native apps. Chats opens the
full history overview, not the compact picker. Conversations (including empty chats and job
threads), editors and settings details have no bottom navigation row. The full history overview
owns its destination bar rather than covering a second one underneath it.

The touch header provides Back and a tappable current title/space that opens the compact
Chats/Spaces picker. At a direct entry with no known previous visit, it offers an explicitly
labeled Chats destination instead of a misleading Back action. Secondary actions, including
sidebar/settings access, new chat and notifications, are in the header menu. Forward remains a
secondary action in the picker; there is no duplicate top history row on these layouts.
Ordinary desktop web keeps its browser controls. App controls do not leave the app from its
first known entry; Forward becomes available after visiting a later entry in the current mounted
session. The separate Personal/Shared browser has its own page history.

The mobile picker opens from the bottom, fits short lists and caps long lists with scrolling.
Search and navigation controls sit below its results. While the keyboard is open, only search
and Close remain in the footer, leaving room to see matching results even in landscape; dismiss
the keyboard to restore section switching and Forward. Chats searches the current space's loaded active conversations; All chats opens the
full history surface. Spaces discovers accessible spaces across teams only when that section
opens. Selecting a different space records its URL as a new visit, without carrying the old
chat or browser-session target; Back restores the previous chat. Search does not autofocus or
summon the keyboard on opening. The picker is transient:
Close, Escape, backdrop or Android Back dismisses it; a route/account/space change or desktop
resize also closes it, without adding a synthetic history destination.

The overview dock yields space when a focused text editor and actual viewport occlusion indicate
a software keyboard. Focus with a hardware keyboard alone does not hide it. Chat never adds the
dock, before, during or after typing. The composer keeps its existing editor/control tree and owns
its bottom safe area; no extra Home shortcut or floating navigation control is added to it.
Detection uses viewport geometry, not native keyboard settings: floating keyboards that do not
resize the viewport cannot be reliably inferred. Physical one-handed comfort and iOS accessory-bar
clearance still require device testing; automated target-size checks do not establish thumb reach.

Chat positions are remembered per signed-in account, space, history visit and conversation
(or job thread), not merely per conversation. Visiting the same chat twice can therefore retain
two reading positions. Restoring a route waits for the matching space and conversation; a late
response from a previous space must not select that chat or rewrite the destination. Drafts remain
conversation-owned and are not restored from history, put in URLs or shared with other clients.
Navigation history and reading positions stay local to each client, even when clients collaborate
in the same chat or remote browser session.

Scroll snapshots contain only IDs/geometry, remain in memory, and are bounded to 200 recent chat
visits and 200 panel positions. They do not survive an app reload. Chat snapshots use message
anchors and offsets; ordinary panels use scroll coordinates and wait up to ten seconds for delayed
content to become tall enough. Missing/evicted chat anchors fall back to the oldest loaded message.

On mobile, the sidebar and its Team & spaces/More drill-ins have history entries. Back dismisses
one level; selecting a destination first closes that sidebar history branch and then opens the
destination once. Android's keyboard dismissal remains platform-owned. Native-aware dialogs use
one prioritized Back listener so one press cannot dismiss several registered surfaces at once;
this does not make every application dialog history-aware.

This does not restore an entire
editor session: file and panel tabs currently carry across space switches, while file selection
and explorer state reset for the destination space.

A desktop workspace-picker URL remains the same visit when the window becomes narrow; its
mobile presentation does not add a sidebar-history entry. Dismissal returns to the known prior
app visit, or removes only the picker from a direct-entry URL. Ordinary mobile sidebar drill-ins
still use their own one-level Back behavior. Compact fine-pointer windows retain their existing
composer navigation control; touch layouts use the focused header instead.

The sidebar's **Chats** section starts expanded and shows up to six recently visited active
conversations in the current space. Selecting a row opens a preview or focuses its existing tab;
closing a tab does not remove the conversation from recent chats. **Browse all chats** opens
the existing searchable history. New chat creation lives in the top bar and full chat history;
the sidebar Chats row only expands or collapses its recent list. Visit order is stored locally
per account and space. Quick-list rows stay in place while switching among listed chats,
including when reopening mobile navigation. Opening a chat outside the list adds it at the
top, replacing the least recently visited row if the list is full. History refreshes and
title or status updates preserve the remaining row order. The full history has an always-visible search field with its status
filter inside, and New chat and Close actions beside the title. A non-default filter changes
the heading and marks the filter icon; counts live in the filter menu. Starting a chat clears
the search and returns to active chats. Per-chat actions, including closing an open tab,
live in its More menu.

In fine-pointer windows below 900px, the composer's lower-left menu opens the navigation drawer
with Chats expanded. Touch layouts instead open their compact picker from the header. Selecting
a chat closes either surface, making chat switching two taps. On wider layouts, the expanded
sidebar offers direct selection; a collapsed sidebar opens the same list in a popover. Home
remains in the sidebar, and the top menu remains available when the composer is hidden while
scrolling.

Browsing existing chats through recents, history or browser Back reuses one preview conversation
tab per space. Wide layouts show its title in italics. Reading, scrolling and focusing the
composer keep it replaceable. Typing, attaching a file, starting voice input or sending a
message keeps the tab open; **New chat** also creates a tab that stays open. Double-clicking a
tab, dragging it or choosing **Keep open** from its menu does the same explicitly. Chats with
drafts, queued or running work, or open job threads remain protected. Replacing a preview only
changes the tab: the conversation remains available in Chats. Previously open tabs stay open,
and the preview state is remembered per space alongside them. Mobile chat selection uses the
same preview behavior without adding another step to the two-tap switching flow.

## Home activity

Home separates **Unread** conversations from **Recent activity**, using flat rows on the
shared panel surface. Failed runs retain a warning icon and a concise failure label while
remaining markable as read. A completion or failure retires the matching running entry.

Narrow panels initially show four unread rows with **View all**; wide panels show up to
eight. Previews can wrap to two lines in narrow panels. When team filters are available,
**All** consistently labels rows **Organization · Space**, even when the loaded page contains
only one organization's activity. Selecting an organization omits its repeated name and keeps
space labels when the feed spans multiple spaces. **Earlier activity** marks the previous
visit boundary; it does not imply that every unread conversation has been read.

Team filters apply to loaded history. When older pages remain, an empty filtered view offers
**Load older activity** rather than implying the team has no activity. Loading failures keep
existing rows visible and offer **Retry**. New chats use the top-bar action, with **Start a
chat** also available in the first-use empty state.

## Settings and skills

Settings categories use a side list when the settings pane has enough room. Opening a
workspace side panel can switch this to a compact picker without changing the selected
category or resetting the form. Form fields and member controls respond to the available
content width as well. Space settings categories follow the URL; returning to Overview
clears the category parameter. Team, space and profile categories and available Voice & audio
subsections follow the URL. A distinct section adds one visit, selecting the same section is a
no-op, and browser Back/Forward and reload restore the selected section. Filters and form edits
do not add history entries.

Settings cards use the shared Studio surfaces and control styling. Lists own one internal
gutter, invitation counts stay beside their heading, and narrow profile forms place Save
below the helper text. Secrets has a labeled **Create secret** action.

On mobile, installed skill titles open the skill file directly, the enable toggle remains
visible, and other actions live in the row menu. Skill discovery keeps search on one row
and folds source, category and sort controls into **Filters**; closing the controls keeps
their selections. Wider layouts retain direct row actions and visible discovery filters.
**Import** and a catalogue **Install** send the same `/skills import ... --start` line as the
composer, into the current chat, and keep you on the Skills panel.

Automations uses a flat empty state on the shared panel surface, with a labeled
**New automation** action and a short explanation of scheduling.

## Composer

The composer uses one compact, rounded writing row on phones and wider screens. It grows
with the draft, then scrolls within the editor. Image upload and other message tools live
in the `+` menu.

**Connect a tool** in the composer `+` menu, next to **Import GitHub repo**, lists the
featured tools (Slack, Notion, Discord, GitHub) and ends with **Browse all tools**; the
featured skills also sit as a row of chips under **Connect a tool** on the getting-started
card of an empty space, followed by a **More tools** link. Both open the Connect sheet: a
**Search tools** box, a **Popular** row of bare marks (a curated list, not a measurement), and
every first-party tool grouped by category (Chat and community, Docs and notes, Code, Finance
and bookkeeping, and so on), with **connected** or a region such as Austria as the row's meta.
Tools whose skill pack is not published yet show a **Soon** badge and cannot be selected, on
the card, in the menu and in the sheet, and the Popular row appears only once at least two of
its tools are available.
Typing filters the rows by name, keyword, category or region and hides the Popular row; when
nothing matches, **Search all skills** opens the Skills panel's Discover tab with the same
query. **Paste a skill link** lives in the sheet's footer. Choosing a skill opens the confirm stage, which says which skill is added
and from which repo, what its setup will ask for, and where the files land
(`.agents/skills/<skill>`), with **Back** when it was reached from the list; **Connect** then
sends one line, `/skills import <source> --name <skill> --start`, into the current chat as a
new turn (queued behind an active reply when there is one). Nothing is sent by a chip, a menu
row, a search, a Popular mark or a category row: **Connect** is the only sending control.
GitHub is reached through **Import GitHub repo** and its device login (the GitHub row in the
sheet and menu leads there too), and **Paste a skill link** opens a dialog for any GitHub repo
or skill folder link, a `SKILL.md` link, or a workspace path, whose **Add and start** sends
`/skills import <source> --start` the same way. The runtime
copies every folder in the
source that contains a `SKILL.md` into `.agents/skills/`, reports what it wrote in one
message, and then continues the same turn by following each skill's `## Getting started`
section: questions are asked in chat, secrets are requested by name through the secrets card
and never pasted into the conversation, dependencies are installed inside the skill folder,
and schedules are created through the normal automation flow. `/skills start <name>` runs
that section again for one installed skill, and `/skills` is listed in the typed `/` menu
and in **Commands**. The product list is a fixed, first-party list built into Studio, and
**Import** and **Install** in Settings > Skills send the same line into the current chat
without leaving Settings. Skills are files distributed as public repos and URLs; a skill's
`SKILL.md` is platform-neutral and only declares what it needs (environment variable names
and whether each is sensitive), the questions to ask, the files to write, a schedule in
plain words and a validation line, and Studio supplies the import, start, secret and
automation verbs that carry those declarations out. There is no marketplace, no plugin
registry, and no remote code loading beyond files written into the workspace.

On clients with voice input, the trailing action is the microphone for an empty draft and
Send or Steer for a text or image draft. Recording and transcription keep the microphone
available until capture finishes. Use **Dictate message** in `+` to start voice input with
an existing draft. Clients without voice input retain the Send control.

### Delivery actions

The composer exposes three one-shot actions instead of a persistent delivery mode:

- **Steer** adds the message to the matching agent's active turn. While that turn is active,
  `Enter` and the primary send control steer it.
- **Queue** saves the message for the matching agent's next turn. Use `Cmd+Enter` on macOS or
  `Ctrl+Enter` elsewhere. If there is no matching active turn, the controller may dispatch it
  immediately rather than leave an idle queue entry behind.
- **Stash** saves a private draft without creating a transcript message, run, or job. Use
  `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` elsewhere, or choose **Stash draft** from the
  composer actions. Stashes never auto-send, remain private to their author, and are capped per
  author and conversation at 50 drafts and 5 MiB of serialized draft data.

`Shift+Enter` always inserts a newline. When no matching agent is active, ordinary `Enter` sends a
new turn. A queued message's edit action is named **Edit**, reserving **Steer** for genuine active-
turn input.

## Scope Guardrails
- No preview/publish UI.
- No custom domains or domain purchase flows.
- GitHub repository import is available for onboarding existing code into a space.
- Broader integrations such as issue/PR workflow automation and hosting are future, opt-in, and must be driven by conversation runs.

## Notes
- The filesystem is the source of truth; the controller reads/writes under each space workspace.
- Keep UI copy aligned with the chat + filesystem focus.
