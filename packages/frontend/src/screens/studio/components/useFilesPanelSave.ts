import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  controllerClient,
  type ControllerWorkspaceEntry,
  type WorkspaceSaveRequest,
  type WorkspaceSaveResult,
} from "../../../sdk/instafy";
import type { CodeFile, CodeWorkspace } from "../../../types";
import { gitBlobOid } from "../../../utils/gitBlobOid";
import {
  advanceListingRevisions,
  bufferSaveOriginId,
  bufferVersioningMode,
  EMPTY_DIRECTORY_PLACEHOLDER,
  type FilesVersioning,
  type OwnRevisions,
} from "./filesVersioning";
import { raiseWorkspaceFileStaleNotice } from "./workspaceFileStaleNoticeStore";
import {
  describeSaveFailure,
  rejectedPathCopy,
  SAVE_COPY,
  staleSaveMessage,
  type SaveCopy,
} from "./workspaceSaveCopy";

/** The longest wait for a `503 fetch_pending` before the one retry. */
export const SAVE_FETCH_PENDING_RETRY_CAP_MS = 5_000;
const SAVE_FETCH_PENDING_DEFAULT_MS = 1_000;

type DirectoryEntries = Record<string, ControllerWorkspaceEntry[]>;

/** The buffer fields a save sets. */
type BufferIds = {
  generated: string;
  baseRev: string | null;
  blobOid: string | null;
  originId: string | null;
  isNew: boolean;
};

/**
 * A finished save's fields, applied on top of the store until the store
 * shows them (a trailing save can start before React re-renders). Once the
 * store has shown them, or a newer read replaced the buffer, the store is the
 * truth again.
 */
type PendingBufferUpdate = { after: BufferIds; at: number; seen: boolean };

export interface UseFilesPanelSaveOptions {
  /** Only the stateless and desktop modes save through this hook. */
  enabled: boolean;
  versioning: FilesVersioning;
  activeProjectId: string | null;
  readOnly: boolean;
  /** The default origin is reachable (gateway up, Desktop app online). */
  originAvailable: boolean;
  /** History lists Unsaved work for the default origin, so copy may point there. */
  unsavedWorkVisible?: boolean;
  /** The active buffer as the store has it now. */
  getActiveFile: () => CodeFile | null;
  /** The newest text of the active buffer (the editor's value when mounted). */
  getPendingContent: (file: CodeFile) => string;
  updateWorkspace: (
    updater: (current: CodeWorkspace) => CodeWorkspace,
    options?: { recordHistory?: boolean },
  ) => void;
  directoryRevsRef: MutableRefObject<Record<string, string | null>>;
  keepFoldersRef: MutableRefObject<Set<string>>;
  loadDirectory: (path: string, options?: { force?: boolean }) => Promise<ControllerWorkspaceEntry[] | null>;
  setDirectoryEntries: Dispatch<SetStateAction<DirectoryEntries>>;
  ownRevisions: OwnRevisions;
  /** Show a failure (or a partial save) with its copy; `retry` saves again. */
  presentFailure: (copy: SaveCopy, retry: () => void) => void;
  /** Test seam for the fetch_pending wait. */
  wait?: (ms: number) => Promise<void>;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function labelOf(file: Pick<CodeFile, "label" | "path">): string {
  return file.label || file.path.split("/").pop() || file.path;
}

function idsOf(file: CodeFile): BufferIds {
  return {
    generated: file.generated,
    baseRev: file.baseRev ?? null,
    blobOid: file.blobOid ?? null,
    originId: file.originId ?? null,
    isNew: file.isNew === true,
  };
}

/**
 * The store still holds the buffer a save started from (same base text and
 * read ids). A save that finishes after a reload took a newer version, or
 * after the active space changed, leaves that buffer alone.
 */
function isSameBuffer(candidate: CodeFile, file: CodeFile): boolean {
  return candidate.id === file.id && sameIds(idsOf(candidate), idsOf(file));
}

function sameIds(left: BufferIds, right: BufferIds): boolean {
  return (
    left.generated === right.generated &&
    left.baseRev === right.baseRev &&
    left.blobOid === right.blobOid &&
    left.originId === right.originId &&
    left.isNew === right.isNew
  );
}

function raiseStale(
  projectId: string,
  file: CodeFile,
  localText: string,
  originId: string | null,
  variant: "desktop" | null,
) {
  raiseWorkspaceFileStaleNotice({
    projectId,
    path: file.path,
    label: labelOf(file),
    baseText: file.generated,
    localText,
    detectedAt: Date.now(),
    originId,
    ...(variant ? { variant } : {}),
  });
}

const RESOLVE = { kind: "resolve" as const, label: "Resolve" };
const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One Save for the stateless and desktop modes (plan 2.3).
 *
 * A save is one manifest through `saveWorkspaceChanges`, pinned to the
 * buffer's origin. On the stateless gateway it carries the buffer's `baseRev`
 * and its blob as `expected`, and commits on apply; on a Desktop origin it
 * carries `expected` when the blob is known and is published by `/git/sync`.
 * A press while a save runs queues exactly one trailing save, which reads the
 * newest buffer and the revision the first save returned. A failure never
 * drops the buffer.
 */
export function useFilesPanelSave(options: UseFilesPanelSaveOptions) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const trailingRef = useRef(false);
  const pendingUpdatesRef = useRef(new Map<string, PendingBufferUpdate>());
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** The store's buffer, with a finished save applied if the store lags. */
  const effectiveBuffer = useCallback((file: CodeFile): CodeFile => {
    const pending = pendingUpdatesRef.current.get(file.path);
    if (!pending) {
      return file;
    }
    if (sameIds(idsOf(file), pending.after)) {
      pending.seen = true;
      return file;
    }
    if (pending.seen || (file.readAt ?? 0) > pending.at) {
      pendingUpdatesRef.current.delete(file.path);
      return file;
    }
    const { isNew, ...ids } = pending.after;
    const next: CodeFile = { ...file, ...ids };
    if (isNew) {
      next.isNew = true;
    } else {
      delete next.isNew;
    }
    return next;
  }, []);

