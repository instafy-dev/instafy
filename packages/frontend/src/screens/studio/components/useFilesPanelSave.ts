import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  controllerClient,
  type ControllerWorkspaceEntry,
  type WorkspaceSaveRequest,
  type WorkspaceSaveResult,
} from "../../../sdk/instafy";
import type { UpdateWorkspaceOptions } from "../../../code/useCode";
import {
  originAutoRetryDelayMs,
  type OriginAutoRetryBudget,
} from "../../../services/runtimeController/originErrors";
import { useWorkspaceStore } from "../../../store";
import type { CodeFile, CodeWorkspace } from "../../../types";
import { gitBlobOid } from "../../../utils/gitBlobOid";
import {
  bufferSaveOriginId,
  bufferVersioningMode,
  EMPTY_DIRECTORY_PLACEHOLDER,
  sameSavedBufferIds,
  savedBufferIds,
  type FilesVersioning,
  type OwnRevisions,
  type SavedBufferIds,
} from "./filesVersioning";
import { raiseWorkspaceFileStaleNotice } from "./workspaceFileStaleNoticeStore";
import {
  describeSaveFailure,
  rejectedPathCopy,
  SAVE_COPY,
  staleSaveMessage,
  type SaveCopy,
} from "./versioningCopy";

/**
 * The longest wait before the one retry a save makes on its own, after a
 * `503 fetch_pending`, `writes_busy` or `mirror_reset`.
 */
export const SAVE_RETRY_LATER_CAP_MS = 5_000;
const SAVE_AUTO_RETRY_BUDGET: OriginAutoRetryBudget = {
  defaultDelayMs: 1_000,
  maxDelayMs: SAVE_RETRY_LATER_CAP_MS,
};

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
  /** Any buffer as the store has it now (a retry saves the file that failed). */
  getFile: (fileId: string) => CodeFile | null;
  /** The newest text of the active buffer (the editor's value when mounted). */
  getPendingContent: (file: CodeFile) => string;
  /** The open space's code (the code provider's update). */
  updateWorkspace: (
    updater: (current: CodeWorkspace) => CodeWorkspace,
    options?: UpdateWorkspaceOptions,
  ) => void;
  directoryRevsRef: MutableRefObject<Record<string, string | null>>;
  keepFoldersRef: MutableRefObject<Set<string>>;
  loadDirectory: (path: string, options?: { force?: boolean }) => Promise<ControllerWorkspaceEntry[] | null>;
  ownRevisions: OwnRevisions;
  /**
   * Show a failure (or a partial save) with its copy. `retry` saves that file
   * again and settles once that save, and any save queued behind it, has
   * finished. Pressed while another save runs, it only queues the one trailing
   * save and settles at once; after the panel has closed, it saves nothing.
   */
  presentFailure: (copy: SaveCopy, retry: () => Promise<void>) => void;
  /** Test seam for the wait before the save's own retry. */
  wait?: (ms: number) => Promise<void>;
}

/** A save of one buffer; without a file id, the active one. */
export type SaveRequest = { fileId?: string | null };

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function labelOf(file: Pick<CodeFile, "label" | "path">): string {
  return file.label || file.path.split("/").pop() || file.path;
}

/**
 * The store still holds the buffer a save started from (same base text and
 * read ids). A save that finishes after a reload took a newer version, or
 * after the active space changed, leaves that buffer alone.
 */
