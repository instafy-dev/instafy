import { useCallback, useId, useMemo, useState } from "react";
import { Check } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { LIST_ROW_SURFACE_BASE } from "../../../components/listRowStyles";
import { DARK_DIVIDER_BORDER_CLASS } from "../../../theme/darkSurfaces";
import { controllerClient, type OriginApplyFile, type WorkspaceRecoveryEntry } from "../../../sdk/instafy";
import { decodeBase64 } from "../../../services/runtimeController/workspaceUtils";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { patchUnsavedWorkEntries, useUnsavedWork } from "../../../workspace/unsavedWorkStore";
import { HistoryConfirmDialog } from "./HistoryConfirmDialog";
import {
  ALREADY_REMOVED_COPY,
  conflictedOnComputerCopy,
  desktopFolderUncheckedCopy,
  formatFileCount,
  historyFailureCopy,
  keptOnComputerCopy,
  MAIN_BUSY_COPY,
  RECOVERY_REF_MOVED_COPY,
  REMOVE_DIALOG,
  REMOVED_COPY,
  RESTORE_CONFLICT_INTRO,
  restoreDirtyPathsCopy,
  restoreSuccessCopy,
  UNSAVED_WORK_ERROR_COPY,
  unsavedWorkAskAgentPrompt,
  unsavedWorkTitle,
  type HistoryNotice,
  type HistoryOriginKind,
} from "./historyCopy";
import { checkDesktopFolderPath } from "./unsavedWorkPathChecks";
import { formatRelativeCommitTime } from "./workspaceGitReviewShared";

const LEASE_RETRY_DELAY_MS = 1_500;

type PathResolution = "use" | "keep";

type RestoreConflict = {
  /** `main` when the restore refused; per-file saves build on it. */
  head: string | null;
  paths: string[];
  resolutions: Record<string, PathResolution>;
};

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
}) {
  const { openGitReviewTab, requestUrlPush } = useWorkspaceTabs();
  const unsavedWork = useUnsavedWork({ projectId, originId, enabled: true, mountRefresh: "force" });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, RestoreConflict>>({});
  const [pendingRemove, setPendingRemove] = useState<WorkspaceRecoveryEntry | null>(null);
  const sectionLabelId = useId();
  const pathIdPrefix = useId();
  const locked = disabled || busyKey !== null;
  const { refresh } = unsavedWork;

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

  const clearConflict = useCallback((ref: string) => {
    setConflicts((previous) => {
      if (!(ref in previous)) {
        return previous;
      }
      const next = { ...previous };
      delete next[ref];
      return next;
    });
  }, []);

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
        onNotice({ tone: "success", text: restoreSuccessCopy(result.notRestored) });
        clearConflict(entry.ref);
        patchUnsavedWorkEntries(projectId, originId, (entries) =>
          result.refDeleted
            ? entries.filter((item) => item.ref !== entry.ref)
            : entries.map((item) => (item.ref === entry.ref ? { ...item, restoredRev: result.rev ?? item.rev } : item)),
        );
        if (result.committed !== false) {
          onCommitted(result.rev);
        }
        void refresh({ force: true });
        return;
      }
      const error = result.error;
      switch (error.code) {
        case "restore_conflict":
          setConflicts((previous) => ({
            ...previous,
            [entry.ref]: {
              head: error.head ?? baseRev,
              paths: error.paths && error.paths.length > 0 ? error.paths : entry.paths,
              resolutions: {},
            },
          }));
          return;
        case "recovery_ref_moved":
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
    [clearConflict, headRev, onCommitted, onNotice, onReloadHistory, originId, originKind, projectId, refresh, refreshAfterMove],
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
    [clearConflict, onNotice, originId, originKind, projectId, refresh, refreshAfterMove],
  );

  const resolvePath = useCallback((ref: string, path: string, resolution: PathResolution, head?: string | null) => {
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
  }, []);

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
        files = [{ path, bytes: decodeBase64(read.file.contentBase64), encoding: "binary" }];
      } else if (read.notFound) {
        deletes = [path];
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
      resolvePath(entry.ref, path, "use", saved.rev ?? head);
      if (saved.committed !== false) {
        onCommitted(saved.rev);
      }
    },
    [conflicts, headRev, onCommitted, onNotice, originId, originKind, projectId, resolvePath],
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
          onPress={() => void refresh({ force: true })}
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
    <section aria-labelledby={sectionLabelId} className="flex flex-col gap-1" data-testid="unsaved-work-section">
      <Text as="h3" id={sectionLabelId} variant="caption" tone="muted" className="px-1 py-1.5 font-medium">
        Unsaved work
      </Text>
      {entries.map((entry) => {
        const conflict = conflicts[entry.ref] ?? null;
        const title = unsavedWorkTitle(entry.kind);
        const meta = [entry.date ? formatRelativeCommitTime(entry.date) : null, formatFileCount(entry.paths.length)]
          .filter((part): part is string => Boolean(part))
          .join(" · ");
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
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span>{meta}</span>
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
                  onPress={() => openReview(entry)}
                  data-testid="unsaved-work-review"
                >
                  Review
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="xl"
                  isPending={busyKey === `${entry.ref}:restore`}
                  isDisabled={!canWrite || (locked && busyKey !== `${entry.ref}:restore`)}
                  onPress={() =>
                    void runAction(`${entry.ref}:restore`, () => restore(entry, { head: conflict?.head ?? null }))
                  }
                  data-testid="unsaved-work-restore"
                >
                  Restore
                </Button>
                {entry.dismissible ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    radius="xl"
                    isPending={busyKey === `${entry.ref}:remove`}
                    isDisabled={!canWrite || (locked && busyKey !== `${entry.ref}:remove`)}
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
                    const pathId = `${pathIdPrefix}-${index}`;
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
                            className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
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
                              onPress={() => resolvePath(entry.ref, path, "keep")}
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
                {allResolved ? (
                  <div className="mt-2">
                    {entry.kind === "conflict" ? (
                      // A conflict entry holds only these files: nothing is left to restore.
                      <Button
                        variant="outline"
                        size="sm"
                        radius="xl"
                        isDisabled={!canWrite || locked || !entry.dismissible}
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
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      <HistoryConfirmDialog
        isOpen={pendingRemove !== null}
        title={REMOVE_DIALOG.title}
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
