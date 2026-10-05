import { controllerClient } from "../../../sdk/instafy";
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