function isSameBuffer(candidate: CodeFile, file: CodeFile): boolean {
  return candidate.id === file.id && sameSavedBufferIds(savedBufferIds(candidate), savedBufferIds(file));
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
/** The retry a failure carries once its panel has closed. */
const noRetry = (): Promise<void> => Promise.resolve();
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
  /** The one save queued behind the running one (its file, or the active one). */
  const trailingRef = useRef<{ fileId: string | null } | null>(null);
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const saveRef = useRef<(request?: SaveRequest) => Promise<void>>(async () => undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateBuffer = useCallback((
    projectId: string,
    file: CodeFile,
    after: SavedBufferIds,
    saved: { at: string; size: number } | null,
  ) => {
    const current = optionsRef.current;
    // Every panel (and a trailing save) reads the buffer this way until the
    // store shows it.
    current.ownRevisions.noteSaved(projectId, file.path, savedBufferIds(file), after);
    const savedAt = saved?.at ?? null;
    const size = saved?.size ?? null;
    const update = (workspace: CodeWorkspace): CodeWorkspace => {
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
    };
    // The buffers outlive this panel, and the save is recorded wherever its
    // space's buffers are now: the open space's in the code provider (which
    // passes the update to the store when Studio closed meanwhile), another
    // space's in the store, until the user goes back to it.
    if (useWorkspaceStore.getState().activeProjectId === projectId) {
      current.updateWorkspace(update, { recordHistory: false, keepAfterUnmount: true });
    } else {
      useWorkspaceStore.getState().updateProjectCode(projectId, update);
    }
  }, []);

  const runSave = useCallback(async (fileId: string | null) => {
    const current = optionsRef.current;
    const projectId = current.activeProjectId;
    const storeFile = fileId ? current.getFile(fileId) : current.getActiveFile();
    if (!current.enabled || !projectId || !storeFile || current.readOnly) {
      return;
    }
    // A save that just finished may not be in the store yet.
    const file = current.ownRevisions.latest(projectId, storeFile);
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
    // Trying again saves this file, even when another one is open by then.
    const retry = () => saveRef.current({ fileId: file.id });
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
        // The listing that showed the path free (listing the folder also
        // tells whether it holds the placeholder). A folder that is not in
        // the space yet has no revision of its own, so the nearest listed
        // parent folder's revision stands for it.
        const listedRev = (folder: string): string | null =>
          current.directoryRevsRef.current[folder] || (folder ? listedRev(parentOf(folder)) : null);
        baseRev = current.directoryRevsRef.current[parent] ?? null;
        if (!baseRev) {
          await current.loadDirectory(parent, { force: true });
          baseRev = listedRev(parent);
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
    const releaseWrite = current.ownRevisions.addWrite(path, savedOid);
    try {
      let result: WorkspaceSaveResult = await controllerClient.workspace.save.changes(request);
      // The gateway asked for a moment: it was still fetching the space
      // (fetch_pending), every write slot stayed taken (writes_busy) or its
      // copy of the space is being made again (mirror_reset). The save asks
      // once more after Retry-After (at most 5 s); a full disk (disk_full) is
      // left to the person. The change may already be in the space (an apply
      // that landed before its sync failed, or a push whose answer was lost),
      // and on the stateless gateway that is safe: the same change on a main
      // that already holds it answers committed:false and writes nothing. A
      // Desktop folder's apply that landed is never sent twice.
      const retryDelay =
        !result.ok && (!result.applied || mode === "stateless")
          ? originAutoRetryDelayMs(result.error, SAVE_AUTO_RETRY_BUDGET)
          : null;
      if (retryDelay !== null) {
        await (current.wait ?? defaultWait)(retryDelay);
        result = await controllerClient.workspace.save.changes(request);
      }
      const saved = result.ok
        ? { at: new Date().toISOString(), size: new TextEncoder().encode(content).length }
        : null;
      if (result.ok && saved) {
        // Every Files panel shows the save in its explorer and moves its
        // listings past the commit; none reloads on the commit's event.
        current.ownRevisions.recordCommit({
          projectId,
          originId,
          parentRev: mode === "stateless" ? result.baseRev ?? null : null,
          rev: result.rev ?? null,
          writes: [{ path, blobOid: savedOid, size: saved.size, modified: saved.at }],
          deletes: deletesKeep && !result.conflicted.includes(path) ? [keepPath] : [],
        });
        current.ownRevisions.add(result.report?.localRev ?? null);
      }
      // The panel may have closed while the save ran (a chat file surface, a
      // panel switch, another space, leaving Studio). The result is still
      // recorded on its space's buffers. Once the user is in another space,
      // nothing is reported there: a stale card waits in its own space's chat,
      // and the buffer there still shows its unsaved edits.
      const otherSpaceOpen =
        useWorkspaceStore.getState().activeProjectId !== projectId ||
        (mountedRef.current && optionsRef.current.activeProjectId !== projectId);
      const latest = optionsRef.current;
      const present = (copy: SaveCopy) => {
        if (otherSpaceOpen) {
          return;
        }
        if (mountedRef.current) {
          latest.presentFailure(copy, retry);
          return;
        }
        // Trying again needs the panel; the message still reaches the user.
        latest.presentFailure(copy.action?.kind === "retry" ? { message: copy.message } : copy, noRetry);
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
            projectId,
            file,
            { ...savedBufferIds(file), blobOid: savedOid, originId: result.originId ?? originId },
            null,
          );
        }
        present(copy);
        return;
      }

      updateBuffer(
        projectId,
        file,
        {
          generated: content,
          baseRev: mode === "stateless" ? result.rev ?? baseRev : null,
          blobOid: savedOid,
          originId: result.originId || originId,
          isNew: false,
        },
        saved,
      );

      if (result.conflicted.includes(path)) {
        // Desktop: the space has a newer version. The user's bytes stay in the
        // folder and the work is kept for History.
        raiseStale(projectId, file, content, result.originId || originId, "desktop");
        present({ message: staleSaveMessage(label), action: RESOLVE });
        return;
      }
      const rejected = result.rejected.find((entry) => entry.path === path);
      if (rejected) {
        present(rejectedPathCopy(rejected.reason));
      }
    } finally {
      // By now the save is recorded (its revision and the saved buffer), or
      // it failed: either way the write is no longer in flight.
      releaseWrite();
    }
  }, [updateBuffer]);

  const save = useCallback(async (request?: SaveRequest) => {
    // A save starts only from a mounted panel (its editor holds the newest
    // text); one that is running when the panel closes still finishes.
    if (!mountedRef.current) {
      return;
    }
    const requested = { fileId: request?.fileId ?? null };
    if (savingRef.current) {
      trailingRef.current = requested;
      return;
    }
    savingRef.current = true;
    setSaving(true);
    // The save running now; a press meanwhile replaces the queued one.
    let target: { fileId: string | null } | null = requested;
    const queued = () => (mountedRef.current ? trailingRef.current : null);
    try {
      while (target) {
        trailingRef.current = null;
        await runSave(target.fileId);
        target = queued();
      }
    } catch (error) {
      console.warn("[files-panel] save failed:", error);
      const current = optionsRef.current;
      const fileId = target?.fileId ?? null;
      const file = fileId ? current.getFile(fileId) : current.getActiveFile();
      const copy = describeSaveFailure({
        error: { status: 0, code: "network_error", message: String(error), routeUnavailable: false },
        mode: current.versioning.mode,
        label: file ? labelOf(file) : "file",
      });
      if (mountedRef.current) {
        current.presentFailure(copy, () => saveRef.current(file ? { fileId: file.id } : undefined));
      } else {
        current.presentFailure({ message: copy.message }, noRetry);
      }
    } finally {
      savingRef.current = false;
      trailingRef.current = null;
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [runSave]);
  saveRef.current = save;

  return { save, saving };
}
