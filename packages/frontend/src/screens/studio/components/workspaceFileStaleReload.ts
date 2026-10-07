import { controllerClient } from "../../../sdk/instafy";
import type { CodeFile, CodeWorkspace } from "../../../types";
import { isVersionedFilesMode, type FilesVersioning } from "./filesVersioning";
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

/**
 * "Reload latest" puts the space's version into the shared Files buffer
 * itself: every Files viewer shows that buffer, but the viewer that reloads
 * on an open event may not be mounted (the chat is showing, and a file shown
 * in the chat takes no open events). Reads the way the Files panel does:
 * pinned to the default origin in the versioned modes, through the runtime
 * in legacy mode. Resolves false, with the buffer untouched, when the
 * version could not be read as text.
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
  updateWorkspace: (updater: (current: CodeWorkspace) => CodeWorkspace, options?: { recordHistory?: boolean }) => void;
}): Promise<boolean> {
  const versioned = isVersionedFilesMode(versioning);
  const read = await controllerClient.workspace.files
    .readAt(
      versioned
        ? { projectId, path, routing: "default", originId: versioning.originId }
        : { projectId, path, runtimeId },
    )
    .catch(() => null);
  const file = read?.ok ? read.file : null;
  if (!file?.isText) {
    return false;
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
  return true;
}
