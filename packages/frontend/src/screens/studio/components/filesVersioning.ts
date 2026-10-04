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

/**
 * The origin a buffer's save goes to. A buffer keeps the origin it was read
 * from (plan 2.1.7), so an edit read from the folder on this computer is never
 * written to the gateway by accident. A new file that was never written
 * anywhere is created where the space is saved now.
 */
export function bufferSaveOriginId(
  file: Pick<CodeFile, "originId" | "isNew" | "blobOid">,
  versioning: FilesVersioning,
): string | null {
  if (file.isNew === true && !file.blobOid) {
    return versioning.originId ?? file.originId ?? null;
  }
  return file.originId ?? versioning.originId ?? null;
}

/**
 * How a save to the buffer's origin is checked. On the default origin that is
 * the current mode. A buffer from another origin (the Desktop app went offline
 * or came online since the read) follows what its read recorded: only the
 * stateless gateway serves a commit (`baseRev`); a Desktop read has a blob id
 * and no commit.
 */
export function bufferVersioningMode(
  file: Pick<CodeFile, "originId" | "isNew" | "blobOid" | "baseRev">,
  versioning: FilesVersioning,
): VersioningMode {
  const originId = bufferSaveOriginId(file, versioning);
  if (!originId || originId === versioning.originId) {
    return versioning.mode;
  }
  return file.baseRev ? "stateless" : "desktop";
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
 * Desktop origin, no `blobOid`, or when it was read from another origin than
 * the one the panel reads now (its ids say nothing about this origin's
 * version). When either blob id is missing otherwise the
 * two cannot be compared: a clean buffer is fetched again and a dirty one is
 * kept (its save still sends `baseRev`, so it cannot overwrite a newer
 * version). A new, never-saved buffer is always reused.
 */
export function decideCachedOpen(params: {
  cached: Pick<CodeFile, "modified" | "generated" | "isNew" | "blobOid" | "baseRev" | "originId">;
  listingBlobOid: string | null | undefined;
  mode: VersioningMode;
  /** The origin the panel reads now. */
  originId?: string | null;
}): CachedOpenDecision {
  const { cached, listingBlobOid, mode } = params;
  if (cached.isNew === true) {
    return "reuse";
  }
  const dirty = isFileBufferDirty(cached);
  const otherOrigin = Boolean(cached.originId && params.originId && cached.originId !== params.originId);
  const lacksReadIds = otherOrigin || (mode === "stateless" ? !cached.baseRev : !cached.blobOid);
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
  /**
   * A blob this tab is saving at a path, registered before the request is
   * sent: the save's commit event can arrive before its response, and a
   * listing that shows this blob is then this tab's own edit, not a change
   * made in the space.
   */
  addWrite: (path: string, blobOid: string | null | undefined) => void;
  hasWrite: (path: string, blobOid: string | null | undefined) => boolean;
}

export const OWN_REVISION_WINDOW_MS = 60_000;

export function createOwnRevisions(now: () => number = Date.now): OwnRevisions {
  const revisions = new Map<string, number>();
  const writes = new Map<string, number>();
  const prune = () => {
    const cutoff = now() - OWN_REVISION_WINDOW_MS;
    for (const entries of [revisions, writes]) {
      for (const [key, at] of entries) {
        if (at < cutoff) {
          entries.delete(key);
        }
      }
    }
  };
  const writeKey = (path: string, blobOid: string | null | undefined) => {
    const oid = blobOid?.trim();
    return path && oid ? `${path}\u0000${oid}` : null;
  };
  return {
    addWrite(path, blobOid) {
      const key = writeKey(path, blobOid);
      if (!key) {
        return;
      }
      prune();
      writes.set(key, now());
    },
    hasWrite(path, blobOid) {
      const key = writeKey(path, blobOid);
      if (!key) {
        return false;
      }
      prune();
      return writes.has(key);
    },
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
