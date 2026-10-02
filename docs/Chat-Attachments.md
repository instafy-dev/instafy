# Chat attachments

Images and text files sent with a chat message are kept in Supabase Storage, not in the
space's files. They never enter the space's git history, so deleting or reverting files never
touches them, and publishing a turn never includes them.

## Storage

- Bucket `chat-attachments`, private, 20 MiB per object, `image/png`, `image/jpeg`,
  `image/webp`, `image/gif`, `text/plain` and `text/markdown`.
- Object names are `<projectId>/<uuid>.<ext>`, with `ext` one of `png`, `jpg`, `webp`, `gif`,
  `txt` or `md`, in lowercase. Any other name is refused.
- A message records each attachment in its metadata as
  `{ kind: "image" | "file", storagePath, fileName, mimeType, sizeBytes }`.

`supabase/migrations/20261002140000_chat_attachments.sql` creates the bucket and its policies.
`public.can_access_chat_attachment(name)` decides access: the caller is signed in, the name
has the shape above, and the space exists, is not deleted and is one the caller can access
(`has_project_access`).

- Members of a live space upload and read its attachments with their own session.
- An uploader may delete their own attachments while they can still read them.
- Nobody updates an object in place, and an upload that would overwrite one is refused. After
  an uploader deletes an object, a member can upload new content under the same name.
- Anonymous requests have no access, and nobody can reach another space's prefix.

Deleting a space ends every session's access to its attachments at once. The controller then
deletes the space's prefix in the background with the service role. A failure is logged and
leaves the objects unreadable through a session. A signed URL that a member created before the
delete keeps working until it expires or the purge removes its object.

## Delivery to the runtime

A runtime that downloads attachments advertises the `attachmentDownloads` capability.

1. When such a runtime leases a turn, the controller collects the Storage attachments of the
   turn's message and of the conversation's last 10 user messages.
2. It keeps only names in the leased job's own space. A name from another space is never
   signed; it is logged, and the prompt reports it as unavailable.
3. It signs the rest in one request with the service-role key, for 10 minutes, and adds
   `attachment_downloads: [{ name, url, sizeBytes }]` to the leased payload.
4. Before the turn, the runtime downloads each entry to `.instafy/attachments/<name>`. Every
   lane that builds a turn prompt does this, parallel write-scoped workers included.
   - The name must be `<uuid>.<ext>`.
   - A file already there is kept.
   - Each download is capped at 20 MiB and 30 seconds.
   - Writes never follow a symlink.
   - A failure is logged by name and the turn continues.
5. The prompt lists an attachment only when this lease signed it and its file is present, with
   `view_image` for images. It names the rest as unavailable. A copy an earlier turn left on
   disk is not listed once the controller stops signing it, for example after its uploader
   deleted it. Storage attachments older than the last 10 user messages are not offered at all.

`.instafy/` is reserved: nothing under it is published. A `.gitignore` in
`.instafy/attachments/` also keeps the downloads out of every git status.

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

- `supabase/tests/chat_attachments.sql`, run by `scripts/test-durable-notifications.py`
  (see `supabase/tests/README.md`), covers the bucket and its policies against a Storage stub.
  That harness is run by hand, not in CI.
- `cargo test chat_attachments` in `packages/runtime-controller` covers path filtering, batched
  signing, the capability gate, the Storage probe and the space purge against stubs. With
  `TEST_DATABASE_URL`, `tests_chat_attachment_lease` also covers the lease route and the purge
  after `DELETE /projects/:projectId`.
- `cargo test chat_attachments` in `packages/runtime-agent` covers the download path, name and
  URL checks, the size cap and timeout, existing files, symlinks and the prompt section.
