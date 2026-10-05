import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { LIST_ROW_SURFACE_BASE } from "../../../components/listRowStyles";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { controllerClient, type OriginApplyFile, type WorkspaceRecoveryEntry } from "../../../sdk/instafy";
import { decodeBase64 } from "../../../services/runtimeController/workspaceUtils";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { markUnsavedWorkSeen, readUnsavedWorkSeen, unsavedWorkSeenKey } from "../../../workspace/unsavedWorkSeen";
import {
  patchUnsavedWorkEntries,
  useUnsavedWork,
  useUnsavedWorkConflicts,
  type UnsavedWorkPathChoice,
} from "../../../workspace/unsavedWorkStore";
import { HistoryConfirmDialog } from "./HistoryConfirmDialog";
import {
  ALREADY_REMOVED_COPY,
  conflictedOnComputerCopy,
  desktopFolderUncheckedCopy,
  desktopFolderUnsupportedEntryCopy,
  formatFileCount,
  historyFailureCopy,
  keptOnComputerCopy,
  MAIN_BUSY_COPY,
  NO_UNSAVED_WORK_COPY,
  RECOVERY_REF_MOVED_COPY,
  REMOVE_DIALOG,
  REMOVED_COPY,
  RESTORE_CONFLICT_INTRO,
  restoreCancelledCopy,
  restoreConflictNoticeCopy,
  restoreDirtyPathsCopy,
  restoreSuccessCopy,
  UNSAVED_WORK_ERROR_COPY,
  UNSAVED_WORK_READ_FAILED_COPY,
  unsavedWorkAskAgentPrompt,
  unsavedWorkTitle,
  unsavedWorkUnconfirmedDeleteCopy,
  unsavedWorkUnsupportedEntryCopy,
  keptPathCopy,
  savedPathVersionCopy,
  type HistoryNotice,
  type HistoryOriginKind,
} from "./versioningCopy";
import { PROGRAMMATIC_FOCUS_CLASS, restoreLostFocus } from "./historyFocus";
import { checkDesktopFolderPath, confirmPathAbsentAtRef, servedFromOtherRev } from "./unsavedWorkPathChecks";
import { formatRelativeCommitTime } from "./workspaceGitReviewShared";

const LEASE_RETRY_DELAY_MS = 1_500;

/** Where keyboard focus goes once the control that had it is gone. */
type FocusRequest =
  | { kind: "path"; ref: string; path: string }
  | { kind: "conflict"; ref: string }
  | { kind: "row"; ref: string; index: number }
  /** The conflict panel closed: back to the row's Restore. */
  | { kind: "restore"; ref: string }
  /** The error row's Retry gave way to the list (or to nothing). */
  | { kind: "section" };

function byTestId(scope: ParentNode | null | undefined, testId: string): HTMLElement | null {
  return scope?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
}

