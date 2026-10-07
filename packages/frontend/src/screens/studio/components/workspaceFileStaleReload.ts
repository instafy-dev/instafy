import { controllerClient } from "../../../sdk/instafy";
import { useWorkspaceStore } from "../../../store";
import type { CodeFile, CodeWorkspace } from "../../../types";
import { isVersionedFilesMode, type FilesVersioning } from "./filesVersioning";
import { SAVE_COPY } from "./versioningCopy";
import type { WorkspaceFileStaleNotice } from "./workspaceFileStaleNoticeStore";

/**
 * Before "Reload latest" reads the space's version: a Desktop save that
 * conflicted left the user's bytes in the folder, so that copy is discarded
 * first (`/git/revert {paths}` on the Desktop origin; single-tenant only).
 * Other notices need nothing. Resolves false when the folder copy could not
 * be discarded, so the card stays and the reload does not run.
 */
export async function prepareStaleWorkspaceFileReload(
  notice: WorkspaceFileStaleNotice,
  projectId: string | null,
): Promise<boolean> {
  if (notice.variant !== "desktop" || !projectId) {
    return true;
  }
  const reverted = await controllerClient.workspace.git
    .revertPaths({
      projectId,
      paths: [notice.path],
      routing: "default",
      originId: notice.originId ?? null,
    })
    .catch(() => null);
  return reverted?.ok === true;
}

type UpdateWorkspace = (
  updater: (current: CodeWorkspace) => CodeWorkspace,
  options?: { recordHistory?: boolean },
) => void;

/**
 * What became of a Reload latest read. `superseded`: another space became
 * active while it was on the wire.
 */
export type StaleBufferLoad = "loaded" | "superseded" | "failed";

/**
 * "Reload latest" puts the space's version into the shared Files buffer
 * itself: every Files viewer shows that buffer, but the viewer that reloads
 * on an open event may not be mounted (the chat is showing, and a file shown
 * in the chat takes no open events). Reads the way the Files panel does:
 * pinned to the default origin in the versioned modes, through the runtime
 * in legacy mode. The buffer is untouched unless the result is `loaded`.
 */
export async function loadLatestIntoStaleBuffer({
  projectId,
  path,
  versioning,
  runtimeId,
  updateWorkspace,
}: {
  projectId: string;
  path: string;
  versioning: FilesVersioning;
  runtimeId: string | null;
  updateWorkspace: UpdateWorkspace;
}): Promise<StaleBufferLoad> {
  const versioned = isVersionedFilesMode(versioning);
  const read = await controllerClient.workspace.files
    .readAt(
      versioned
        ? { projectId, path, routing: "default", originId: versioning.originId }
        : { projectId, path, runtimeId },
    )
    .catch(() => null);
  // The buffers are the active space's: CodeProvider takes another space's
  // code without remounting, so a read that answers after a switch would
  // land on that space's file at the same path.
  if (useWorkspaceStore.getState().activeProjectId !== projectId) {
    return "superseded";
  }
  const file = read?.ok ? read.file : null;
  if (!file?.isText) {
    return "failed";
  }
  const text = file.contentText ?? "";
  const readAt = Date.now();
  updateWorkspace(
    (current) => ({
      ...current,
      files: current.files.map((buffer) => {
        if (buffer.id !== path) {
          return buffer;
        }
        // A fresh read, as opening the file would make: the read ids are
        // this read's (none in legacy mode) and the file is in the space.
        const next: CodeFile = {
          ...buffer,
          mimeType: file.mimeType ?? buffer.mimeType ?? null,
          size: file.size ?? buffer.size ?? null,
          generated: text,
          modified: text,
        };
        delete next.isNew;
        if (versioned) {
          next.baseRev = file.rev ?? null;
          next.blobOid = file.blobOid ?? null;
          next.originId = file.originId ?? versioning.originId ?? null;
          next.readAt = readAt;
        } else {
          delete next.baseRev;
          delete next.blobOid;
          delete next.originId;
          delete next.readAt;
        }
        return next;
      }),
    }),
    { recordHistory: false },
  );
  return "loaded";
}

export type StaleReloadResult =
  | { status: "reloaded" }
  /** Another space is active: its card is hidden, and this one stays for later. */
  | { status: "superseded" }
  /** The card stays, with this error, and the buffer keeps the edits. */
  | { status: "failed"; error: string };

/**
 * The chat card's "Reload latest". On `reloaded` the card can go: the buffer
 * holds the space's version, and a Files viewer that is showing has been told
 * to open the file.
 */
export async function reloadStaleWorkspaceFile({
  notice,
  projectId,
  versioning,
  runtimeId,
  updateWorkspace,
}: {
  notice: WorkspaceFileStaleNotice;
  projectId: string | null;
  versioning: FilesVersioning;
  runtimeId: string | null;
  updateWorkspace: UpdateWorkspace;
}): Promise<StaleReloadResult> {
  if (!(await prepareStaleWorkspaceFileReload(notice, projectId))) {
    return { status: "failed", error: SAVE_COPY.desktopReloadFailed };
  }
  // Into the buffer directly: no Files viewer may be listening for an
  // open event while the chat is showing.
  const loaded = projectId
    ? await loadLatestIntoStaleBuffer({ projectId, path: notice.path, versioning, runtimeId, updateWorkspace })
    : "failed";
  if (loaded === "superseded") {
    return { status: "superseded" };
  }
  if (loaded !== "loaded") {
    return { status: "failed", error: SAVE_COPY.reloadLatestFailed };
  }
  // A Files viewer that is showing opens the file and reads it as before.
  // No pending open is left for a viewer mounted later: it would reload
  // again over edits made after this one.
  window.dispatchEvent(
    new CustomEvent("instafy:open-workspace-file", { detail: { projectId, path: notice.path } }),
  );
  return { status: "reloaded" };
}
