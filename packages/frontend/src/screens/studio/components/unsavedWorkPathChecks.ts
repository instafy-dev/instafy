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

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * Whether a read or listing at a ref was served from another commit than
 * the row's `rev`, meaning the ref moved since the list loaded. Origins
 * answer `?ref=` reads and listings with `X-Instafy-Rev` set to the ref's
 * tip, or with no header at all (never `main`'s rev), so a missing header
 * never counts as moved.
 */
export function servedFromOtherRev(servedRev: string | null | undefined, rev: string): boolean {
  const served = servedRev?.trim();
  return Boolean(served) && served !== rev;
}

/**
 * What a ref holds at a path whose read answered 404: `absent` (the kept
 * work deletes it), `moved` (the ref no longer names `rev`) or `unknown`.
 */
export type RefPathAbsence = "absent" | "moved" | "unknown";

/**
 * A read of `path` at `ref` answered 404. That is a delete only when the
 * ref still resolves and its tree lacks the path: a ref that another viewer
 * removed answers 404 for every path too. A listing that shows entries
 * proves the ref resolves; a listing whose `X-Instafy-Rev` names another
 * commit means the ref moved since the list loaded.
 */
export async function confirmPathAbsentAtRef({
  projectId,
  originId,
  ref,
  rev,
  path,
}: {
  projectId: string;
  originId: string;
  ref: string;
  rev: string;
  path: string;
}): Promise<RefPathAbsence> {
  const target = normalizePath(path);
  const parent = parentFolder(target);
  const name = baseName(target);
  const list = (folder: string) =>
    controllerClient.workspace.files
      .listAt({ projectId, originId, path: folder, ref, routing: "default" })
      .catch(() => null);

  const listing = await list(parent);
  if (!listing || !listing.ok) {
    return "unknown";
  }
  if (servedFromOtherRev(listing.rev, rev)) {
    return "moved";
  }
  if (listing.entries.length > 0) {
    const listed = listing.entries.some(
      (entry) => entry.name === name || baseName(normalizePath(entry.path)) === name,
    );
    // Listed after all (a folder now, or hidden from reads): not a plain delete.
    return listed ? "unknown" : "absent";
  }
  if (!parent) {
    return "unknown";
  }
  // The parent lists nothing: the work removed that folder, or the ref is
  // gone. A root that lists entries at the ref tells the two apart.
  const root = await list("");
  if (!root || !root.ok) {
    return "unknown";
  }
  if (servedFromOtherRev(root.rev, rev)) {
    return "moved";
  }
  return root.entries.length > 0 ? "absent" : "unknown";
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
