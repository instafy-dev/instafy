# Chat attachments

Images and text files sent with a chat message are kept in Supabase Storage, not in the
space's files. They never enter the space's git history, so deleting or reverting files never
touches them, and publishing a turn never includes them.

## Storage

- Bucket `chat-attachments`, private, 20 MiB per object, `image/png`, `image/jpeg`,
  `image/webp`, `image/gif`, `text/plain` and `text/markdown`.
- Object names are `<projectId>/<conversationId>/<uuid>.<ext>`, with `ext` one of `png`, `jpg`,
  `webp`, `gif`, `txt` or `md`. Every id is a uuid in its canonical spelling, lowercase and
  hyphenated, and the extension is lowercase. Any other name is refused, so each space's objects
  sit under one `<projectId>/` prefix and each conversation's under one
  `<projectId>/<conversationId>/`.
- A message records each attachment in its metadata as
  `{ kind: "image" | "file", storagePath, fileName, mimeType, sizeBytes }`.
- The conversation must exist before its first upload. A client that attaches a file to the
  first message of a new conversation creates the conversation first, for example with
  `POST /projects/:projectId/conversations/blank`.

`supabase/migrations/20261003120000_chat_attachments.sql` creates the bucket and its policies.
Two functions decide access. Both require a signed-in caller, a name of the shape above, a
conversation that belongs to the named space, and a space that exists and is not deleted.

- `public.can_access_chat_attachment(name)` gates reading and listing. It applies the rule the
  conversation's messages follow (`has_project_access` and `has_conversation_access`, from
  `20260000000054_project_permissions_and_private_conversation_rls.sql`):
  - In a public conversation, any member of the space reads, viewers included.
  - In a private conversation, only its creator and its participants read, and only while they
    are still members of the space.
- `public.can_write_chat_attachment(name)` gates uploading and deleting. It needs both of these:
  - the caller can read the conversation, as above;
  - the caller is one of the members the controller lets send a message
    (`ensure_project_write_access`): the space's owner, or an owner, admin or builder of the
    space or of its team.

  Viewers can read attachments but cannot add any.

What each caller may do:

- A list of `<projectId>/` shows a caller only the conversations whose attachments they may read.
  The other conversations' folders, names and contents stay hidden, even from a member who
  knows a name.
- An uploader may delete their own attachments while they can still write to the space and read
  the conversation. Storage names the uploader in `owner_id`. A member who is made a viewer, or
  who leaves a private conversation, can no longer delete what they uploaded to it.
- Nobody updates an object in place, and an upload that would overwrite one is refused. After
  an uploader deletes an object, a writer can upload new content under the same name.
- Anonymous requests have no access, and nobody can reach another space's prefix.

Deleting a space ends every session's access to its attachments at once. The controller then
deletes the space's prefix in the background with the service role. Storage lists one level of a
prefix at a time, so the purge empties each conversation's folder in turn. Deleting a team does
the same for each of its spaces, one at a time. A failure is logged and leaves the objects
unreadable through a session. A signed URL that a member created before the delete keeps working
until it expires or the purge removes its object. A conversation is never deleted on its own:
it goes only with its space or its team, whose purge covers it.

## Delivery to the runtime

A runtime that downloads attachments advertises the `attachmentDownloads` capability.

1. When such a runtime leases a turn, the controller collects the Storage attachments of the
   turn's message and of the conversation's last 10 user messages.
2. It keeps only names under the leased job's own conversation, `<projectId>/<conversationId>/`.
   The controller never signs a name from another space or another conversation, or any name for
   a job without a conversation. It logs each refused name, and the prompt reports it as
   unavailable.
3. It signs the rest in one request with the service-role key, for 10 minutes, and adds
   `attachment_downloads: [{ name, url, sizeBytes }]` to the leased payload. It signs only
   after the lease has committed and returned its database connection, so a slow Storage
   holds neither a row lock nor a pool slot.
