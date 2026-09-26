# Studio search

The header search field searches within the selected space when opened from a
chat. On Home, it follows the Home filter: **All teams** starts across all
organizations, and a selected team starts within that team, without a space
restriction. The retained chat breadcrumb does not limit Home search. Removing the space
chip broadens the query to its organization; removing the organization chip
searches all accessible organizations and Personal spaces. Backspace removes
the last scope chip when the query is empty.

Results include chats, matching messages, known file names, settings and actions.
Message search uses a case-insensitive literal substring of 2–200 characters. It
searches persisted user and assistant text, including older history, and returns
the newest matches first. It does not perform semantic search, search attachment
contents or index file contents. File-name discovery remains limited to paths
known to the current workspace.

Results are grouped by type. **Messages · Newest first** orders matching messages
by their creation time (then message ID for ties), including across paginated
results. **Chats · Recent activity** orders chat-title matches across spaces by
their latest message time, falling back to the chat's update or creation time.
Files, settings and actions keep their navigation order; there is no relevance
ranking yet.

The **Chats** drawer is for browsing and managing chats in the current space.
The team/space breadcrumb supplies the scope on every screen size.
Its **Filter by name** field filters the loaded chat titles, retaining thread
context; it does not search message contents. The status menu switches between
Active, Archived, Hidden and Trash. This filter stays separate from the header
search so the list can be narrowed without leaving it. Use the header search to
find words inside messages or search across spaces.

On mobile, one **Chats** navigation header contains the search icon, status filter
and New chat action, with no repeated page heading below it. Selecting Archived, Hidden or Trash
updates that same heading. General Back/Forward controls remain available in
**More** to leave room for the page actions. Opening search focuses an inline
field below the header. Closing the name filter
clears the query; Escape does the same and returns focus to the search icon.
Returning from a chat restores an active name filter visibly without focusing
the field or reopening the keyboard. The mobile Chats page has no drawer Close
button; use navigation Back, the bottom destinations or a chat row. Desktop keeps
the persistent filter field and drawer Close button.

Chat-title discovery reads up to 200 recent titles per space, initially covering
40 accessible spaces. **Search more spaces** reads the next group of spaces;
already loaded spaces are retained until scope, account or access changes.
The remaining-space count makes this partial coverage explicit. Message search
already covers the complete selected scope and has its own result pagination.

Each message result shows its chat, organization/space, role, date and a plain-text
excerpt with highlighted matches. Selecting it opens a contiguous history window
around that exact message and briefly highlights the message. Earlier and later
history can be loaded from that window. When result selection leaves keyboard
focus empty, the message becomes the focus destination; an already focused
composer or other control is preserved. The temporary tint fades after three
seconds, while keyboard focus remains visible until it moves. The outline has
space around the text, supports forced colors and respects reduced motion.
**Back to results** restores the query, scope, loaded result pages and reading
position. Below 900px, this appears as **Results** in the existing workspace
header, replacing its Back action. Touch and compact mouse layouts keep Back and
Forward together, dimming and disabling unavailable directions. The pair is hidden
when neither history direction nor a saved search is available. Direct entries
reach chats through the sidebar; history buttons never become chat shortcuts.
Their accessible names describe the destination. The sidebar toggle stays at the
far left, separate from the current tab's icon and title. The same history pair is
used on Home, account settings and the search results screen.
Tab switching and other secondary actions are available in **More**. Drawer dismissal and parent conversation navigation
remain separate actions. Org and space transitions preserve the last resolved
history controls while the route catches up, without accepting stale actions.

On touch layouts the icon-only arrow in the composer returns directly to the
originating Home, Chats or search-results visit. A direct chat entry falls back
to that space's Chats list. Its accessible name describes the destination.
This does not replace general history Back/Forward in More, or change the
single-row composer. Home's team filter, expanded unread lane, loaded activity
page count and visible-row count belong to the originating visit; Chats retains
its name/status filters. Their scroll positions are restored on return. Saved
list coordinates contain no fetched content, are isolated to the account, and
are cleared on reload; returning refetches authorized content.

