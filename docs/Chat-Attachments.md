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
- A reader can also create a signed URL for an object with their own session. Storage lets
  them choose its lifetime, and the URL keeps working until it expires, even after they leave
  the conversation or the space. Only deleting the object ends it sooner. Clients should
  therefore download with the user's session rather than create signed URLs.

Deleting a space ends every session's access to its attachments at once. The controller then
deletes the space's prefix in the background with the service role. Storage lists one level of a
prefix at a time, so the purge empties each conversation's folder in turn. Deleting a team does
the same for each of its spaces, one at a time. A failure is logged and leaves the objects
unreadable through a session. A signed URL that a member created before the delete keeps working
until it expires or the purge removes its object. A conversation is never deleted on its own:
it goes only with its space or its team, whose purge covers it.

## The web app

- The composer takes PNG, JPEG, WebP and GIF images up to 20 MiB, from the picker, a paste
  or a drop, and says why it skips anything else.
- Sending uploads each attachment with the person's own Supabase session, `upsert` off and the
  exact content type, into `<projectId>/<conversationId>/`, at most three at a time. A new chat
  is created on the controller first. While the uploads run, the tray says "Sending your
  message with 2 images…" and those images can't be removed; an image added meanwhile stays
  for the next message. The message is shown and sent only after every upload succeeds. A
  failed upload removes the ones that did succeed, shows plain copy (never Storage's own error
  text), and puts the draft back in the composer with its images still attached. The draft
  keeps its reply context and browser target.
- A message shows a Storage image by downloading it with the session into an object URL that
  is revoked when the image goes away. It never creates a signed URL. Images download once
  they are near the screen, at most four at a time. The page keeps the downloaded bytes of
  the most recent images (up to 40 images and 64 MiB) so a message that comes back into view
  does not download them again, and the sender's own images are shown from the local copy.
  Everything kept is dropped when the signed-in person changes.
- A read Storage refuses (someone who is not a reader of the conversation) or an object that
  is gone shows a plain "Image unavailable" placeholder. A download that could not reach
  Storage shows "Couldn't load image" with a "Try again" button. Text attachments are listed
  by name.
- Older images with a `workspacePath` still load through the workspace's raw file route.
- When a file someone is editing changes underneath them and the two versions together are
  long (over 12,000 characters), the merge request sends them as two `kind: "file"` text
  attachments of that chat instead of writing snapshot files into the workspace. The prompt
  names each file by exactly the `fileName` its attachment records. If the snapshots can't be
  stored and the two versions together are at most 200,000 characters, the request is sent
  once more with them inline; otherwise the merge notice says why.
- A `/learn` message's images are stored in the new learn thread's folder. The parent chat's
  copy of the message points at the same objects, so members of the parent who can't read the
  learn thread see "Image unavailable" there.
- When `GET /projects/:projectId` reports `attachments: "none"`, or the app has no Supabase
  configuration, the image button is off with the reason "This server can't store
  attachments.", paste and drop say the same, and merge requests keep both versions inline.

### Compatibility

The web app no longer writes chat images or merge snapshots into the workspace. A runtime sees
them only when it advertises `attachmentDownloads` (below). A runtime built before that
capability, such as the one bundled with a Desktop release that predates it or an older
self-hosted runtime, silently gets no attachments: images are missing from the agent's prompt
and a large merge request names snapshot files the agent cannot read. Release the runtime
first, including a Desktop release whose bundled runtime advertises `attachmentDownloads`,
and only then the web app.

Chat uploads no longer reach a space's history either. The hosted gateway refuses a save of a
root `chat-upload-*` file or of anything under `artifacts/instafy-merge/` (422 `excluded_path`
with `reason: "attachment"`), and runtime and Desktop origins never publish one. A client that
still writes chat images into the workspace therefore cannot send them to a cloud space once the
stateless gateway runs.

## Delivery to the runtime

A runtime that downloads attachments advertises the `attachmentDownloads` capability.

1. When such a runtime leases a turn, the controller collects the Storage attachments of the
   turn's message and of the conversation's last 10 user messages.
2. It keeps only names under the leased job's own conversation, `<projectId>/<conversationId>/`.
   The controller never signs a name from another space or another conversation, or any name for
   a job without a conversation. It logs how many names it refused for each job, never the names
   themselves, and the prompt reports those attachments as unavailable.
3. It signs the rest in one request with the service-role key, for 10 minutes, and adds
   `attachment_downloads: [{ name, url, sizeBytes }]` to the leased payload. It signs only
   after the lease has committed and returned its database connection, so a slow Storage
   holds neither a row lock nor a pool slot.
4. Before the turn, the runtime downloads each entry to
   `.instafy/attachments/<conversationId>/<name>`, a folder of the turn's own conversation.
   Every lane that builds a turn prompt does this, parallel write-scoped workers included.
   - The name must be `<uuid>.<ext>`, the object name's last segment.
   - A file already in the conversation's folder is kept. It can only come from a turn of the
     same conversation that is still running.
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
   unavailable. Storage attachments older than the last 10 user messages are not offered at
   all.
6. The downloads last as long as the turn. When the last running turn of a conversation ends,
   the runtime removes that conversation's folder. A leased batch, which the controller fills
   only with one conversation's jobs, keeps the folder until its last job is done, so a later
   job of the batch reuses what an earlier one downloaded. A turn that starts also removes
   everything under `.instafy/attachments/` that nothing holds, such as the leftovers of a
   runtime that stopped mid-turn. The next turn downloads again whatever its lease signs, so an
   object its uploader deleted is gone from the next turn on.

`.instafy/` is reserved: nothing under it is published. A `.gitignore` in
`.instafy/attachments/` also keeps the downloads out of every git status.

Storage and the controller keep a private conversation's attachments to its own readers and
its own turns. On the runtime, a turn sees only its own conversation's downloads, under their
own folder, and never another conversation's file of the same name. A turn of another
conversation finds none of them once the turn, or the batch, that downloaded them is done.

The runtime does not isolate conversations from each other beyond that. Every conversation of
a space runs on the same runtime, in the same workspace, and the agent can read the runtime's
files, the saved threads of other conversations included. A writer's turn in one conversation
can therefore read what a private conversation's turns left behind, such as a file that
conversation's agent copied out of `.instafy/attachments/`, or its saved thread, which records
what it read and viewed. Viewers never run turns, and the workspace file routes hide
`.instafy/`.

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
  - the purge after `DELETE /projects/:projectId` and `DELETE /orgs/:orgId`, and that a refused
    delete, or one that finds no space or team, purges nothing;
  - the policy fixture above. They
  need the local stack, or a `TEST_DATABASE_URL` whose database has Supabase Storage's own
  migrations applied. The policy fixture fails on purpose against a database without them, such
  as plain PostgreSQL or the one `scripts/test-durable-notifications.py --controller-test`
  prepares.
- `cargo test attachment` in `packages/runtime-agent` covers:
  - the download path in the conversation's folder, and the name and URL checks, other
    conversations' paths included;
  - the size cap and timeout, including a body that stalls, and the per-turn budget;
  - streaming, the concurrency limit, and that no partial file is left;
  - that a turn's downloads are removed when its conversation's last running turn ends, or its
    batch is done, that a turn's start removes what nothing holds, and that a file of the same
    name in another conversation's folder is never used;
  - existing files and symlinks;
  - the prompt section, and the prompt of both turn lanes: the main lane and the parallel
    write-scoped worker.