4. Before the turn, the runtime downloads each entry to `.instafy/attachments/<name>`. Every
   lane that builds a turn prompt does this, parallel write-scoped workers included.
   - The name must be `<uuid>.<ext>`, the object name's last segment.
   - A file already there is kept.
   - Each download is capped at 20 MiB and 30 seconds, and at most 4 run at once.
   - All of a turn's downloads share a budget of 60 seconds. A download still waiting or running
     when it runs out fails as timed out, so a stalled Storage delays a turn by at most a
     minute.
   - The body streams into a temporary file that is renamed into place once it is complete,
     so it is never held in memory and a partial download never appears under its name.
   - Writes never follow a symlink.
   - A failure is logged by name and the turn continues.
5. The prompt lists an attachment only when it belongs to the job's own conversation, this
   lease signed it and its file is present, with `view_image` for images. It names the rest as
   unavailable. A copy an earlier turn left on disk is not listed once the controller stops
   signing it, for example after its uploader deleted it. Storage attachments older than the
   last 10 user messages are not offered at all.

`.instafy/` is reserved: nothing under it is published. A `.gitignore` in
`.instafy/attachments/` also keeps the downloads out of every git status.

The downloads are a working copy in the space's workspace, which every conversation of the
space shares. Storage and the controller keep a private conversation's attachments to its own
readers and its own turns. But a file that a turn downloaded stays in `.instafy/attachments/`.
A later turn of another conversation on the same runtime could open it there if it looked for
it, although no prompt points it there.

A signed URL lets anyone fetch that object until it expires. It goes only into the leased
payload, never into conversation history, events or logs. A runtime without the capability gets
no URLs. Its history names the attachment without a path, so it never points the agent at a
file it does not have.

Older messages whose images were uploaded into the workspace (`workspacePath`) keep working
wherever that file exists.

## Self-hosting

- Without Supabase Storage, the migration reports a notice and skips the bucket and policies.
  Install Storage and rerun the migration to provision them; it changes no data.
- `GET /projects/:projectId` reports `attachments: "storage"` when the controller has a
  service-role key and the bucket answers. It reports `attachments: "none"` when there is no key,
  when Storage says the bucket is missing or refuses the key, or when Storage has not answered
  for 15 minutes. A brief Storage error (a 5xx, a 429 or a timeout) keeps a recent `storage`. A
  client should turn attachment uploads off when it is `none`.
- The controller keeps the answer for 10 minutes after the bucket answered, and for 1 minute
  otherwise. A stale answer is served at once and refreshed by one background check, so only the
  first summary after a start waits on Storage, for at most 3 seconds.
- Without a service-role key, nothing is signed and the prompt reports Storage attachments as
  unavailable.
- Runtimes download from the controller's `SUPABASE_PROJECT_URL`, so they must be able to reach
  it.

## Tests

- `supabase/tests/chat_attachments.sql` covers the bucket and its policies. It checks who reads,
  lists, uploads and deletes, by space role, team role and conversation participation. It also
  checks the name rules and immutability. Two places run it:
  - The controller test `chat_attachment_sql_fixture_passes_on_storage` runs it against
    Storage's own migrated schema on the local stack. The Controller DB Tests workflow runs it on
    every pull request that touches the controller or `supabase/`.
  - `scripts/test-durable-notifications.py` runs it by hand against a Storage stub, after
    proving that the migration succeeds without Storage and can be rerun once Storage exists (see
    `supabase/tests/README.md`).
- `cargo test chat_attachments::` in `packages/runtime-controller` runs the unit tests. They cover
  path filtering by space and conversation, batched signing, the capability check, the Storage
  probe, and the space purge through each conversation's folder. They run against stubs and need
  no database.
- `pnpm test:controller chat_attachment` adds the database tests. They cover:
  - the lease route and its capability gate, with nothing signed outside the leased conversation;
  - that the lease returns its pool slot before Storage signs;
  - the purge after `DELETE /projects/:projectId` and `DELETE /orgs/:orgId`;
  - the policy fixture above. They
  need the local stack, or a `TEST_DATABASE_URL` whose database has Supabase Storage's own
  migrations applied. The policy fixture fails on purpose against a database without them, such
  as plain PostgreSQL or the one `scripts/test-durable-notifications.py --controller-test`
  prepares.
- `cargo test chat_attachments` in `packages/runtime-agent` covers:
  - the download path, and the name and URL checks, other conversations' paths included;
  - the size cap and timeout, including a body that stalls, and the per-turn budget;
  - streaming, the concurrency limit, and that no partial file is left;
  - existing files and symlinks;
  - the prompt section.
