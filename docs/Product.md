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
controller.

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

This does not restore an entire
editor session: file and panel tabs currently carry across space switches, while file selection
and explorer state reset for the destination space.

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
