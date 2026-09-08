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

Settings lists keep their current-space rows visible during refresh. Automation refresh failures
keep previously loaded rows with a persistent Retry notice; explicit access denial removes the
cached rows. Secret and guest directories withhold protected records after a failed access check
and show Retry rather than an empty-state claim. Switching account or space isolates loading
results and closes space-specific editors.

The landing workspace is an explicitly labeled interactive example. Visitors choose a scenario;
it does not rotate automatically or create a real session. Octo's existing thinking animation
appears only beside the example's active work. Motion can be paused and stops when the example
is offscreen, the browser tab is hidden, or reduced motion is enabled. Header marks remain static.

## Studio Surface
- **Assistant**: conversational control of the workspace, runs, and file changes.
- **Files**: Monaco editor + file explorer backed by the controller workspace.
- **Credits**: team-scoped credits, plan selection, and Stripe-backed subscription management.

## Header
The Studio header is owner-first: `Team/Personal > Space`, followed by runtime status and the user menu.

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

Automations uses a flat empty state on the shared panel surface, with a labeled
**New automation** action and a short explanation of scheduling.

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

## Composer delivery actions

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
