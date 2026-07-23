# Desktop/Web Project Handoff Journey

This is a soft dogfood contract for AI-driven e2e review. It describes the expected user flow; it is not a new storage schema.

## Core Rule

The project filesystem has one source of truth. In hosted/git-canonical mode, Instafy canonical storage is the source of truth and every runtime uses a synced working copy. Desktop only becomes the file source of truth when the space is explicitly opened as a local-canonical folder.

The UI should always make the current source and any connected local working copy understandable before the user edits files.

## Existing Project Invite To Desktop

1. User opens an invite or existing project in the web app.
2. User chooses Open in Desktop.
3. Desktop opens the same project id and can start a Desktop runtime.
4. Files materialize under the Desktop runtime workspace root, `<desktop workspace root>/<project_id>/` by default, or in the user's linked folder when one is bound (see Folder Binding below).
5. Connections must show the canonical source and the Desktop working-copy path when available.
   - In the UI this is the `Project files` panel: `Stored in Instafy. Desktop and runtimes work on synced copies.` plus a `Copy on <hostname>` chip with the path when a local workspace presence is registered and not expired/offline.
   - The Desktop runtime supervisor (`@instafy/desktop-runtime-agent`) registers/heartbeats/unregisters that presence with the controller (`PUT/POST/DELETE /projects/:id/workspaces/local`). The `instafy` CLI runtime does not register presence yet (known follow-up).
6. The app must not imply that a GitHub checkout or arbitrary local folder is the source of truth unless the project is explicitly local-canonical.
   - Note: there is currently no frontend-visible per-project flag for local-canonical mode (origin `mode: desktop` is also used for synced Desktop working copies), so the panel must not derive a "your computer is the source" claim from origin mode alone.

## Folder Binding (Desktop)

1. In Connections → Project files, Desktop users can choose a folder on this computer for the space (`Choose folder…`).
2. An empty folder is accepted and onboarded: the runtime clones the canonical repo into it on next start (requires the controller to advertise a public git remote, see Sync Expectations).
3. A folder previously linked to the same space (`.instafy/space.json` with a matching `spaceId`) is adopted as-is.
4. A folder with other content — foreign files, another space's manifest — is rejected with a clear reason. Nothing is mixed, adopted, or overwritten silently.
5. Binding writes `.instafy/space.json` into the folder (CLI-compatible) and persists the mapping in the Desktop app config; the runtime receives it as `WORKSPACE_PROJECT_DIR` and works directly in that folder instead of `<workspace root>/<project_id>`.
6. Changing or resetting the binding requires a runtime restart to take effect; the UI says so.

## Web Project To Desktop

1. User creates or imports a project in the web app.
2. Web edits persist to the canonical workspace backend.
3. Opening the project in Desktop selects the same project id.
4. Desktop runtime work should sync from canonical storage before making file claims.
5. If Desktop is preferred for runs, the runtime selector should show that preference. If cloud is used instead, that should remain visible.

## Desktop And Web Roundtrip

1. Desktop edits write back through the same Origin/canonical path as web edits.
2. Web should see those changes after sync/reload.
3. Web edits should be visible to Desktop after sync/reload.
4. Conflicts must surface as source-control or save-conflict UI. Do not silently overwrite either side.

## Sync Expectations

What holds today (verified against the origin/git implementation):

- **Desktop becomes git-canonical only when the controller advertises a remote.** The runtime-token response includes `gitRemoteUrl` when `GIT_REMOTE_PUBLIC_BASE_URL` is configured on the controller; the Desktop supervisor wires it through as `ORIGIN_GIT_REMOTE_URL`. Without it, a Desktop working copy never syncs to canonical storage (dev-stack default).
- **Onboarding**: with a remote configured, an empty working-copy folder is populated by `git clone`-equivalent checkout on origin start. A non-empty, non-clone folder hard-fails origin startup rather than overwriting anything.
- **Write-back**: agent runs commit+push after apply (`/git/sync`); user edits via web `/apply` land directly in whichever origin serves the project and become dirty working-copy state until the next sync (`Save version`, agent auto-sync, or `/sync`).
- **Pull**: origins refresh from the remote lazily (~120s TTL on reads, forced on `/entries?sync=blocking`), fast-forward only, and never clobber dirty local edits.
- **Conflicts**: pushes are never forced; a rebase that cannot apply surfaces HTTP 409 → the Changes drawer / chat conflict card with the assistant-driven resolution playbook.
- **Eventing**: successful syncs emit `workspace.commit` to web clients over SSE; the file explorer refreshes and raises a stale-file merge notice instead of clobbering unsaved editor buffers.

Known non-guarantees (acceptable, but must not be misrepresented in UI):

- Out-of-band local edits (outside `/apply`) emit no events; they are picked up by polling reads and the next sync.
- Two runtimes for one project (e.g. hosted + Desktop) converge only through the canonical remote; web applies go to the controller-resolved origin only.
- An offline Desktop accumulates local edits silently; there is no queued sync.
- Controller restarts drop local-workspace presence until the next heartbeat re-registers it.

## Settings Deep-Linking

The Connections category is addressable as `?panel=settings&settingsTab=project&settingsCategory=providers`. `settingsCategory` survives reload and is carried by the Open-in-Desktop deep link (`instafy://studio?...`), which copies the current query string. The param is cleared when the settings panel closes.

## AI Dogfood Checks

- Ask: "Where are this project's files stored right now?" The expected answer names canonical storage and, if connected, the active local working-copy path.
- Ask for a tiny README edit from web, then verify Desktop sees it after sync.
- Ask for a tiny README edit from Desktop, then verify web sees it after sync.
- Ask whether a GitHub push happened. The answer must distinguish GitHub from Instafy internal canonical storage.
- Bind an empty folder to a space, start the Desktop runtime, and verify the canonical files appear in it.
- Try to bind a non-empty folder and verify the app refuses with an understandable reason.

## Stop Rules

- If the UI cannot show the source of truth or current local working copy, stop and improve the UI before adding more runtime behavior.
- If Desktop and web disagree about the active project id, stop on routing/session state.
- If a write claims GitHub success but only pushed to Instafy canonical storage, stop on GitHub publishing UX.
- If binding a used folder would mix two spaces' files, stop on conflict UX before any sync behavior.
