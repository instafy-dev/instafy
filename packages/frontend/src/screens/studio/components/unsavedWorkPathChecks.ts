import { controllerClient, type OriginError } from "../../../sdk/instafy";
import { decodeBase64 } from "../../../services/runtimeController/workspaceUtils";
import { gitBlobOid } from "../../../utils/gitBlobOid";

/**
 * Checks that run before "Use this version" writes one file of unsaved work
 * as a new version. Each one answers "safe to write" only on positive
 * evidence; anything it cannot confirm stops the write.
 */

const STATUS_PAGE_LIMIT = 200;
const STATUS_MAX_PAGES = 10;

function normalizePath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function parentFolder(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

export type DesktopFolderPathCheck =
  | { ok: true; blobOid: string | null }
  | { ok: false; reason: "dirty" }
  | { ok: false; reason: "unchecked"; error: OriginError | null };

/**
 * Desktop only. The folder on this computer must hold no uncommitted edit of
 * `path`, and the write carries the blob the folder holds now (`expected`).
 * The blob is read first and the status second: an edit made before the
 * status call shows up as dirty, and an edit made after it no longer matches
 * `expected`, so the origin refuses the write instead of overwriting it.
 */
export async function checkDesktopFolderPath({
  projectId,
  originId,
  path,
}: {
  projectId: string;
  originId: string;
  path: string;
}): Promise<DesktopFolderPathCheck> {
  const target = normalizePath(path);
  const read = await controllerClient.workspace.files
    .readAt({ projectId, originId, path: target, routing: "default" })
    .catch(() => null);
  let blobOid: string | null;
  if (read?.ok) {
    blobOid = read.file.blobOid ?? (await gitBlobOid(decodeBase64(read.file.contentBase64)));
    if (!blobOid) {
      return { ok: false, reason: "unchecked", error: null };
    }
  } else if (read && read.notFound && !read.error.routeUnavailable) {
    // Not in the folder: the write must still find it absent.
    blobOid = null;
  } else {
    return { ok: false, reason: "unchecked", error: read ? read.error : null };
  }

  const scope = parentFolder(target);
  let offset = 0;
  for (let page = 0; page < STATUS_MAX_PAGES; page += 1) {
    const status = await controllerClient.workspace.git
      .fetchStatus({
        projectId,
        originId,
        routing: "default",
        scope: scope || null,
        limit: STATUS_PAGE_LIMIT,
        offset,
      })
      .catch(() => null);
    if (!status || !status.supported || status.busy || status.error) {
      return { ok: false, reason: "unchecked", error: null };
    }
    if (status.dirtyPaths.some((entry) => normalizePath(entry.path) === target)) {
      return { ok: false, reason: "dirty" };
    }
    if (!status.hasMoreFiles || status.dirtyPaths.length === 0) {
      return { ok: true, blobOid };
    }
    offset += status.dirtyPaths.length;
  }
  return { ok: false, reason: "unchecked", error: null };
}
