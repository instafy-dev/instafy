# Studio search

The header search field searches within the selected space. Removing the space
chip broadens the query to its organization; removing the organization chip
searches all accessible organizations and Personal spaces. Backspace removes
the last scope chip when the query is empty.

Results include chats, matching messages, known file names, settings and actions.
Message search uses a case-insensitive literal substring of 2–200 characters. It
searches persisted user and assistant text, including older history, and returns
the newest matches first. It does not perform semantic search, search attachment
contents or index file contents. File-name discovery remains limited to paths
known to the current workspace.

Each message result shows its chat, organization/space, role, date and a plain-text
excerpt with highlighted matches. Selecting it opens a contiguous history window
around that exact message and briefly highlights the message. Earlier and later
history can be loaded from that window; **Return to latest** returns to ordinary
live chat history. Browser Back restores the query, scope and result position;
Forward reopens the selected destination. These search checkpoints live only in
the current Studio session and are cleared when accounts change. Results are
fetched again when returning, so a checkpoint does not bypass authorization.

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