  const updateBuffer = useCallback((file: CodeFile, after: BufferIds, savedText: string | null) => {
    const current = optionsRef.current;
    pendingUpdatesRef.current.set(file.path, { after, at: Date.now(), seen: false });
    const savedAt = savedText !== null ? new Date().toISOString() : null;
    const size = savedText !== null ? new TextEncoder().encode(savedText).length : null;
    // The code store outlives this panel, so a save that finishes after the
    // panel closed is still recorded on its buffer.
    current.updateWorkspace(
      (workspace) => {
        let matched = false;
        const files = workspace.files.map((candidate) => {
          if (!isSameBuffer(candidate, file)) {
            return candidate;
          }
          matched = true;
          const next: CodeFile = {
            ...candidate,
            generated: after.generated,
            modified: candidate.modified === candidate.generated ? after.generated : candidate.modified,
            baseRev: after.baseRev,
            blobOid: after.blobOid,
            originId: after.originId,
            ...(savedAt !== null && size !== null ? { modifiedAt: savedAt, size } : {}),
          };
          if (after.isNew) {
            next.isNew = true;
          } else {
            delete next.isNew;
          }
          return next;
        });
        if (!matched) {
          return workspace;
        }
        return { ...workspace, files, ...(savedAt !== null ? { lastAppliedAt: savedAt } : {}) };
      },
      { recordHistory: false },
    );
    if (savedAt === null || size === null || !mountedRef.current) {
      return;
    }
    const parent = parentOf(file.path);
    current.setDirectoryEntries((previous) => {
      const entries = previous[parent];
      if (!entries) {
        return previous;
      }
      const existing = entries.find((entry) => entry.path === file.path);
      const updated: ControllerWorkspaceEntry = {
        ...(existing ?? { name: labelOf(file), path: file.path, kind: "file" as const }),
        size,
        modified: savedAt,
        ...(after.blobOid ? { blobOid: after.blobOid } : {}),
      };
      return {
        ...previous,
        [parent]: existing
          ? entries.map((entry) => (entry.path === file.path ? updated : entry))
          : [...entries, updated],
      };
    });
  }, []);