/** "5 minutes ago · 2 files" */
function unsavedWorkMetaLine(entry: WorkspaceRecoveryEntry): string {
  return [entry.date ? formatRelativeCommitTime(entry.date) : null, formatFileCount(entry.paths.length)]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * Unsaved work kept on recovery and salvage refs. Hidden while empty or
 * when the server has no recovery route; an error row (never hidden) when
 * the list fails. Restore commits the work as a new version; a conflict
 * expands the row into one choice per file; Remove deletes it for everyone.
 */
export function UnsavedWorkSection({
  projectId,
  originId,
  originKind,
  canWrite,
  disabled,
  headRev,
  onBusyChange,
  onNotice,
  onCommitted,
  onAskAgent,
  onReloadHistory,
  onFocusFallback,
  userId = null,
}: {
  projectId: string;
  originId: string;
  originKind: HistoryOriginKind;
  canWrite: boolean;
  /** Another History action is running. */
  disabled: boolean;
  /** Newest known `main` (the first saved version). */
  headRev: string | null;
  onBusyChange: (busy: boolean) => void;
  onNotice: (notice: HistoryNotice) => void;
  onCommitted: (rev: string | null) => void;
  onAskAgent: (prompt: string, title: string) => void;
  /** Reload saved versions; resolves to the new `main`. */
  onReloadHistory: () => Promise<string | null>;
  /** Focus a stable place when nothing in this section can take focus. */
  onFocusFallback?: () => void;
  /** The viewer: entries shown here count as seen (no chat row, no salvage badge). */
  userId?: string | null;
}) {
  const { openGitReviewTab, requestUrlPush } = useWorkspaceTabs();
  const unsavedWork = useUnsavedWork({ projectId, originId, enabled: true, mountRefresh: "force" });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Shared with every mount: choices survive the drawer closing and reopening.
  const [conflicts, setConflicts] = useUnsavedWorkConflicts(projectId, originId);
  const [pendingRemove, setPendingRemove] = useState<WorkspaceRecoveryEntry | null>(null);
  const sectionLabelId = useId();
  const rowIdPrefix = useId();
  const locked = disabled || busyKey !== null;
  const { refresh } = unsavedWork;
  const sectionRef = useRef<HTMLElement | null>(null);
  const focusRequestRef = useRef<FocusRequest | null>(null);
  // Bumped with a request made after the render it needs already happened.
  const [, setFocusRequests] = useState(0);
  const entriesRef = useRef(unsavedWork.entries);
  entriesRef.current = unsavedWork.entries;

  const requestFocus = useCallback((request: FocusRequest) => {
    focusRequestRef.current = request;
    setFocusRequests((value) => value + 1);
  }, []);

  /** After this row's action: its own first action, or the row now in its place. */
  const requestRowFocus = useCallback(
    (ref: string) => {
      const index = entriesRef.current.findIndex((item) => item.ref === ref);
      requestFocus({ kind: "row", ref, index: Math.max(0, index) });
    },
    [requestFocus],
  );

  // Pressed controls unmount (a resolved file's buttons, a removed row): put
  // keyboard focus on the next thing to do once the section is idle again.
  useEffect(() => {
    const request = focusRequestRef.current;
    if (!request || locked) {
      return;
    }
    focusRequestRef.current = null;
    const rows = Array.from(
      sectionRef.current?.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-entry"]') ?? [],
    );
    const rowOf = (ref: string) => rows.find((element) => element.getAttribute("data-ref") === ref) ?? null;
    let moved: boolean;
    if (request.kind === "section") {
      moved = restoreLostFocus(byTestId(rows[0], "unsaved-work-review"));
    } else if (request.kind === "row") {
      const row = rowOf(request.ref) ?? rows[Math.min(request.index, rows.length - 1)] ?? null;
      moved = restoreLostFocus(byTestId(row, "unsaved-work-review"));
    } else if (request.kind === "restore") {
      const row = rowOf(request.ref);
      moved = restoreLostFocus(byTestId(row, "unsaved-work-restore"), byTestId(row, "unsaved-work-review"));
    } else {
      const row = rowOf(request.ref);
      const items = Array.from(row?.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]') ?? []);
      const start =
        request.kind === "path"
          ? Math.max(0, items.findIndex((element) => element.getAttribute("data-path") === request.path))
          : 0;
      const ordered = [...items.slice(start), ...items.slice(0, start)];
      moved = restoreLostFocus(
        ...ordered.map((element) => byTestId(element, "unsaved-work-path-use")),
        byTestId(row, "unsaved-work-restore-rest"),
        byTestId(row, "unsaved-work-finish-remove"),
        request.kind === "path" ? byTestId(items[start], "unsaved-work-path-resolved") : null,
        byTestId(row, "unsaved-work-review"),
      );
    }
    if (!moved) {
      onFocusFallback?.();
    }
  });

  const runAction = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusyKey(key);
      onBusyChange(true);
      try {
        await action();
      } finally {
        setBusyKey(null);
        onBusyChange(false);
      }
    },
    [onBusyChange],
  );

  const clearConflict = useCallback(
    (ref: string) => {
      setConflicts((previous) => {
        if (!(ref in previous)) {
          return previous;
        }
        const next = { ...previous };
        delete next[ref];
        return next;
      });
    },
    [setConflicts],
  );

  /** Close the per-file choices without restoring; files already saved stay saved. */
  const cancelConflict = useCallback(
    (ref: string, savedSome: boolean) => {
      requestFocus({ kind: "restore", ref });
      clearConflict(ref);
      onNotice({ tone: "info", text: restoreCancelledCopy(savedSome) });
    },
    [clearConflict, onNotice, requestFocus],
  );

  const refreshAfterMove = useCallback(() => {
    onNotice({ tone: "info", text: RECOVERY_REF_MOVED_COPY });
    void refresh({ force: true });
  }, [onNotice, refresh]);

  const restore = useCallback(
    async (
      entry: WorkspaceRecoveryEntry,
      options: { keep?: string[]; head?: string | null; retried?: boolean } = {},
    ): Promise<void> => {
      const baseRev = options.head ?? headRev ?? null;
      const result = await controllerClient.workspace.git.restoreRecovery({
        projectId,
        originId,
        ref: entry.ref,
        rev: entry.rev,
        baseRev,
        keep: options.keep ?? null,
        leaseConflictRetryDelayMs: LEASE_RETRY_DELAY_MS,
      });
      if (!result) {
        onNotice({ tone: "error", text: historyFailureCopy(null, originKind, "") });
        return;
      }
      if (result.ok) {
        requestRowFocus(entry.ref);
        // committed: false with marked: main already had the work, and an
        // empty version (result.rev) now records the restore. The copy
        // stays "nothing to restore", but main moved.
        onNotice({
          tone: result.committed === false ? "info" : "success",
          text: restoreSuccessCopy({
            committed: result.committed,
            notRestored: result.notRestored,
            reasons: result.notRestoredReasons,
            kept: options.keep ?? [],
            // A conflict entry lists only its conflicted paths, not all it holds.
            entryPaths: entry.kind === "conflict" ? null : entry.paths,
          }),
        });
        clearConflict(entry.ref);
        patchUnsavedWorkEntries(projectId, originId, (entries) =>
          result.refDeleted
            ? entries.filter((item) => item.ref !== entry.ref)
            : entries.map((item) => (item.ref === entry.ref ? { ...item, restoredRev: result.rev ?? item.rev } : item)),
        );
        if (result.committed !== false || result.marked) {
          onCommitted(result.rev);
        }
        void refresh({ force: true });
        return;
      }
      const error = result.error;
      switch (error.code) {
        case "restore_conflict": {
          const paths = error.paths && error.paths.length > 0 ? error.paths : entry.paths;
          // Restore gives way to the per-file choices: say why, and focus the first.
          requestFocus({ kind: "conflict", ref: entry.ref });
          onNotice({ tone: "warning", text: restoreConflictNoticeCopy(paths.length) });
          setConflicts((previous) => ({
            ...previous,
            [entry.ref]: {
              rev: entry.rev,
              head: error.head ?? baseRev,
              paths,
              resolutions: {},
            },
          }));
          return;
        }
        case "recovery_ref_moved":
          requestRowFocus(entry.ref);
          clearConflict(entry.ref);
          refreshAfterMove();
          return;
        case "head_moved": {
          if (options.retried) {
            onNotice({ tone: "error", text: MAIN_BUSY_COPY });
            return;
          }
          const head = error.head ?? (await onReloadHistory());
          await restore(entry, { ...options, head, retried: true });
          return;
        }
        case "dirty_paths":
          onNotice({ tone: "warning", text: restoreDirtyPathsCopy(error.paths ?? []) });
          return;
        default:
          onNotice({ tone: "error", text: historyFailureCopy(error, originKind, "Couldn't restore this work.") });
      }
    },
    [
      clearConflict,
      headRev,
      onCommitted,
      onNotice,
      onReloadHistory,
      originId,
      originKind,
      projectId,
      refresh,
      refreshAfterMove,
      requestFocus,
      requestRowFocus,
      setConflicts,
    ],
  );

  const remove = useCallback(
    async (entry: WorkspaceRecoveryEntry) => {
      const result = await controllerClient.workspace.git.dismissRecovery({
        projectId,
        originId,
        ref: entry.ref,
        rev: entry.rev,
        leaseConflictRetryDelayMs: LEASE_RETRY_DELAY_MS,
      });
      if (!result) {
        onNotice({ tone: "error", text: historyFailureCopy(null, originKind, "") });
        return;
      }
      if (result.ok) {
        requestRowFocus(entry.ref);
        onNotice({ tone: "success", text: result.missing ? ALREADY_REMOVED_COPY : REMOVED_COPY });
        clearConflict(entry.ref);
        patchUnsavedWorkEntries(projectId, originId, (entries) => entries.filter((item) => item.ref !== entry.ref));
        void refresh({ force: true });
        return;
      }
      if (result.error.code === "recovery_ref_moved") {
        refreshAfterMove();
        return;
      }
      onNotice({ tone: "error", text: historyFailureCopy(result.error, originKind, "Couldn't remove this work.") });
    },
    [clearConflict, onNotice, originId, originKind, projectId, refresh, refreshAfterMove, requestRowFocus],
  );

  const resolvePath = useCallback(
    (ref: string, path: string, resolution: UnsavedWorkPathChoice, head?: string | null) => {
      setConflicts((previous) => {
        const conflict = previous[ref];
        if (!conflict) {
          return previous;
        }
        return {
          ...previous,
          [ref]: {
            ...conflict,
            head: head === undefined ? conflict.head : head,
            resolutions: { ...conflict.resolutions, [path]: resolution },
          },
        };
      });
    },
    [setConflicts],
  );

  /**
   * "Use this version": read the kept file at the ref (into memory only,
   * never into the Files buffers) and save it on top of the head the
   * restore reported. A path the ref deletes becomes a delete.
   */
  const applyPathVersion = useCallback(
    async (entry: WorkspaceRecoveryEntry, path: string) => {
      const conflict = conflicts[entry.ref];
      const head = conflict?.head ?? headRev ?? null;
      const read = await controllerClient.workspace.files.readAt({
        projectId,
        originId,
        path,
        ref: entry.ref,
        routing: "default",
      });
      if (!read) {
        onNotice({ tone: "error", text: historyFailureCopy(null, originKind, "") });
        return;
      }
      let files: OriginApplyFile[] = [];
      let deletes: string[] = [];
      if (read.ok) {
        if (servedFromOtherRev(read.file.rev, entry.rev)) {
          // The ref holds newer work than the row the person chose from.
          clearConflict(entry.ref);
          refreshAfterMove();
          return;
        }
        files = [{ path, bytes: decodeBase64(read.file.contentBase64), encoding: "binary" }];
      } else if (read.error.code === "unsupported_entry") {
        // The path is a symlink (120000) or a submodule (160000) at the ref;
        // reads and listings both hide it, so it is never a delete.
        onNotice({ tone: "warning", text: unsavedWorkUnsupportedEntryCopy(path) });
        return;
      } else if (read.error.code === "rev_not_found") {
        // The ref itself no longer resolves: removed or restored elsewhere.
        clearConflict(entry.ref);
        refreshAfterMove();
        return;
      } else if (read.notFound && read.error.code === "not_found") {
        // Origins answer not_found only for a path absent from the ref's
        // tree. Still a delete only when a listing shows the ref resolves.
        const absence = await confirmPathAbsentAtRef({ projectId, originId, ref: entry.ref, rev: entry.rev, path });
        if (absence === "moved") {
          clearConflict(entry.ref);
          refreshAfterMove();
          return;
        }
        if (absence !== "absent") {
          onNotice({ tone: "error", text: UNSAVED_WORK_READ_FAILED_COPY });
          void refresh({ force: true });
          return;
        }
        deletes = [path];
      } else if (read.notFound && !read.error.routeUnavailable && !read.error.code) {
        // An uncoded 404 (single-tenant origins before they code theirs)
        // cannot tell a missing path from a hidden entry: never a delete.
        onNotice({ tone: "warning", text: unsavedWorkUnconfirmedDeleteCopy(path) });
        return;
      } else {
        onNotice({
          tone: "error",
          text: historyFailureCopy(read.error, originKind, "Couldn't read this file from the unsaved work."),
        });
        return;
      }
      // Desktop writes into the folder on this computer: never over edits
      // that exist in no commit, and only over the copy just checked.
      let expected: Record<string, string | null> | null = null;
      if (originKind === "desktop") {
        const folder = await checkDesktopFolderPath({ projectId, originId, path });
        if (!folder.ok) {
          onNotice(
            folder.reason === "dirty"
              ? { tone: "warning", text: restoreDirtyPathsCopy([path]) }
              : folder.reason === "unsupported"
                ? { tone: "warning", text: desktopFolderUnsupportedEntryCopy(path) }
                : { tone: "error", text: desktopFolderUncheckedCopy(folder.error) },
          );
          return;
        }
        expected = { [path]: folder.blobOid };
      }
      const saved = await controllerClient.workspace.save.changes({
        projectId,
        originId,
        files,
        deletes,
        baseRev: head,
        ...(expected ? { expected } : {}),
        leaseConflictRetryDelayMs: LEASE_RETRY_DELAY_MS,
      });
      if (!saved.ok) {
        if (originKind === "desktop" && saved.error.code === "head_moved") {
          // The folder's copy changed after the check.
          onNotice({ tone: "warning", text: restoreDirtyPathsCopy([path]) });
          return;
        }
        if (saved.error.code === "head_moved" || saved.error.code === "path_type_conflict") {
          setConflicts((previous) =>
            previous[entry.ref]
              ? { ...previous, [entry.ref]: { ...previous[entry.ref]!, head: saved.error.head ?? head } }
              : previous,
          );
          onNotice({ tone: "warning", text: `"${path}" changed again in the space. Choose a version again.` });
          return;
        }
        onNotice({ tone: "error", text: historyFailureCopy(saved.error, originKind, "Couldn't save this file.") });
        return;
      }
      if (saved.conflicted.includes(path)) {
        onNotice({ tone: "warning", text: conflictedOnComputerCopy([path]) });
        return;
      }
      const rejected = saved.rejected.filter((item) => item.path === path);
      if (rejected.length > 0) {
        onNotice({ tone: "warning", text: keptOnComputerCopy(rejected).join(" ") });
        return;
      }
      requestFocus({ kind: "path", ref: entry.ref, path });
      resolvePath(entry.ref, path, "use", saved.rev ?? head);
      onNotice({ tone: "success", text: savedPathVersionCopy(path) });
      if (saved.committed !== false) {
        onCommitted(saved.rev);
      }
    },
    [
      clearConflict,
      conflicts,
      headRev,
      onCommitted,
      onNotice,
      originId,
      originKind,
      projectId,
      refresh,
      refreshAfterMove,
      requestFocus,
      resolvePath,
      setConflicts,
    ],
  );

  const openReview = useCallback(
    (entry: WorkspaceRecoveryEntry) => {
      requestUrlPush();
      openGitReviewTab({
        kind: "unsavedWork",
        ref: entry.ref,
        rev: entry.rev,
        base: entry.base,
        title: unsavedWorkTitle(entry.kind),
        date: entry.date,
        entries: entry.paths.map((path) => ({ path, code: "" })),
        originId,
        initialMode: "all",
      });
    },
    [openGitReviewTab, originId, requestUrlPush],
  );

  const entries = useMemo(() => unsavedWork.entries, [unsavedWork.entries]);

  // This viewer has now seen these entries: the one-time chat row skips them,
  // and salvage (which cannot be removed) stops counting on the badge.
  useEffect(() => {
    if (!userId || unsavedWork.status !== "ok" || entries.length === 0) {
      return;
    }
    const seen = readUnsavedWorkSeen(projectId, userId);
    const fresh = entries.map(unsavedWorkSeenKey).filter((key) => !seen.has(key));
    if (fresh.length > 0) {
      markUnsavedWorkSeen(projectId, userId, fresh);
    }
  }, [entries, projectId, unsavedWork.status, userId]);

  const retryList = async () => {
    const snapshot = await refresh({ force: true });
    if (snapshot.status === "error") {
      // The error row stays, and Retry kept focus while it waited.
      return;
    }
    if (snapshot.status === "ok" && snapshot.entries.length === 0) {
      onNotice({ tone: "info", text: NO_UNSAVED_WORK_COPY });
    }
    requestFocus({ kind: "section" });
  };

  if (unsavedWork.status === "error") {
    return (
      <section className="flex flex-wrap items-center justify-between gap-2 px-1 py-1.5" data-testid="unsaved-work-error">
        <Text as="span" variant="body" tone="muted">
          {UNSAVED_WORK_ERROR_COPY}
        </Text>
        <Button
          variant="ghost"
          size="xs"
          radius="xl"
          onPress={() => void retryList()}
          isPending={unsavedWork.loading}
          data-testid="unsaved-work-retry"
        >
          Retry
        </Button>
      </section>
    );
  }

  if (unsavedWork.status !== "ok" || entries.length === 0) {
    return null;
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={sectionLabelId}
      className="flex flex-col gap-1"
      data-testid="unsaved-work-section"
    >
      <Text as="h3" id={sectionLabelId} variant="caption" tone="muted" className="px-1 py-1.5 font-medium">
        Unsaved work
      </Text>
      {entries.map((entry, entryIndex) => {
        const stored = conflicts[entry.ref];
        const conflict = stored && stored.rev === entry.rev ? stored : null;
        const title = unsavedWorkTitle(entry.kind);
        const meta = unsavedWorkMetaLine(entry);
        // Rows share titles by kind: the actions name their row by title and meta.
        const rowId = `${rowIdPrefix}-${entryIndex}`;
        const rowDescription = `${rowId}-title ${rowId}-meta`;
        const allResolved =
          conflict !== null && conflict.paths.every((path) => conflict.resolutions[path] !== undefined);
        const keptPaths = conflict
          ? conflict.paths.filter((path) => conflict.resolutions[path] === "keep")
          : [];
        return (
          <div
            key={entry.ref}
            className={[LIST_ROW_SURFACE_BASE, "px-2 py-2"].join(" ")}
            data-testid="unsaved-work-entry"
            data-kind={entry.kind}
            data-ref={entry.ref}
          >
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <div id={`${rowId}-title`} className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  {title}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span id={`${rowId}-meta`}>{meta}</span>
                  {entry.restoredRev ? (
                    <Badge tone="neutral" data-testid="unsaved-work-restored">
                      Restored
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  radius="xl"
                  aria-describedby={rowDescription}
                  onPress={() => openReview(entry)}
                  data-testid="unsaved-work-review"
                >
                  Review
                </Button>
                {conflict ? null : (
                  // While a restore conflict is open, "Restore the rest" is the
                  // one way on; a plain Restore would drop the per-file choices.
                  <Button
                    variant="ghost"
                    size="sm"
                    radius="xl"
                    isPending={busyKey === `${entry.ref}:restore`}
                    isDisabled={!canWrite || (locked && busyKey !== `${entry.ref}:restore`)}
                    aria-describedby={rowDescription}
                    onPress={() => void runAction(`${entry.ref}:restore`, () => restore(entry))}
                    data-testid="unsaved-work-restore"
                  >
                    Restore
                  </Button>
                )}
                {entry.dismissible ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    radius="xl"
                    isPending={busyKey === `${entry.ref}:remove`}
                    isDisabled={!canWrite || (locked && busyKey !== `${entry.ref}:remove`)}
                    aria-describedby={rowDescription}
                    onPress={() => setPendingRemove(entry)}
                    data-testid="unsaved-work-remove"
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>

            {conflict ? (
              <div
                className={`mt-2 border-t border-slate-200/70 pt-2 ${DARK_DIVIDER_BORDER_CLASS}`}
                data-testid="unsaved-work-conflict"
              >
                <Text variant="body" tone="secondary">
                  {RESTORE_CONFLICT_INTRO}
                </Text>
                <ul className="mt-1 flex flex-col gap-1">
                  {conflict.paths.map((path, index) => {
                    const pathId = `${rowId}-path-${index}`;
                    const resolution = conflict.resolutions[path];
                    const pathBusy = busyKey === `${entry.ref}:${path}`;
                    return (
                      <li
                        key={path}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
                        data-testid="unsaved-work-path"
                        data-path={path}
                      >
                        <span id={pathId} className="min-w-0 break-all font-mono text-xs text-slate-700 dark:text-slate-200">
                          {path}
                        </span>
                        {resolution ? (
                          <span
                            tabIndex={-1}
                            className={`inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 ${PROGRAMMATIC_FOCUS_CLASS}`}
                            data-testid="unsaved-work-path-resolved"
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            {resolution === "use" ? "Saved this version" : "Kept current"}
                          </span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1">
                            <Button
                              variant="ghost"
                              size="xs"
                              radius="xl"
                              aria-describedby={pathId}
                              isPending={pathBusy}
                              isDisabled={!canWrite || (locked && !pathBusy)}
                              onPress={() =>
                                void runAction(`${entry.ref}:${path}`, () => applyPathVersion(entry, path))
                              }
                              data-testid="unsaved-work-path-use"
                            >
                              Use this version
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              radius="xl"
                              aria-describedby={pathId}
                              isDisabled={!canWrite || locked}
                              onPress={() => {
                                requestFocus({ kind: "path", ref: entry.ref, path });
                                resolvePath(entry.ref, path, "keep");
                                onNotice({ tone: "info", text: keptPathCopy(path) });
                              }}
                              data-testid="unsaved-work-path-keep"
                            >
                              Keep current
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              radius="xl"
                              aria-describedby={pathId}
                              isDisabled={!canWrite || locked}
                              onPress={() => onAskAgent(unsavedWorkAskAgentPrompt(path, entry.ref), "Unsaved work")}
                              data-testid="unsaved-work-path-ask"
                            >
                              Ask the agent
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {!allResolved ? null : entry.kind === "conflict" ? (
                    // A conflict entry holds only these files: nothing is left to restore.
                    <Button
                      variant="outline"
                      size="sm"
                      radius="xl"
                      isDisabled={!canWrite || locked || !entry.dismissible}
                      aria-describedby={rowDescription}
                      onPress={() => setPendingRemove(entry)}
                      data-testid="unsaved-work-finish-remove"
                    >
                      Remove
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      radius="xl"
                      isPending={busyKey === `${entry.ref}:rest`}
                      isDisabled={!canWrite || (locked && busyKey !== `${entry.ref}:rest`)}
                      aria-describedby={rowDescription}
                      onPress={() =>
                        void runAction(`${entry.ref}:rest`, () =>
                          restore(entry, { keep: keptPaths, head: conflict.head }),
                        )
                      }
                      data-testid="unsaved-work-restore-rest"
                    >
                      Restore the rest
                    </Button>
                  )}
                  {/* The way out without restoring: salvage cannot be removed,
                      and the choices outlive closing the drawer. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    radius="xl"
                    isDisabled={locked}
                    aria-describedby={rowDescription}
                    onPress={() => cancelConflict(entry.ref, Object.values(conflict.resolutions).includes("use"))}
                    data-testid="unsaved-work-conflict-cancel"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <HistoryConfirmDialog
        isOpen={pendingRemove !== null}
        title={REMOVE_DIALOG.title}
        detail={pendingRemove ? `${unsavedWorkTitle(pendingRemove.kind)}, ${unsavedWorkMetaLine(pendingRemove)}` : null}
        body={REMOVE_DIALOG.body}
        cancelLabel={REMOVE_DIALOG.cancel}
        confirmLabel={REMOVE_DIALOG.confirm}
        destructive
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const entry = pendingRemove;
          setPendingRemove(null);
          if (entry) {
            void runAction(`${entry.ref}:remove`, () => remove(entry));
          }
        }}
        testId="unsaved-work-remove-dialog"
      />
    </section>
  );
}
