import type { ControllerWorkspaceEntry, VersioningMode } from "../../../sdk/instafy";
import type { CodeFile } from "../../../types";

/**
 * How the Files panel talks to the space's files.
 *
 * - `legacy` keeps today's requests (runtime-first reads, Save draft and
 *   Save version) byte for byte.
 * - `stateless` and `desktop` read and write the controller's default origin
 *   (pinned by `originId`) and save every edit as a version with one Save.
 */
export interface FilesVersioning {
  mode: VersioningMode;
  /** The default origin the reads and writes are pinned to. */
  originId: string | null;
}

export const LEGACY_FILES_VERSIONING: FilesVersioning = Object.freeze({
  mode: "legacy",
  originId: null,
});

/** One Save, pinned routing, revision-aware reads. */
export function isVersionedFilesMode(versioning: FilesVersioning | null | undefined): boolean {
  return versioning?.mode === "stateless" || versioning?.mode === "desktop";
}

/** The placeholder a new folder holds until a file is saved into it. */
export const EMPTY_DIRECTORY_PLACEHOLDER = ".instafy.keep";

/** A buffer has edits to save: changed text, or a new file never saved. */
export function isFileBufferDirty(file: Pick<CodeFile, "modified" | "generated" | "isNew">): boolean {
  return file.modified !== file.generated || file.isNew === true;
}

export type CachedOpenDecision = "reuse" | "refetch" | "stale";

/**
 * What to do when a file that already has a buffer is opened again
 * (plan 2.3, cache table). The listing's blob id is compared with the blob
 * the buffer was read at:
 *
 * | buffer | listing blob                                     | action  |
 * |--------|--------------------------------------------------|---------|
 * | clean  | equal                                            | reuse   |
 * | clean  | different, or the buffer lacks its read ids      | refetch |
 * | dirty  | equal                                            | reuse   |
 * | dirty  | different                                        | stale   |
 * | dirty  | the buffer lacks its read ids                    | stale   |
 *
 * A buffer "lacks its read ids" when, on the stateless gateway, it has no
 * `baseRev` (a save could not be checked against newer versions), or, on a
 * Desktop origin, no `blobOid`. When either blob id is missing otherwise the
 * two cannot be compared: a clean buffer is fetched again and a dirty one is
 * kept (its save still sends `baseRev`, so it cannot overwrite a newer
 * version). A new, never-saved buffer is always reused.
 */
export function decideCachedOpen(params: {
  cached: Pick<CodeFile, "modified" | "generated" | "isNew" | "blobOid" | "baseRev">;
  listingBlobOid: string | null | undefined;
  mode: VersioningMode;
}): CachedOpenDecision {
  const { cached, listingBlobOid, mode } = params;
  if (cached.isNew === true) {
    return "reuse";
  }
  const dirty = isFileBufferDirty(cached);
  const lacksReadIds = mode === "stateless" ? !cached.baseRev : !cached.blobOid;
  if (lacksReadIds) {
    return dirty ? "stale" : "refetch";
  }
  if (!listingBlobOid || !cached.blobOid) {
    return dirty ? "reuse" : "refetch";
  }
  if (listingBlobOid === cached.blobOid) {
    return "reuse";
  }
  return dirty ? "stale" : "refetch";
}

/** Revisions this tab wrote itself, so their commit events are not reloads. */
export interface OwnRevisions {
  add: (rev: string | null | undefined) => void;
  has: (rev: string | null | undefined) => boolean;
}

export const OWN_REVISION_WINDOW_MS = 60_000;

export function createOwnRevisions(now: () => number = Date.now): OwnRevisions {
  const revisions = new Map<string, number>();
  const prune = () => {
    const cutoff = now() - OWN_REVISION_WINDOW_MS;
    for (const [rev, at] of revisions) {
      if (at < cutoff) {
        revisions.delete(rev);
      }
    }
  };
  return {
    add(rev) {
      const value = rev?.trim();
      if (!value) {
        return;
      }
      prune();
      revisions.set(value, now());
    },
    has(rev) {
      const value = rev?.trim();
      if (!value) {
        return false;
      }
      prune();
      return revisions.has(value);
    },
  };
}

/**
 * After this tab's own commit `rev`, made on top of `parentRev`, every folder
 * that was listed at `parentRev` is current at `rev` too: the commit holds
 * only this tab's change, which the panel already shows. A later delete, new
 * file or folder then sends the newer revision instead of one that its own
 * commit moved past. Folders listed at any other revision keep theirs, so a
 * folder delete still expands at what the user actually saw.
 */
export function advanceListingRevisions(
  revs: Record<string, string | null>,
  parentRev: string | null | undefined,
  rev: string | null | undefined,
): Record<string, string | null> {
  const from = parentRev?.trim();
  const to = rev?.trim();
  if (!from || !to || from === to) {
    return revs;
  }
  let next = revs;
  for (const [path, listed] of Object.entries(revs)) {
    if (listed === from) {
      if (next === revs) {
        next = { ...revs };
      }
      next[path] = to;
    }
  }
  return next;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * Show never-saved file buffers in their folder's listing, so a new file
 * keeps its row (with the unsaved dot) across reloads until its first Save.
 * Folders that were never listed are left alone.
 */
export function mergeNewFileBuffers(
  directoryEntries: Record<string, ControllerWorkspaceEntry[]>,
  files: CodeFile[],
  sortEntries: (entries: ControllerWorkspaceEntry[]) => ControllerWorkspaceEntry[],
): Record<string, ControllerWorkspaceEntry[]> {
  let next = directoryEntries;
  for (const file of files) {
    if (file.isNew !== true) {
      continue;
    }
    const parent = parentOf(file.path);
    const entries = next[parent];
    if (!entries || entries.some((entry) => entry.path === file.path)) {
      continue;
    }
    if (next === directoryEntries) {
      next = { ...directoryEntries };
    }
    next[parent] = sortEntries([
      ...entries,
      {
        name: file.label || file.path.split("/").pop() || file.path,
        path: file.path,
        kind: "file",
        size: null,
        modified: null,
        mimeType: file.mimeType ?? null,
      },
    ]);
  }
  return next;
}