  const runSave = useCallback(async () => {
    const current = optionsRef.current;
    const projectId = current.activeProjectId;
    const storeFile = current.getActiveFile();
    if (!current.enabled || !projectId || !storeFile || current.readOnly) {
      return;
    }
    const file = effectiveBuffer(storeFile);
    const content = current.getPendingContent(storeFile);
    if (content === file.generated && file.isNew !== true) {
      return;
    }
    // The save goes to the buffer's origin and is checked the way that
    // origin checks it, whatever the default origin is now.
    const originId = bufferSaveOriginId(file, current.versioning);
    const mode = bufferVersioningMode(file, current.versioning);
    const onDefaultOrigin = originId === current.versioning.originId;
    const label = labelOf(file);
    const retry = () => {
      void saveRef.current();
    };
    if (onDefaultOrigin && !current.originAvailable) {
      current.presentFailure(
        { message: mode === "desktop" ? SAVE_COPY.desktopUnreachable : SAVE_COPY.statelessUnreachable },
        retry,
      );
      return;
    }

    const path = file.path;
    const parent = parentOf(path);
    let baseRev: string | null = null;
    let blobOid: string | null = file.blobOid ?? null;

    if (mode === "stateless") {
      if (file.isNew === true) {
        baseRev = current.directoryRevsRef.current[parent] ?? null;
        if (!baseRev) {
          await current.loadDirectory(parent, { force: true });
          baseRev = current.directoryRevsRef.current[parent] ?? null;
        }
      } else {
        baseRev = file.baseRev ?? null;
        if (!baseRev) {
          // A buffer read without a revision (an older read, or one made
          // before a mode change): its edits apply only if the space still
          // holds the text they started from.
          const read = await controllerClient.workspace.files.readAt({ projectId, path, routing: "default", originId });
          if (read?.ok && read.file.rev && read.file.contentText === file.generated) {
            baseRev = read.file.rev;
            blobOid = read.file.blobOid ?? blobOid;
          } else if (read && !read.ok && !read.notFound) {
            current.presentFailure(describeSaveFailure({ error: read.error, mode, label }), retry);
            return;
          } else {
            raiseStale(projectId, file, content, originId, null);
            current.presentFailure({ message: staleSaveMessage(label), action: RESOLVE }, retry);
            return;
          }
        }
      }
      if (!baseRev) {
        current.presentFailure({ message: SAVE_COPY.deleteRequiresBaseRev }, retry);
        return;
      }
    }

    // A new file must not exist yet, unless an earlier save already wrote
    // it to the folder on this computer (its blob is then known).
    const expected: Record<string, string | null> | null =
      blobOid ? { [path]: blobOid } : file.isNew === true ? { [path]: null } : null;
    const keepPath = parent ? `${parent}/${EMPTY_DIRECTORY_PLACEHOLDER}` : EMPTY_DIRECTORY_PLACEHOLDER;
    // The explorer lists the default origin, so only a save there can
    // replace that origin's folder placeholder.
    const deletesKeep = onDefaultOrigin && current.keepFoldersRef.current.has(parent);
    const request: WorkspaceSaveRequest = {
      projectId,
      originId,
      files: [{ path, content, encoding: "utf8" }],
      ...(deletesKeep ? { deletes: [keepPath] } : {}),
      ...(mode === "stateless" && baseRev ? { baseRev } : {}),
      ...(expected ? { expected } : {}),
      syncMessage: `Update ${path}`,
    };

    // Known before the request: the commit event can arrive before the
    // response, and its listing then shows this blob (see OwnRevisions).
    const savedOid = await gitBlobOid(content);
    current.ownRevisions.addWrite(path, savedOid);
    let result: WorkspaceSaveResult = await controllerClient.workspace.save.changes(request);
    if (!result.ok && result.error.code === "fetch_pending") {
      const delay = Math.min(
        result.error.retryAfterMs ?? SAVE_FETCH_PENDING_DEFAULT_MS,
        SAVE_FETCH_PENDING_RETRY_CAP_MS,
      );
      await (current.wait ?? defaultWait)(Math.max(0, delay));
      result = await controllerClient.workspace.save.changes(request);
    }
    if (result.ok) {
      // Shared by every panel instance, so another panel never reloads on it.
      current.ownRevisions.add(result.rev);
      current.ownRevisions.add(result.report?.localRev ?? null);
    }
    // The panel may have closed while the save ran (a chat file surface, a
    // panel switch). The result is still recorded and reported; only a save
    // whose space is no longer the active one is left alone.
    if (mountedRef.current && optionsRef.current.activeProjectId !== projectId) {
      return;
    }
    const latest = optionsRef.current;
    const present = (copy: SaveCopy) => {
      if (mountedRef.current) {
        latest.presentFailure(copy, retry);
        return;
      }
      // Trying again needs the panel; the message still reaches the user.
      latest.presentFailure(copy.action?.kind === "retry" ? { message: copy.message } : copy, () => undefined);
    };

    if (!result.ok) {
      const copy = describeSaveFailure({
        error: result.error,
        mode,
        label,
        unsavedWorkVisible: onDefaultOrigin && current.unsavedWorkVisible === true,
      });
      if (copy.staleNotice) {
        raiseStale(projectId, file, content, originId, null);
      }
      if (result.applied) {
        // The edit reached the origin (a Desktop folder) but was not
        // published. The buffer stays unsaved (a new file stays new, even
        // when it is empty); only its blob follows the folder, so trying
        // again does not report a false conflict.
        updateBuffer(
          file,
          { ...idsOf(file), blobOid: savedOid, originId: result.originId ?? originId },
          null,
        );
      }
      present(copy);
      return;
    }

    updateBuffer(
      file,
      {
        generated: content,
        baseRev: mode === "stateless" ? result.rev ?? baseRev : null,
        blobOid: savedOid,
        originId: result.originId || originId,
        isNew: false,
      },
      content,
    );
    if (mode === "stateless" && onDefaultOrigin) {
      // The explorer's listings come from this origin: those at the commit
      // this save built on are current at the save's commit too.
      current.directoryRevsRef.current = advanceListingRevisions(
        current.directoryRevsRef.current,
        result.baseRev,
        result.rev,
      );
    }

    if (result.conflicted.includes(path)) {
      // Desktop: the space has a newer version. The user's bytes stay in the
      // folder and the work is kept for History.
      raiseStale(projectId, file, content, result.originId || originId, "desktop");
      present({ message: staleSaveMessage(label), action: RESOLVE });
      return;
    }
    if (deletesKeep) {
      current.keepFoldersRef.current.delete(parent);
    }
    const rejected = result.rejected.find((entry) => entry.path === path);
    if (rejected) {
      present(rejectedPathCopy(rejected.reason));
    }
  }, [effectiveBuffer, updateBuffer]);

  const save = useCallback(async () => {
    if (savingRef.current) {
      trailingRef.current = true;
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      do {
        trailingRef.current = false;
        await runSave();
      } while (trailingRef.current && mountedRef.current);
    } catch (error) {
      console.warn("[files-panel] save failed:", error);
      const current = optionsRef.current;
      const file = current.getActiveFile();
      const copy = describeSaveFailure({
        error: { status: 0, code: "network_error", message: String(error), routeUnavailable: false },
        mode: current.versioning.mode,
        label: file ? labelOf(file) : "file",
      });
      if (mountedRef.current) {
        current.presentFailure(copy, () => {
          void saveRef.current();
        });
      } else {
        current.presentFailure({ message: copy.message }, () => undefined);
      }
    } finally {
      savingRef.current = false;
      trailingRef.current = false;
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [runSave]);
  saveRef.current = save;

  return { save, saving };
}
