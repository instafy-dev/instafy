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

export type CachedOpenDecision = "reuse" | "refetch" | "stale" | "verify";

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
 * | dirty  | the buffer lacks its read ids                    | verify  |
 *
 * A buffer "lacks its read ids" when, on the stateless gateway, it has no
 * `baseRev` (a save could not be checked against newer versions), or, on a
 * Desktop origin, no `blobOid`, or when it was read from another origin than
 * the one the panel reads now (its ids say nothing about this origin's
 * version). `verify` reads the file once: when the space still holds the
 * buffer's base text, the draft takes that read's ids and nothing is shown;
 * otherwise the stale notice is raised. When either blob id is missing
 * otherwise the two cannot be compared: a clean buffer is fetched again and a
 * dirty one is kept (its save still sends `baseRev`, so it cannot overwrite a
 * newer version). A new, never-saved buffer is always reused.
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
    return dirty ? "verify" : "refetch";
  }
  if (!listingBlobOid || !cached.blobOid) {
    return dirty ? "reuse" : "refetch";
  }
  if (listingBlobOid === cached.blobOid) {
    return "reuse";
  }
  return dirty ? "stale" : "refetch";
}

/** The fields a save sets on a buffer. */
export type SavedBufferIds = {
  generated: string;
  baseRev: string | null;
  blobOid: string | null;
  originId: string | null;
  isNew: boolean;
};

export function savedBufferIds(file: CodeFile): SavedBufferIds {
  return {
    generated: file.generated,
    baseRev: file.baseRev ?? null,
    blobOid: file.blobOid ?? null,
    originId: file.originId ?? null,
    isNew: file.isNew === true,
  };
}

export function sameSavedBufferIds(left: SavedBufferIds, right: SavedBufferIds): boolean {
  return (
    left.generated === right.generated &&
    left.baseRev === right.baseRev &&
    left.blobOid === right.blobOid &&
    left.originId === right.originId &&
    left.isNew === right.isNew
  );
}

function withSavedBufferIds(file: CodeFile, ids: SavedBufferIds): CodeFile {
  const { isNew, ...rest } = ids;
  const next: CodeFile = { ...file, ...rest };
  if (isNew) {
    next.isNew = true;
  } else {
    delete next.isNew;
  }
  return next;
}

/** A file an own commit wrote, with the blob it holds now. */
export type OwnCommitWrite = {
  path: string;
  blobOid: string | null;
  size?: number | null;
  modified?: string | null;
};

/** A commit this tab made from a Files panel: a save, a delete, a new folder. */
export interface OwnCommit {
  projectId: string;
  /** The origin it was written to; panels listing another origin leave it alone. */
  originId: string | null;
  /** The commit's actual parent (the gateway's answer); null when the origin keeps no revisions. */
  parentRev: string | null;
  rev: string | null;
  writes: OwnCommitWrite[];
  /** Deleted paths; a folder goes with everything in it. */
  deletes: string[];
}

/**
 * This tab's own saves, shared by every Files panel instance (the Files tab,
 * the explorer drawer, a chat file surface), so none of them mistakes one for
 * a change made in the space.
 */
export interface OwnRevisions {
  /** Revisions this tab wrote itself, so their commit events are not reloads. */
  add: (rev: string | null | undefined) => void;
  has: (rev: string | null | undefined) => boolean;
  /**
   * A blob this tab is saving at a path, registered before the request is
   * sent: the save's commit event can arrive before its response, and a
   * listing that shows this blob is then this tab's own edit, not a change
   * made in the space. Only while the save runs: the returned release is
   * called once it settles, after which the saved buffer (or the failure)
   * speaks for itself, and a later commit that brings the same blob back is
   * someone else's change.
   */
  addWrite: (path: string, blobOid: string | null | undefined) => () => void;
  hasWrite: (path: string, blobOid: string | null | undefined) => boolean;
  /**
   * A finished save of `path` in `projectId`: a buffer that the code store
   * still shows at `before` reads as `after` until the store catches up
   * (React applies the update on its next render, and a trailing save or a
   * commit event can come first). A buffer read after the save finished is
   * not lagging: it shows the file as the space has it now, even when that is
   * the text the save started from again (a Desktop read has no revision that
   * would tell the two apart).
   */
  noteSaved: (projectId: string, path: string, before: SavedBufferIds, after: SavedBufferIds) => void;
  /** `file` as this tab's last finished save of it left it. */
  latest: (projectId: string | null, file: CodeFile) => CodeFile;
  /**
   * Record a commit this tab made (its revision is own) and pass it to every
   * mounted Files panel, which shows it in its explorer and moves its listing
   * revisions past it: the commit's event is ignored as own, so no panel
   * would list the folders again.
   */
  recordCommit: (commit: OwnCommit) => void;
  subscribe: (listener: (commit: OwnCommit) => void) => () => void;
}

export const OWN_REVISION_WINDOW_MS = 60_000;

