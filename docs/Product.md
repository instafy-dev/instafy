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

The landing workspace is an explicitly labeled interactive example. Visitors choose a scenario;
it does not rotate automatically or create a real session. Octo's existing thinking animation
appears only beside the example's active work. Motion can be paused and stops when the example
is offscreen, the browser tab is hidden, or reduced motion is enabled. Header marks remain static.

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
On wide screens, a slim global rail selects Home or a team. A persistent context/search
field above the workspace contains selectable team and space chips separated by a muted slash.
It stays in place when the inner sidebar collapses or search opens. The adjacent sidebar
contains recent chats and workspace tools. Its expand/collapse control stays at the same
position in either width, with **New chat** beside it when expanded and below it when compact.
Existing saved collapse preferences are preserved.

Narrow layouts keep Home, the team/space path, Search and the signed-in profile in the context
header. Home remains available from a workspace, and team/space controls remain available on
Home. Workspace history, tab selection and secondary actions remain in the working header
below it. Global pages provide an explicit Open navigation control. The navigation drawer
shares the same team/space path and has a separate Close/New chat row; directories and More
remain drill-ins with Back, without stacking navigation drawers. Opening navigation does not
change the page behind it. Team overview/settings do not replace a space's remembered work.

Navigation uses a solid warm off-white surface in light mode and the dark rail
surface in dark mode. The drawer and its team/space directory or More view keep
the same background; dimming and blur belong to the backdrop. Content panels and
floating menus retain their separate surface colours and elevation.

In wide desktop browsers, **Get desktop app** sits above the rail profile as
an icon with a tooltip. Compact desktop browser windows keep
the action in the profile menu. It appears only when a verified desktop release is available.
Mobile browsers show **Get the app · Soon** in the profile menu, linking to the mobile
availability section; iOS and Android downloads are marked coming soon. Native apps hide
these acquisition actions and retain their existing update controls.

The space chip opens an anchored picker with up to six named space shortcuts and
**Browse all spaces**. Recent visits choose which accessible spaces appear; the selected
set is displayed alphabetically, with the current space highlighted in its alphabetical
position. Choosing a shortcut does not move it to the front. Visiting another space can
replace the oldest shortcut. Recent visits are remembered per account on this device.
Chats retains its inline collapsible recent list scoped to the current space.

Space icons use the same numbered unread badges as Home and the full space directory:
chats with unread assistant replies for the signed-in user, excluding the visible chat.
Zero is hidden and counts over nine display as **9+**. These badges describe personal unread
activity, not all unfinished jobs or decisions needing approval.

## Scoped search

Focusing Search opens a temporary results page, keeping the workspace mounted so drafts,
tabs and scroll survive dismissal. Desktop search uses the same input and context chips
before and after focus. Narrow layouts open one full results screen and return focus to the
Search button when dismissed. Escape/Close returns to the workspace; Android system Back
also closes search. Selecting a result opens its normal Studio destination.

Search starts within the working space. Empty Backspace broadens it to the team, then all
teams; chip removal buttons and the Scope selector provide the same controls. These changes
do not switch the working space. Home/account start across teams. Clicking a team/space chip's
picker still performs normal navigation. Desktop dismissal clears the query and restores the
working scope.

Search reads authenticated accessible-space and conversation summaries. It matches recent
chat titles, opened file paths, file names from already-loaded Explorer listings in the
current space, and space/team settings or automation destinations;
it does not search message bodies or file contents. Reads cover up to 200 chats per space
and 40 spaces per request, with explicit coverage, loading, error and retry feedback. Results
initially show 100 rows with Show more; queries still match the full retrieved set. Unloaded
folders are not searched. Explorer listings contribute only safe relative paths in memory;
switching account, working space or workspace origin discards that metadata. Search never
starts runtimes or reads files in the background. Scope/account changes and access refresh
discard stale results.
File results wait for the authorized destination space to hydrate. Listed files open through
the normal file loader; later navigation, account/access changes and workspace-origin changes
cancel pending reads before they can update another workspace.

## Team experience

The global rail keeps Home fixed above a scrollable team list, with New team,
Browse teams and the account controls below it. Browse teams shows the signed-in
account's accessible teams and spaces; it is not a public team directory.
Invitation links continue to use the existing invitation acceptance flow.
Home uses the static Instafy mark with the label and tooltip “Home — all teams”,
in dark ink on light surfaces and white on dark surfaces. The selected Home or
team has a persistent side marker as well as its background highlight.

The team chip opens an anchored menu for Switch team, Team overview and Team settings.
The space chip beside it changes the working space. Less frequent tools, personal AI
connections and Credits remain available through More. The desktop space picker shows only
the selected team's spaces; Browse teams retains the full team-and-space directory.
Home and account pages hide the team-specific desktop sidebar.

An empty team's overview and settings can be selected independently of the
current project. They do not display the previous team's space tools or activity.
An unavailable team does not silently fall back to a different team. Personal
spaces have their own overview. Team/Home context is represented by `teamId` in
the URL, while workspace tools remain scoped to the active project's team.
Returning from Home restores the team's last visited work in the current window;
browser Back retains its normal chronological history.