The mobile team avatar opens the team list directly. Current-team and unread
indicators remain in the list, with team overview and settings beside its
heading. Accounts with more than five teams can search the list by name or slug.
Home's compact **Recent chats** shortcuts follow chats opened during the
current Studio session, across teams, with team/space labels. They resolve
against freshly loaded Home activity, so deleted or inaccessible cached names
are not resurrected; older chats outside that activity remain discoverable via
Chats and search. The shortcuts follow Home's selected team filter.

Scrolling down near the end of a historical message window automatically loads
the next page while preserving the reading position. Search-result reveals and
restored visits do not start additional newer-page requests by themselves. If a
newer page fails to load, an inline **Retry** action retries that same page.
**Latest ↓** below the messages jumps directly to ordinary live chat history
without adding a Back step. After all newer pages have loaded, scrolling to the
actual end also resumes live chat and removes Latest automatically. Loading the
last page alone does not skip the remaining messages. Latest stays available
while reading history or if a request fails. Both ways of resuming live chat
replace the older-message destination, so Back returns to the search and Forward
opens latest messages. Results stays
in the compact header; history controls stay with the transcript. Electron and
native shells also expose app history controls on the search screen. Direct
message links offer the same history controls without inventing a search to
return to. These checkpoints live only in the current Studio session and are
cleared on reload or account change. Results are fetched again when returning,
so a checkpoint does not bypass authorization.

When another participant adds a message while you are reading above the live
bottom, **New messages ↓** appears above the composer without moving the
transcript. It returns to live messages and clears once you catch up. Historical
search views use the same action and retain **Results**; the duplicate **Latest**
action is hidden while it is shown. Loading existing history or sending your own
message does not count as a new incoming message for this indicator.

The conversation's presence controls stay fixed while message content fades
beneath them. Exact-message reveals land below that fade, with room around the
highlight. Forced-colors mode uses a solid system-color header instead.

## Controller and database

Apply the ordered migration
`supabase/migrations/20260910120000_conversation_message_search.sql` before rolling
out the controller and frontend. It adds a trigram content index and a stable
conversation/timestamp/message-ID index; existing message records remain the
source of truth and require no separate indexing service or client backfill.
Plan index creation for the size and write load of the database.

- `GET /search/messages?q=...` accepts `projectId`, `orgId` or `personal` scope
  constraints, plus `cursor` and `limit` (default 30, maximum 50).
- `GET /conversations/:conversationId/messages/context?messageId=...` returns
  the canonical target and surrounding messages. `before` and `after` each
  default to 20 and are limited to 50. Responses include boundary message IDs
  for paging in either direction.

Both endpoints require an interactive user session. Project membership,
organization membership, private-chat participation and the viewer's hidden or
deleted chat state are checked on the server. Access is checked again for every
page and message-context request. Search does not start a workspace or model run.
Responses are marked `Cache-Control: no-store`; excerpts are plain text with
UTF-16 match offsets, rendered without HTML injection.

Older controllers report message search as unavailable while the other result
types remain usable. Deploying only the frontend does not enable message search.
The shared request/response types and URL helpers are exported from
`@instafy/sdk/conversation-search`.

## CLI access

`instafy conversation grep "retry failure" --json` searches the same persisted
message text in the linked space. Use `--org <id>`, `--personal` or `--all` to
broaden it, and `--cursor` to request another page. A result's conversation and
message IDs can be passed to `instafy conversation context <conversationId>
<messageId> --json` to retrieve surrounding history. Both commands require the
CLI's signed-in user session and retain the controller's access checks. They do
not grant unattended runtime credentials additional access.

The older `conversation search` command still offers bounded title/preview and
recent-history discovery. Local file contents can be searched with `rg` in the
workspace. See the [CLI guide](CLI.md) for arguments and exit codes.