export function createOwnRevisions(now: () => number = Date.now): OwnRevisions {
  const revisions = new Map<string, number>();
  /** Saves in flight per path and blob (two panels can save the same bytes). */
  const writes = new Map<string, number>();
  const saved = new Map<string, { before: SavedBufferIds; after: SavedBufferIds; at: number }>();
  const prune = () => {
    const cutoff = now() - OWN_REVISION_WINDOW_MS;
    for (const [key, at] of revisions) {
      if (at < cutoff) {
        revisions.delete(key);
      }
    }
  };
  const writeKey = (path: string, blobOid: string | null | undefined) => {
    const oid = blobOid?.trim();
    return path && oid ? `${path}\u0000${oid}` : null;
  };
  const savedKey = (projectId: string, path: string) => `${projectId}\u0000${path}`;
  const listeners = new Set<(commit: OwnCommit) => void>();
  const add = (rev: string | null | undefined) => {
    const value = rev?.trim();
    if (!value) {
      return;
    }
    prune();
    revisions.set(value, now());
  };
  return {
    recordCommit(commit) {
      add(commit.rev);
      for (const listener of Array.from(listeners)) {
        try {
          listener(commit);
        } catch (error) {
          console.warn("[files-panel] failed to apply an own commit:", error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    addWrite(path, blobOid) {
      const key = writeKey(path, blobOid);
      if (!key) {
        return () => undefined;
      }
      writes.set(key, (writes.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = (writes.get(key) ?? 1) - 1;
        if (remaining > 0) {
          writes.set(key, remaining);
        } else {
          writes.delete(key);
        }
      };
    },
    hasWrite(path, blobOid) {
      const key = writeKey(path, blobOid);
      return key ? writes.has(key) : false;
    },
    noteSaved(projectId, path, before, after) {
      if (projectId && path) {
        saved.set(savedKey(projectId, path), { before, after, at: now() });
      }
    },
    latest(projectId, file) {
      if (!projectId) {
        return file;
      }
      const key = savedKey(projectId, file.path);
      const entry = saved.get(key);
      if (!entry) {
        return file;
      }
      if ((file.readAt ?? 0) <= entry.at && sameSavedBufferIds(savedBufferIds(file), entry.before)) {
        return withSavedBufferIds(file, entry.after);
      }
      // The store shows the save now, or the buffer moved on (a newer read).
      saved.delete(key);
      return file;
    },
    add,
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

let sharedOwnRevisions = createOwnRevisions();

/**
 * The one record of this tab's own saves. Every Files panel instance uses it,
 * and so does a panel mounted after a save started.
 */
export function filesOwnRevisions(): OwnRevisions {
  return sharedOwnRevisions;
}

export function resetFilesOwnRevisionsForTests(): void {
  sharedOwnRevisions = createOwnRevisions();
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

function isAtOrUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Apply an own commit to a panel's listing revisions and placeholder folders.
 * `folders` are the listed folders that show what the commit built on (listed
 * at its parent, or without a revision, as on a Desktop origin); only those
 * take its changes, so a folder listed at another commit keeps what it shows.
 */
export function applyOwnCommitToListings(
  listings: { revs: Record<string, string | null>; keepFolders: ReadonlySet<string> },
  commit: Pick<OwnCommit, "parentRev" | "rev" | "writes" | "deletes">,
): { revs: Record<string, string | null>; keepFolders: Set<string>; folders: Set<string> } {
  const parent = commit.parentRev?.trim() || null;
  const folders = new Set<string>();
  for (const [folder, rev] of Object.entries(listings.revs)) {
    if (!rev || (parent !== null && rev === parent)) {
      folders.add(folder);
    }
  }
  let revs = advanceListingRevisions(listings.revs, commit.parentRev, commit.rev);
  const keepFolders = new Set(listings.keepFolders);
  for (const write of commit.writes) {
    if (baseNameOf(write.path) === EMPTY_DIRECTORY_PLACEHOLDER) {
      keepFolders.add(parentOf(write.path));
    }
  }
  for (const deleted of commit.deletes) {
    if (baseNameOf(deleted) === EMPTY_DIRECTORY_PLACEHOLDER) {
      keepFolders.delete(parentOf(deleted));
    }
    for (const folder of Array.from(keepFolders)) {
      if (isAtOrUnder(folder, deleted)) {
        keepFolders.delete(folder);
      }
    }
    for (const folder of Object.keys(revs)) {
      if (folder && isAtOrUnder(folder, deleted)) {
        revs = revs === listings.revs ? { ...revs } : revs;
        delete revs[folder];
        folders.delete(folder);
      }
    }
  }
  return { revs, keepFolders, folders };
}

/**
 * Show an own commit in the listings of `folders` (see
 * `applyOwnCommitToListings`): a written file gets its new blob, or appears
 * with any folder that is new; a deleted path disappears, and so do the
 * listings of a deleted folder.
 */
export function applyOwnCommitToEntries(
  entries: Record<string, ControllerWorkspaceEntry[]>,
  folders: ReadonlySet<string>,
  commit: Pick<OwnCommit, "writes" | "deletes">,
  sortEntries: (entries: ControllerWorkspaceEntry[]) => ControllerWorkspaceEntry[],
): Record<string, ControllerWorkspaceEntry[]> {
  let next = entries;
  const writable = () => {
    if (next === entries) {
      next = { ...entries };
    }
    return next;
  };
  const listedIn = (folder: string) => (folders.has(folder) ? next[folder] : undefined);
  for (const deleted of commit.deletes) {
    for (const folder of Object.keys(next)) {
      if (folder && isAtOrUnder(folder, deleted)) {
        delete writable()[folder];
      }
    }
    const parent = parentOf(deleted);
    const listed = listedIn(parent);
    if (listed?.some((entry) => entry.path === deleted)) {
      writable()[parent] = listed.filter((entry) => entry.path !== deleted);
    }
  }
  for (const write of commit.writes) {
    const segments = write.path.split("/");
    let parent = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const folder = parent ? `${parent}/${segments[index]}` : segments[index];
      const listed = listedIn(parent);
      if (listed && !listed.some((entry) => entry.path === folder)) {
        writable()[parent] = sortEntries([...listed, { name: segments[index], path: folder, kind: "directory" }]);
      }
      parent = folder;
    }
    const name = segments[segments.length - 1];
    const listed = listedIn(parent);
    if (!listed || name === EMPTY_DIRECTORY_PLACEHOLDER) {
      continue;
    }
    const existing = listed.find((entry) => entry.path === write.path);
    const updated: ControllerWorkspaceEntry = {
      ...(existing ?? { name, path: write.path, kind: "file" as const }),
      ...(write.size !== undefined ? { size: write.size } : {}),
      ...(write.modified !== undefined ? { modified: write.modified } : {}),
      ...(write.blobOid ? { blobOid: write.blobOid } : {}),
    };
    writable()[parent] = existing
      ? listed.map((entry) => (entry.path === write.path ? updated : entry))
      : sortEntries([...listed, updated]);
  }
  return next;
}

/**
 * The folders an own commit changed that did not take it in place (`folders`
 * from `applyOwnCommitToListings`): every folder above a written or deleted
 * path, up to `rootPath`, since the commit can add or drop an entry in each.
 * Their listing was cleared by a scope change or is at another commit.
 */
export function foldersMissingOwnCommit(
  commit: Pick<OwnCommit, "writes" | "deletes">,
  folders: ReadonlySet<string>,
  rootPath = "",
): string[] {
  const missing = new Set<string>();
  const changed = [...commit.writes.map((write) => write.path), ...commit.deletes];
  for (const path of changed) {
    let folder = path;
    while (folder !== rootPath) {
      folder = parentOf(folder);
      if (rootPath && !isAtOrUnder(folder, rootPath)) {
        break;
      }
      if (!folders.has(folder)) {
        missing.add(folder);
      }
    }
  }
  return Array.from(missing);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * Show never-saved file buffers in their folder's listing, so a new file
 * keeps its row (with the unsaved dot) across reloads until its first Save.
 * A new file in a folder that is not in the space yet ("notes/todo.md")
 * also keeps that folder's row: the folder is added to every listed parent
 * that lacks it, with a listing of its own. A folder that is in the space
 * but was never listed is left alone; it is listed when it is opened.
 */
export function mergeNewFileBuffers(
  directoryEntries: Record<string, ControllerWorkspaceEntry[]>,
  files: CodeFile[],
  sortEntries: (entries: ControllerWorkspaceEntry[]) => ControllerWorkspaceEntry[],
): Record<string, ControllerWorkspaceEntry[]> {
  let next = directoryEntries;
  const writable = () => {
    if (next === directoryEntries) {
      next = { ...directoryEntries };
    }
    return next;
  };
  /** Add `entry` to `parent`'s listing; true when it was not there. */
  const ensure = (parent: string, entry: ControllerWorkspaceEntry): boolean => {
    const entries = next[parent];
    if (!entries || entries.some((candidate) => candidate.path === entry.path)) {
      return false;
    }
    writable()[parent] = sortEntries([...entries, entry]);
    return true;
  };
  for (const file of files) {
    if (file.isNew !== true) {
      continue;
    }
    const segments = file.path.split("/");
    let parent = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const folder = parent ? `${parent}/${segments[index]}` : segments[index];
      const added = ensure(parent, { name: segments[index], path: folder, kind: "directory" });
      if (added && !next[folder]) {
        // Not in the space yet: it holds only new buffers.
        writable()[folder] = [];
      }
      parent = folder;
    }
    ensure(parentOf(file.path), {
      name: file.label || segments[segments.length - 1] || file.path,
      path: file.path,
      kind: "file",
      size: null,
      modified: null,
      mimeType: file.mimeType ?? null,
    });
  }
  return next;
}