**Team** connects the selected team's people, accessible spaces and recent work. Agent profiles
appear only when observed in activity visible to the signed-in account. This is a recent activity
view, not an inventory or health check of every worker. Private conversations keep their existing
access rules. A completed turn does not certify that its task was fixed or released. Opening Team
does not advance the Home activity visit marker.

**Team settings → Team profile** exposes the name and picture together. Owners and admins can
edit them; other roles can see why editing is unavailable. Team selection is independent of the
active space, so a new team can have its profile set before it has any spaces. Both New team
entry points offer an optional picture; an upload failure can be retried without creating another
team, or the user can continue without the picture.

Space settings offers **Space appearance**, with an optional emoji and color. These persist with
the space and appear in navigation and the space picker. Existing spaces keep an initials fallback;
editing uses the existing permission to write to the space.

**Your AI** identifies account-owned connections and agent profiles. The Team view shows their
visible work; it does not expose or transfer another person's provider credentials.

## Switching teams and chats

The team switcher opens the most recently visited space in the selected team, falling back to
alphabetical order. Accessible spaces are cached for the signed-in user during the app session,
so changing teams can use the existing list immediately. Authentication, access changes and
returning to the app refresh discovery in the background. First-time discovery still needs the
controller. Failed discovery preserves the saved list, retries three times with backoff, and
offers Retry. The current-team indicator changes when the destination space becomes active
or the selected empty team's overview opens.
An unmatched space search shows **No matching spaces**, distinct from an empty space list.
Space discovery, organization lists, access summaries and conversation lists have a 10-second
deadline covering authentication and response reads; navigation cancels superseded reads.
Failed conversation-list reads show an error and Retry after the first failed attempt while
automatic recovery continues. Cached chats stay visible during refresh failures.

On desktop and wide browser layouts, **Browse teams** and the space picker open in the same resizable side
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

Inside a working area, the touch header provides Back and a current title/space with a navigation
icon that opens the shared left drawer. Home, team and account pages retain their global
Home/team/profile controls. At a direct working-area entry with no known previous visit, it offers an explicitly
labeled Chats destination instead of a misleading Back action. Secondary actions, including
sidebar/settings access, new chat and notifications, are in the working header menu.
Forward is also available in that menu. Global touch pages offer Back and Forward in a compact
history menu beside the profile action. Opening either menu leaves the forward route intact;
opening navigation itself creates a drawer visit.
Ordinary desktop web keeps its browser controls. App controls do not leave the app from its
first known entry; Forward becomes available after visiting a later entry in the current mounted
session. The separate Personal/Shared browser has its own page history.

The mobile drawer keeps team selection and space navigation in one surface. Search does not
autofocus or summon the keyboard on opening; its results stay scrollable when the keyboard is
visible. Back from a drill-in returns one level, and Close returns to the underlying visit.
The global team button opens its picker directly as one drawer visit, so Back returns to the
global page. Opening that picker from inside space navigation adds a drill-in instead.
Selecting a destination first collapses the owned drawer history and then pushes the destination
once. A different space never inherits the old chat or browser-session target; Back restores the
previous work. Team settings and empty-team overviews retain the selected team independently
of the loaded space. Desktop resize closes the mobile history branch.

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

The sidebar's **Chats** section starts expanded and shows up to three recently visited active
conversations in the current space. Selecting a row opens a preview or focuses its existing tab;
closing a tab does not remove the conversation from recent chats. **Browse all chats** opens
the existing searchable history. New chat creation lives in the top bar and full chat history;
the sidebar Chats row only expands or collapses its recent list. Visit order is stored locally
per account and space. Running or queued chats and the selected chat take priority in the
bounded list; the remaining rows keep visit order. Other chats remain available through
Browse all chats. The full history has an always-visible search field with its status
filter inside, and New chat and Close actions beside the title. A non-default filter changes
the heading and marks the filter icon; counts live in the filter menu. Starting a chat clears
the search and returns to active chats. Per-chat actions, including closing an open tab,
live in its More menu.

In fine-pointer windows below 900px, the composer's lower-left menu opens the navigation drawer
with Chats expanded. Touch layouts open the same drawer from the header. Selecting
a chat closes navigation, making chat switching two taps. On wider layouts, the expanded
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

All workspace tabs can be reordered, including panels such as Machines and Settings and run
threads. Select a tab and drag it to its new position; keyboard users can press Space to pick
it up, use Left/Right to move it, and press Space to drop it or Escape to cancel. Chat title
and unread updates preserve the order of tabs across different kinds of content.

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

Automations uses a flat empty state on the shared panel surface, with a labeled
**New automation** action and a short explanation of scheduling.

## Composer

The composer uses one compact, rounded writing row on phones and wider screens. It grows
with the draft, then scrolls within the editor. Image upload and other message tools live
in the `+` menu.

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
