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
Space discovery, organization lists, access summaries and conversation lists have a 10-second
deadline covering authentication and response reads; navigation cancels superseded reads.
Failed conversation-list reads show an error and Retry after the first failed attempt while
automatic recovery continues. Cached chats stay visible during refresh failures.

On desktop and wide browser layouts, **Team & spaces** opens in the same resizable side
panel as **All chats**, Files and Changes. These panels share one slot, so opening one
replaces the other while the current conversation stays visible. Team and space selection
keeps its existing grouped list; choosing a space closes the picker. The close control or
Escape returns to the sidebar. On narrow layouts the picker remains a drill-in inside
navigation, with Back returning to the recent chats list. Android's system Back dismisses
the focused picker or topmost dialog first, then navigation, without reversing a team or
space switch. Browser history remembers the
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
When reading above the latest messages, a **Jump to latest** button stays above the composer.
It changes to **New messages** when visible messages (including attachments) arrive, without moving
their reading position. Jumping or scrolling to the bottom clears the notice and resumes
following. Initial history loads and older-page prepends do not count as new arrivals.

This does not restore an entire
editor session: file and panel tabs currently carry across space switches, while file selection
and explorer state reset for the destination space.

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

At widths below 900px, the composer's lower-left menu opens the navigation drawer with Chats
expanded. Selecting a recent chat closes the drawer, making chat switching two taps. On wider
layouts, the expanded sidebar offers direct selection; a collapsed sidebar opens the same list
in a popover. Home remains in the sidebar, and the top menu remains available when the composer
is hidden while scrolling.

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
clears the category parameter, so browser Back and reload retain the expected destination.

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

Image submissions keep their draft and previews while uploading. A failed upload leaves
them available to retry and does not add an unsent message to the transcript. Successful
uploads clear only the submitted images and unchanged source draft, including when the
user has switched to another conversation or space in the meantime.

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
