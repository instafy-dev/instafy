import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  controllerClient,
  type ControllerWorkspaceEntry,
  type WorkspaceSaveRequest,
  type WorkspaceSaveResult,
} from "../../../sdk/instafy";
import type { CodeFile, CodeWorkspace } from "../../../types";
import { gitBlobOid } from "../../../utils/gitBlobOid";
import { EMPTY_DIRECTORY_PLACEHOLDER, type FilesVersioning, type OwnRevisions } from "./filesVersioning";
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
    current.updateWorkspace(
      (workspace) => ({
        ...workspace,
        files: workspace.files.map((candidate) => {
          if (candidate.id !== file.id) {
            return candidate;
          }
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
        }),
        ...(savedAt !== null ? { lastAppliedAt: savedAt } : {}),
      }),
      { recordHistory: false },
    );
    if (savedAt === null || size === null) {
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
    const mode = current.versioning.mode;
    const file = effectiveBuffer(storeFile);
    const content = current.getPendingContent(storeFile);
    if (content === file.generated && file.isNew !== true) {
      return;
    }
    const label = labelOf(file);
    const retry = () => {
      void saveRef.current();
    };
    if (!current.originAvailable) {
      current.presentFailure(
        { message: mode === "desktop" ? SAVE_COPY.desktopUnreachable : SAVE_COPY.statelessUnreachable },
        retry,
      );
      return;
    }

    const path = file.path;
    const parent = parentOf(path);
    const originId = file.originId ?? current.versioning.originId ?? null;
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

    const expected: Record<string, string | null> | null =
      file.isNew === true ? { [path]: null } : blobOid ? { [path]: blobOid } : null;
    const keepPath = parent ? `${parent}/${EMPTY_DIRECTORY_PLACEHOLDER}` : EMPTY_DIRECTORY_PLACEHOLDER;
    const deletesKeep = current.keepFoldersRef.current.has(parent);
    const request: WorkspaceSaveRequest = {
      projectId,
      originId,
      files: [{ path, content, encoding: "utf8" }],
      ...(deletesKeep ? { deletes: [keepPath] } : {}),
      ...(mode === "stateless" && baseRev ? { baseRev } : {}),
      ...(expected ? { expected } : {}),
      syncMessage: `Update ${path}`,
    };

    let result: WorkspaceSaveResult = await controllerClient.workspace.save.changes(request);
    if (!result.ok && result.error.code === "fetch_pending") {
      const delay = Math.min(
        result.error.retryAfterMs ?? SAVE_FETCH_PENDING_DEFAULT_MS,
        SAVE_FETCH_PENDING_RETRY_CAP_MS,
      );
      await (current.wait ?? defaultWait)(Math.max(0, delay));
      result = await controllerClient.workspace.save.changes(request);
    }
    if (!mountedRef.current) {
      return;
    }
    const latest = optionsRef.current;

    if (!result.ok) {
      const copy = describeSaveFailure({ error: result.error, mode, label });
      if (copy.staleNotice) {
        raiseStale(projectId, file, content, originId, null);
      }
      if (result.applied) {
        // The edit reached the origin (a Desktop folder) but was not
        // published. The buffer stays unsaved; only its blob follows the
        // folder, so trying again does not report a false conflict.
        updateBuffer(
          file,
          { ...idsOf(file), blobOid: await gitBlobOid(content), originId: result.originId ?? originId, isNew: false },
          null,
        );
      }
      latest.presentFailure(copy, retry);
      return;
    }

    const savedOid = await gitBlobOid(content);
    updateBuffer(
      file,
      {
        generated: content,
        baseRev: mode === "stateless" ? result.rev ?? baseRev : file.baseRev ?? null,
        blobOid: savedOid,
        originId: result.originId || originId,
        isNew: false,
      },
      content,
    );
    current.ownRevisions.add(result.rev);
    current.ownRevisions.add(result.report?.localRev ?? null);

    if (result.conflicted.includes(path)) {
      // Desktop: the space has a newer version. The user's bytes stay in the
      // folder and the work is kept for History.
      raiseStale(projectId, file, content, result.originId || originId, "desktop");
      latest.presentFailure({ message: staleSaveMessage(label), action: RESOLVE }, retry);
      return;
    }
    if (deletesKeep) {
      current.keepFoldersRef.current.delete(parent);
    }
    const rejected = result.rejected.find((entry) => entry.path === path);
    if (rejected) {
      latest.presentFailure(rejectedPathCopy(rejected.reason), retry);
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
      current.presentFailure(
        describeSaveFailure({
          error: { status: 0, code: "network_error", message: String(error), routeUnavailable: false },
          mode: current.versioning.mode,
          label: file ? labelOf(file) : "file",
        }),
        () => {
          void saveRef.current();
        },
      );
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
