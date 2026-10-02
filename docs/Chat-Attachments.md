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
- Nobody updates an object, so an upload never replaces an existing one.
- Anonymous requests have no access, and nobody can reach another space's prefix.

Deleting a space takes access away at once. The controller then deletes the space's prefix in
the background with the service role. A failure is logged and leaves the objects unreadable.

## Delivery to the runtime

A runtime that downloads attachments advertises the `attachmentDownloads` capability.

1. When such a runtime leases a turn, the controller collects the Storage attachments of the
   turn's message and of the conversation's last 10 user messages.
2. It keeps only names in the leased job's own space. A name from another space is never
   signed; it is logged, and the prompt reports it as unavailable.
3. It signs the rest in one request with the service-role key, for 10 minutes, and adds
   `attachment_downloads: [{ name, url, sizeBytes }]` to the leased payload.
4. Before the turn, the runtime downloads each entry to `.instafy/attachments/<name>`.
   - The name must be `<uuid>.<ext>`.
   - A file already there is kept.
   - Each download is capped at 20 MiB and 30 seconds.
   - Writes never follow a symlink.
   - A failure is logged by name and the turn continues.
5. The prompt lists only the attachments whose file is present, with `view_image` for images.
   It names the rest as unavailable.

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
  service-role key and the bucket answers, and `attachments: "none"` otherwise. A client should
  turn attachment uploads off when it is `none`. The controller keeps the answer for 10 minutes, or
  1 minute after a failed check.
- Without a service-role key, nothing is signed and the prompt reports Storage attachments as
  unavailable.
- Runtimes download from the controller's `SUPABASE_PROJECT_URL`, so they must be able to reach
  it.

## Tests

- `supabase/tests/chat_attachments.sql`, run by `scripts/test-durable-notifications.py`
  (see `supabase/tests/README.md`), covers the bucket and its policies.
- `cargo test chat_attachments` in `packages/runtime-controller` covers path filtering, batched
  signing, the capability gate, the Storage probe and the space purge against stubs.
- `cargo test chat_attachments` in `packages/runtime-agent` covers the download path, name and
  URL checks, the size cap and timeout, existing files, symlinks and the prompt section.
