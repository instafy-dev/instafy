import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Eye, NavArrowRight, OpenNewWindow, Undo } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { useStatus } from "../../../status/useStatus";
import { controllerClient } from "../../../sdk/instafy";
import { useRuntime } from "../../../runtime/useRuntime";
import { useOptionalProjectAccess } from "../../../projects/ProjectAccessProvider";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { getUnifiedDiffRowClass, parseUnifiedDiff, splitUnifiedDiffHeader } from "../../../utils/unifiedDiff";
import type {
  ChatMessageCommitRange,
  ChatMessageFileChange,
  ChatMessageFileChangeType,
  ChatMessageFileLineRange,
} from "../types";
import { truncateMultiline } from "./chatContentHelpers";
import { REQUEST_MESSAGE_UNDO_EVENT, type MessageUndoRequestDetail } from "./messageUndoRequest";

const {
  fetchDiff: fetchWorkspaceGitDiffFromController,
  revertPaths: revertWorkspaceGitPathsFromController,
} = controllerClient.workspace.git;
const { read: readWorkspaceFileFromController } = controllerClient.workspace.files;

function resolveChangeMeta(changeType: ChatMessageFileChangeType): { label: string; badgeClass: string } {
  switch (changeType) {
    case "created":
      return {
        label: "Created",
        badgeClass:
          "border-primary-200/80 bg-primary-50/80 text-primary-700 dark:border-primary-400/25 dark:bg-primary-400/[0.07] dark:text-primary-200/85",
      };
    case "deleted":
      return {
        label: "Deleted",
        badgeClass:
          "border-rose-200/80 bg-rose-50/80 text-rose-700 dark:border-rose-400/25 dark:bg-rose-400/[0.07] dark:text-rose-200/85",
      };
    case "changed":
      return {
        label: "Updated",
        badgeClass:
          "border-secondary-200/80 bg-secondary-50/80 text-secondary-700 dark:border-secondary-400/25 dark:bg-secondary-400/[0.07] dark:text-secondary-200/85",
      };
    default:
      return {
        label: "Updated",
        badgeClass:
          "border-slate-200/70 bg-slate-100/80 text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.045] dark:text-slate-300",
      };
  }
}

type ChatFileDiffStat =
  | { kind: "loading" }
  | {
      kind: "ready";
      added: number;
      removed: number;
      diffPreview: string;
      truncated: boolean;
      previewMode?: "diff" | "content";
      synthetic?: boolean;
    }
  | { kind: "unsupported" }
  | { kind: "error"; error: string | null };

type ChatFileUndoStatus = "reverted" | "removed";

type ResolvedChatFileChange = {
  file: ChatMessageFileChange;
  workspacePath: string;
  displayLabel: string;
};

const MAX_FILES_EXPANDED_BY_DEFAULT = 4;

// Brief lockout after dispatching a conversational undo request so a double
// click cannot fire two requests; the composer chain serializes the rest.
const UNDO_REQUEST_COOLDOWN_MS = 2500;

const chipBaseClass =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-primary-300/80 dark:focus-visible:ring-offset-slate-950 disabled:pointer-events-none disabled:opacity-45";
// One distinguishing property per rail role: the summary is a borderless label,
// file chips are the only bordered pills, actions are ghost buttons.
// summaryToggleClass is the chat-wide disclosure vocabulary — reused by other chat surfaces.
// -ml-1.5 hangs the pill's own padding so the label TEXT aligns with the message text column.
export const summaryToggleClass = `${chipBaseClass} -ml-1.5 border-transparent px-1.5 font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-white/[0.07]`;
const actionChipClass = `${chipBaseClass} border-transparent font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-white/[0.07] dark:hover:text-slate-100`;
const actionUndoChipClass = `${chipBaseClass} border-transparent font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-700 dark:text-slate-300 dark:hover:bg-rose-400/[0.08] dark:hover:text-rose-200`;
const chipFileClass = `${chipBaseClass} border-slate-200/70 bg-white/75 font-mono text-slate-700 hover:border-slate-400/70 hover:bg-slate-100 hover:text-slate-900 dark:border-white/[0.09] dark:bg-white/[0.045] dark:text-slate-200 dark:hover:border-white/[0.16] dark:hover:bg-white/[0.10]`;
const chipFileActiveClass = `${chipBaseClass} border-primary-300/70 bg-primary-50/70 font-mono text-primary-800 hover:border-primary-300 hover:bg-primary-50 dark:border-primary-300/50 dark:bg-primary-300/[0.16] dark:text-primary-200 dark:hover:bg-primary-300/[0.20]`;
const chipFileRevertedClass = `${chipBaseClass} border-slate-200/70 bg-transparent font-mono text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:border-white/[0.07] dark:text-slate-400 dark:hover:bg-white/[0.05]`;
const chipFileRevertedActiveClass = `${chipBaseClass} border-slate-300 bg-slate-100/80 font-mono text-slate-600 hover:bg-slate-100 dark:border-white/[0.14] dark:bg-white/[0.07] dark:text-slate-300 dark:hover:bg-white/[0.09]`;

function LineDelta({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return null;
  }
  return (
    <>
      {/* translate-y-px baseline-aligns the 11px digits with the adjacent 12px labels */}
      <span className="inline-flex shrink-0 translate-y-px items-center gap-1 font-mono text-xxs" aria-hidden="true">
        {added > 0 || removed === 0 ? (
          <span className="text-emerald-700 dark:text-emerald-300/85">+{added}</span>
        ) : null}
        {removed > 0 ? <span className="text-rose-700 dark:text-rose-300/85">-{removed}</span> : null}
      </span>
      <span className="sr-only">{`${added} lines added, ${removed} lines removed`}</span>
    </>
  );
}

function resolveChipLabels(entries: ResolvedChatFileChange[]): Map<string, string> {
  const baseNameCounts = new Map<string, number>();
  for (const entry of entries) {
    const baseName = entry.displayLabel.split("/").pop() || entry.displayLabel;
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const entry of entries) {
    const segments = entry.displayLabel.split("/");
    const baseName = segments.pop() || entry.displayLabel;
    const needsContext = (baseNameCounts.get(baseName) ?? 0) > 1 && segments.length > 0;
    labels.set(entry.workspacePath, needsContext ? `${segments.pop()}/${baseName}` : baseName);
  }
  return labels;
}

// Middle-truncate so the distinguishing suffix and extension survive; plain CSS
// end-truncation is kept on the span only as an overflow safety net.
function middleTruncateLabel(label: string, max = 28): string {
  if (label.length <= max) {
    return label;
  }
  const head = Math.ceil((max - 1) * 0.55);
  const tail = max - 1 - head;
  return `${label.slice(0, head)}…${label.slice(-tail)}`;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function resolveUniqueChatFileChanges(files: ChatMessageFileChange[]): ResolvedChatFileChange[] {
  const seen = new Set<string>();
  const entries: ResolvedChatFileChange[] = [];
  for (const file of files) {
    const workspacePath = normalizeWorkspacePath((file.workspacePath || file.path || "").trim());
    if (!workspacePath || seen.has(workspacePath)) {
      continue;
    }
    seen.add(workspacePath);
    entries.push({
      file,
      workspacePath,
      displayLabel: (file.label || file.path).trim(),
    });
  }
  return entries;
}

function isExcludedFromSpaceHistoryPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path).trim();
  if (!normalized) {
    return false;
  }
  if (normalized === ".instafy" || normalized.startsWith(".instafy/")) {
    return true;
  }
  return normalized
    .split("/")
    .filter((segment) => segment.length > 0)
    .some((segment) => segment === "tmp" || segment === "node_modules" || segment === ".pnpm-store");
}

function countUnifiedDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function getNormalizedTextLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function toReviewStatusCode(changeType: ChatMessageFileChangeType): string {
  switch (changeType) {
    case "created":
      return "A";
    case "deleted":
      return "D";
    case "changed":
      return "M";
    default:
      return "M";
  }
}

function formatFileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

function resolveChangeSetVerb(entries: ResolvedChatFileChange[]): string {
  if (entries.length === 0) {
    return "Edited";
  }
  const allCreated = entries.every((entry) => entry.file.changeType === "created");
  if (allCreated) {
    return "Created";
  }
  const allDeleted = entries.every((entry) => entry.file.changeType === "deleted");
  if (allDeleted) {
    return "Deleted";
  }
  return "Edited";
}

function buildSyntheticDiffPreview(
  path: string,
  contentText: string,
  changeType: ChatMessageFileChangeType,
): { diff: string; added: number; removed: number } {
  const normalizedPath = normalizeWorkspacePath(path);
  const lines = getNormalizedTextLines(contentText);

  if (changeType === "deleted") {
    return {
      diff: [
        `diff --git a/${normalizedPath} b/${normalizedPath}`,
        "deleted file mode 100644",
        "index 0000000..0000000",
        `--- a/${normalizedPath}`,
        "+++ /dev/null",
      ].join("\n"),
      added: 0,
      removed: 0,
    };
  }

  const hunkHeader = lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@` : "@@ -0,0 +0,0 @@";
  return {
    diff: [
      `diff --git a/${normalizedPath} b/${normalizedPath}`,
      changeType === "created" ? "new file mode 100644" : "index 0000000..1111111 100644",
      changeType === "created" ? "--- /dev/null" : `--- a/${normalizedPath}`,
      `+++ b/${normalizedPath}`,
      hunkHeader,
      ...lines.map((line) => `+${line}`),
    ].join("\n"),
    added: lines.length,
    removed: 0,
  };
}

export function ChatFileChangeList({
  files,
  projectId,
  commitRange,
  messageId,
  messageTimestamp,
}: {
  files: ChatMessageFileChange[];
  projectId?: string | null;
  // The run's base..head commits: pins diffs to what that run changed (real
  // edit diffs on snapshot-history origins, stable after later edits).
  commitRange?: ChatMessageCommitRange | null;
  // Identity of the chat message these changes belong to. When present, the
  // Undo chip becomes a conversational affordance (#165): it asks the agent to
  // undo that message's change instead of silently reverting files. Without it
  // the chip falls back to the legacy file revert.
  messageId?: string | null;
  messageTimestamp?: number | null;
}) {
  const { openPanelTab, requestUrlPush, openGitDiffTab } = useWorkspaceTabs();
  const { showStatus } = useStatus();
  const { effectiveRuntimeId, runtimeReady } = useRuntime();
  const projectAccess = useOptionalProjectAccess();
  const projectWriteEnabled =
    projectAccess?.projectCapabilitiesResolved === true &&
    projectAccess.canWriteProject === true;
  const [undoing, setUndoing] = useState(false);
  const [undoRequestPending, setUndoRequestPending] = useState(false);
  const [expandedDiffByPath, setExpandedDiffByPath] = useState<Record<string, boolean>>({});
  const [statsByPath, setStatsByPath] = useState<Record<string, ChatFileDiffStat>>({});
  const [gitSupported, setGitSupported] = useState<boolean | null>(null);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const [undoStatusByPath, setUndoStatusByPath] = useState<Record<string, ChatFileUndoStatus>>({});
  const [railExpanded, setRailExpanded] = useState(
    () => resolveUniqueChatFileChanges(files).length <= MAX_FILES_EXPANDED_BY_DEFAULT,
  );
  const cardIdBase = useId();

  const resolvedFiles = useMemo(() => resolveUniqueChatFileChanges(files), [files]);

  const uniquePaths = useMemo(
    () => resolvedFiles.map((entry) => entry.workspacePath),
    [resolvedFiles],
  );

  const changeTypeByPath = useMemo(() => {
    const next: Record<string, ChatMessageFileChangeType> = {};
    for (const entry of resolvedFiles) {
      next[entry.workspacePath] = entry.file.changeType;
    }
    return next;
  }, [resolvedFiles]);

  const uniquePathsKey = useMemo(() => uniquePaths.join("\n"), [uniquePaths]);

  useEffect(() => {
    if (uniquePaths.length === 0) {
      setUndoStatusByPath({});
      return;
    }
    setUndoStatusByPath((prev) => {
      let changed = false;
      const next: Record<string, ChatFileUndoStatus> = {};
      for (const path of uniquePaths) {
        const status = prev[path];
        if (!status) {
          continue;
        }
        next[path] = status;
      }
      if (Object.keys(prev).some((key) => !next[key])) {
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [uniquePaths, uniquePathsKey]);

  const pendingEntries = useMemo(
    () => resolvedFiles.filter(({ workspacePath }) => !undoStatusByPath[workspacePath]),
    [resolvedFiles, undoStatusByPath],
  );

  const pendingPaths = useMemo(
    () => pendingEntries.map((entry) => entry.workspacePath),
    [pendingEntries],
  );

  const pendingCount = pendingPaths.length;
  const totalCount = uniquePaths.length;

  const revertedCount = totalCount - pendingCount;

  const compactSummaryLabel = (() => {
    if (totalCount === 0) {
      return "No file changes";
    }
    if (pendingCount === 0) {
      return `Reverted ${formatFileCount(totalCount)}`;
    }
    if (revertedCount > 0) {
      return `${resolveChangeSetVerb(pendingEntries)} ${formatFileCount(totalCount)} · ${revertedCount} reverted`;
    }
    return `${resolveChangeSetVerb(pendingEntries)} ${formatFileCount(pendingCount)}`;
  })();

  // A single file needs no summary/toggle chip — the file chip carries everything.
  const showSummaryToggle = totalCount > 1;
  const visibleChipEntries = railExpanded || !showSummaryToggle ? resolvedFiles : [];
  const chipLabels = resolveChipLabels(resolvedFiles);
  const statsLoading = pendingPaths.some((path) => {
    const stat = statsByPath[path];
    return !stat || stat.kind === "loading";
  });

  useEffect(() => {
    if (!projectId || !runtimeReady || uniquePaths.length === 0) {
      return;
    }

    let cancelled = false;

    setStatsByPath(() => Object.fromEntries(uniquePaths.map((path) => [path, { kind: "loading" } as const])));
    setGitSupported(null);

    void (async () => {
      for (const path of uniquePaths) {
        if (cancelled) {
          return;
        }

        const result = await fetchWorkspaceGitDiffFromController({
          projectId,
          runtimeId: effectiveRuntimeId ?? null,
          path,
          base: commitRange?.base ?? null,
          commit: commitRange?.head ?? null,
        });

        if (cancelled) {
          return;
        }

        if (!result) {
          setStatsByPath((prev) => ({
            ...prev,
            [path]: { kind: "error", error: null },
          }));
          continue;
        }

        if (!result.supported) {
          setGitSupported(false);
          setStatsByPath(() =>
            Object.fromEntries(uniquePaths.map((entryPath) => [entryPath, { kind: "unsupported" } as const])),
          );
          return;
        }

        setGitSupported(true);
        const diffValue = result.diff ?? "";
        const changeType = changeTypeByPath[path] ?? "changed";
        // A newly created file can return an empty diff during the brief window
        // before its change is committed/synced on the origin. Rather than
        // dead-ending on "No diff available", synthesize the added-lines diff from
        // the file's current contents — accurate for a create (every line is new).
        const shouldSynthesizeEmptyDiff =
          diffValue.trim().length === 0 &&
          (isExcludedFromSpaceHistoryPath(path) || changeType === "created");
        if (shouldSynthesizeEmptyDiff) {
          const fileResult = await readWorkspaceFileFromController({
            projectId,
            runtimeId: effectiveRuntimeId ?? null,
            path,
          });

          if (cancelled) {
            return;
          }

          if (fileResult?.isText && typeof fileResult.contentText === "string") {
            const syntheticPreview = buildSyntheticDiffPreview(
              path,
              fileResult.contentText,
              changeType,
            );
            const preview = truncateMultiline(syntheticPreview.diff, 4000);
            setStatsByPath((prev) => ({
              ...prev,
              [path]: {
                kind: "ready",
                added: syntheticPreview.added,
                removed: syntheticPreview.removed,
                diffPreview: preview.text,
                truncated: preview.truncated,
                previewMode: "diff",
                synthetic: true,
              },
            }));
            continue;
          }
        }

        const { added, removed } = countUnifiedDiffStats(diffValue);
        const preview = truncateMultiline(diffValue, 4000);
        setStatsByPath((prev) => ({
          ...prev,
          [path]: {
            kind: "ready",
            added,
            removed,
            diffPreview: preview.text,
            truncated: Boolean(result.truncated) || preview.truncated,
            previewMode: "diff",
            synthetic: false,
          },
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    changeTypeByPath,
    commitRange?.base,
    commitRange?.head,
    diffRefreshNonce,
    effectiveRuntimeId,
    projectId,
    runtimeReady,
    uniquePaths,
    uniquePathsKey,
  ]);

  const totals = useMemo(() => {
    if (pendingPaths.length === 0) {
      return null;
    }
    const allReady = pendingPaths.every((path) => statsByPath[path]?.kind === "ready");
    if (!allReady) {
      return null;
    }
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const path of pendingPaths) {
      const stat = statsByPath[path];
      if (stat?.kind === "ready") {
        totalAdded += stat.added;
        totalRemoved += stat.removed;
      }
    }
    return { added: totalAdded, removed: totalRemoved };
  }, [pendingPaths, statsByPath]);

  const handleNavigate = useCallback(
    (path: string, range?: ChatMessageFileLineRange | null) => {
      if (typeof window === "undefined") {
        return;
      }
      const trimmedPath = path.trim();
      if (!trimmedPath) {
        return;
      }
      const detail: {
        path: string;
        projectId?: string | null;
        returnTarget?: "assistant";
        line?: number;
        range?: { from: number; to: number };
      } = { path: trimmedPath };
      detail.returnTarget = "assistant";
      if (projectId) {
        detail.projectId = projectId;
      }
      if (range) {
        detail.line = range.from;
        detail.range = { from: range.from, to: range.to };
      }
      const runtimeWindow = window as typeof window & {
        __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
      };
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
      requestUrlPush();
      openPanelTab("code");
      window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
    },
    [openPanelTab, projectId, requestUrlPush],
  );

  const handleOpenDiff = useCallback(
    (path: string) => {
      const normalizedPath = normalizeWorkspacePath(path.trim());
      if (!normalizedPath) {
        return;
      }
      // Same pinning as the card: the tab shows what this run changed.
      openGitDiffTab({ path: normalizedPath, commitRange: commitRange ?? null });
    },
    [commitRange, openGitDiffTab],
  );

  const handleReview = useCallback(() => {
    const firstPath = pendingPaths[0] ?? null;
    if (!firstPath) {
      return;
    }
    const hasExcludedSelectedPaths = pendingPaths.some((path) => isExcludedFromSpaceHistoryPath(path));
    const reviewDetail = {
      review: hasExcludedSelectedPaths
        ? {
            kind: "workingTree" as const,
            title: "Review changes",
            entries: pendingPaths.map((path) => {
              const stat = statsByPath[path];
              return {
                path,
                code: toReviewStatusCode(changeTypeByPath[path] ?? "changed"),
                embeddedRepoRoot: null,
                diffPreview: stat?.kind === "ready" ? stat.diffPreview : "",
                previewMode: stat?.kind === "ready" ? stat.previewMode ?? "diff" : "diff",
                synthetic: stat?.kind === "ready" ? Boolean(stat.synthetic) : false,
                truncated: stat?.kind === "ready" ? stat.truncated : false,
              };
            }),
            initialPath: firstPath,
            initialMode: "all" as const,
          }
        : {
            kind: "workingTree" as const,
            title: "Review changes",
            entries: pendingPaths.map((path) => ({
              path,
              code: "",
              embeddedRepoRoot: null,
            })),
            initialPath: firstPath,
            initialMode: "all" as const,
          },
    };

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("instafy:open-git-review", {
          detail: reviewDetail,
        }),
      );
    }
  }, [changeTypeByPath, pendingPaths, statsByPath]);

  const toggleFileCard = useCallback((path: string) => {
    setExpandedDiffByPath((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const handleUndo = useCallback(
    async (pathsOverride?: string[]) => {
      if (!projectWriteEnabled) {
        showStatus(
          projectAccess?.projectCapabilitiesResolved === false
            ? "Checking your access to this space. Try again in a moment."
            : "This space is read-only. Ask an admin for edit access.",
          "warning",
          3500,
        );
        return;
      }
      const targetPaths = pathsOverride ?? pendingPaths;
      if (!projectId) {
        showStatus("Select a space before undoing changes.", "error", 4000);
        return;
      }
      if (!runtimeReady) {
        showStatus("Runtime not ready yet.", "error", 4000);
        return;
      }
      if (gitSupported === false) {
        showStatus("This space is not using version tracking yet.", "error", 5000);
        return;
      }
      if (targetPaths.length === 0 || undoing) {
        return;
      }

      const confirmUndo =
        typeof window === "undefined"
          ? false
          : window.confirm(
              `Undo changes for ${targetPaths.length} file${targetPaths.length === 1 ? "" : "s"}? This cannot be undone.`,
            );
      if (!confirmUndo) {
        return;
      }

      setUndoing(true);
      try {
        const result = await revertWorkspaceGitPathsFromController({
          projectId,
          runtimeId: effectiveRuntimeId ?? null,
          paths: targetPaths,
        });

        if (!result?.ok) {
          const detail =
            typeof result?.error === "string" && result.error.trim().length > 0 ? result.error.trim() : null;
          showStatus(detail ? `Undo failed. ${detail}` : "Undo failed.", "error", 6500);
          return;
        }

        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId } }));
        }

        const removedFromResult = new Set(
          Array.isArray(result.removed) ? result.removed.map((path) => normalizeWorkspacePath(path)) : [],
        );
        setUndoStatusByPath((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const path of targetPaths) {
            const status: ChatFileUndoStatus = removedFromResult.has(path) ? "removed" : "reverted";
            if (next[path] !== status) {
              next[path] = status;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        showStatus("Undid changes.", "success", 4000);
        setDiffRefreshNonce((value) => value + 1);
        // Fully-reverted rails are history — tuck them down to the summary chip.
        const remainingPending = pendingPaths.filter((path) => !targetPaths.includes(path));
        if (remainingPending.length === 0 && totalCount > 1) {
          setRailExpanded(false);
        }
      } finally {
        setUndoing(false);
      }
    },
    [
      effectiveRuntimeId,
      gitSupported,
      pendingPaths,
      projectAccess?.projectCapabilitiesResolved,
      projectWriteEnabled,
      projectId,
      runtimeReady,
      showStatus,
      totalCount,
      undoing,
    ],
  );

  // Conversational undo (#165): ask the agent to undo this message's change
  // rather than silently reverting files. ChatPanel listens, fills the
  // composer, and sends — the request lands in the thread like any user turn.
  const handleUndoRequest = useCallback(() => {
    if (!messageId || undoRequestPending || typeof window === "undefined") {
      return;
    }
    setUndoRequestPending(true);
    const detail: MessageUndoRequestDetail = {
      messageId,
      messageTimestamp: messageTimestamp ?? null,
    };
    window.dispatchEvent(new CustomEvent(REQUEST_MESSAGE_UNDO_EVENT, { detail }));
  }, [messageId, messageTimestamp, undoRequestPending]);

  useEffect(() => {
    if (!undoRequestPending || typeof window === "undefined") {
      return;
    }
    const timer = window.setTimeout(() => setUndoRequestPending(false), UNDO_REQUEST_COOLDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [undoRequestPending]);

  return (
    <div className="mt-2 text-sm" data-testid="chat-file-change-summary">
      {/* Chips and their actions flow as one row: actions follow the chips after a thin
          divider (no far-right gap on single-file rails) and wrap together on narrow widths. */}
      <div className="flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1.5">
          {showSummaryToggle ? (
            <button
              type="button"
              className={summaryToggleClass}
              onClick={() => setRailExpanded((value) => !value)}
              aria-expanded={railExpanded}
              aria-controls={`${cardIdBase}-files`}
              title={railExpanded ? "Hide files" : "Show files"}
              data-testid="chat-file-change-toggle-files"
            >
              <span className="truncate">{compactSummaryLabel}</span>
              {totals && (pendingCount > 1 || !railExpanded) ? (
                <LineDelta added={totals.added} removed={totals.removed} />
              ) : !railExpanded && statsLoading ? (
                <span
                  className="h-2 w-5 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-white/[0.10]"
                  aria-hidden="true"
                />
              ) : null}
              <NavArrowRight
                className={`-ml-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${
                  railExpanded ? "rotate-180" : ""
                }`}
                aria-hidden="true"
              />
            </button>
          ) : null}

          <span id={`${cardIdBase}-files`} className="contents">
          {visibleChipEntries.map(({ file, workspacePath }, index) => {
            const stat = statsByPath[workspacePath];
            const isReverted = Boolean(undoStatusByPath[workspacePath]);
            const cardOpen = Boolean(expandedDiffByPath[workspacePath]);
            const isDeleted = file.changeType === "deleted";
            return (
              <button
                key={workspacePath}
                type="button"
                className={
                  cardOpen
                    ? isReverted
                      ? chipFileRevertedActiveClass
                      : chipFileActiveClass
                    : isReverted
                      ? chipFileRevertedClass
                      : chipFileClass
                }
                onClick={() => toggleFileCard(workspacePath)}
                title={isReverted ? `${workspacePath} (reverted)` : workspacePath}
                aria-expanded={cardOpen}
                aria-controls={`${cardIdBase}-${index}`}
                data-testid="chat-file-change-file-chip"
              >
                {isReverted ? <Undo className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" /> : null}
                <span className={`min-w-0 max-w-56 truncate ${isDeleted ? "line-through" : ""}`}>
                  {middleTruncateLabel(chipLabels.get(workspacePath) ?? workspacePath)}
                </span>
                {isReverted ? <span className="sr-only">(reverted)</span> : null}
                {!isReverted && stat?.kind === "ready" ? (
                  <LineDelta added={stat.added} removed={stat.removed} />
                ) : !isReverted && stat?.kind === "loading" ? (
                  <span
                    className="h-2 w-5 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-white/[0.10]"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
          </span>

        {pendingCount > 0 ? (
          <>
            <span
              className="mx-0.5 h-4 w-px shrink-0 self-center bg-slate-200 dark:bg-white/[0.1]"
              aria-hidden="true"
            />
            <button
              type="button"
              className={actionChipClass}
              onClick={handleReview}
              data-testid="chat-file-change-review"
            >
              <Eye className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
              <span>Review changes</span>
            </button>
            {projectWriteEnabled ? (
              messageId ? (
                <button
                  type="button"
                  className={actionUndoChipClass}
                  onClick={handleUndoRequest}
                  disabled={undoRequestPending}
                  title="Ask the agent to undo this change"
                  data-testid="chat-file-change-undo"
                >
                  <Undo className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                  <span>{undoRequestPending ? "Undo…" : "Undo"}</span>
                </button>
              ) : (
                // Legacy fallback for surfaces that render changes without a
                // message identity: reverting files is all "undo" can mean here.
                <button
                  type="button"
                  className={actionUndoChipClass}
                  onClick={() => handleUndo()}
                  disabled={!runtimeReady || undoing || gitSupported === false}
                  data-testid="chat-file-change-undo"
                >
                  <Undo className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                  <span>{undoing ? "Undo…" : "Undo"}</span>
                </button>
              )
            ) : null}
          </>
        ) : null}
      </div>

      {resolvedFiles.map(({ file, workspacePath, displayLabel }, index) => {
        if (!railExpanded || !expandedDiffByPath[workspacePath]) {
          return null;
        }
        const meta = resolveChangeMeta(file.changeType);
        const stat = statsByPath[workspacePath];
        const primaryRange = file.lineRanges[0] ?? null;
        const openDiff = () => handleOpenDiff(workspacePath);
        const openFile = () => handleNavigate(workspacePath, primaryRange);
        const undoStatus = undoStatusByPath[workspacePath] ?? null;
        const isReverted = Boolean(undoStatus);
        const previewMode = stat?.kind === "ready" ? stat.previewMode ?? "diff" : "diff";
        const canOpenExternalDiff =
          !isReverted && stat?.kind === "ready" && previewMode === "diff" && !stat.synthetic;

        const diffRows =
          stat?.kind === "ready"
            ? (() => {
                const { bodyDiff } = splitUnifiedDiffHeader(stat.diffPreview);
                const diffBody = bodyDiff.trim().length > 0 ? bodyDiff : stat.diffPreview;
                return parseUnifiedDiff(diffBody);
              })()
            : [];

        return (
          <div
            key={workspacePath}
            id={`${cardIdBase}-${index}`}
            className="mt-2 overflow-hidden rounded-xl border border-slate-200/70 bg-white/75 shadow-sm shadow-slate-900/5 dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-none"
            data-testid="chat-file-change-row"
          >
            <div className="flex items-center justify-between gap-3 px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={[
                    "shrink-0 rounded-full border px-2 py-0.5 text-3xs font-medium",
                    meta.badgeClass,
                  ].join(" ")}
                  title={meta.label}
                  aria-label={meta.label}
                >
                  {meta.label}
                </span>
                <button
                  type="button"
                  className={[
                    "min-w-0 truncate text-left font-mono text-xs text-slate-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:text-slate-300 dark:focus-visible:ring-primary-300/80",
                    isReverted ? "line-through text-slate-500 dark:text-slate-400" : "",
                  ].join(" ")}
                  title={`Open ${workspacePath}`}
                  onClick={() => openFile()}
                  aria-label={`Open ${workspacePath}`}
                >
                  {displayLabel}
                </button>
                {undoStatus ? (
                  <span
                    className={[
                      "shrink-0 rounded-full border px-2 py-0.5 text-3xs font-medium",
                      undoStatus === "removed"
                        ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200"
                        : "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
                    ].join(" ")}
                    title={undoStatus === "removed" ? "Removed from workspace" : "Reverted to git HEAD"}
                  >
                    {undoStatus === "removed" ? "Removed" : "Reverted"}
                  </span>
                ) : null}
              </div>
              {/* No +/− here: the file's chip directly above the card already carries the counts. */}
              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  aria-label="Open diff view"
                  variant="ghost"
                  size="xs"
                  radius="full"
                  onPress={() => openDiff()}
                  isDisabled={!canOpenExternalDiff}
                >
                  <OpenNewWindow className="h-3 w-3 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                </IconButton>
                {!isReverted && projectWriteEnabled ? (
                  <>
                    <span className="mx-0.5 h-3.5 w-px shrink-0 bg-slate-200 dark:bg-white/[0.08]" aria-hidden="true" />
                    {/* Direct file revert stays available from the file card,
                        where its scope (this file's workspace changes) is
                        unambiguous — the chip-row Undo is the conversational
                        affordance. */}
                    <IconButton
                      aria-label={`Revert file changes to ${workspacePath}`}
                      title={`Revert files: restore ${workspacePath}`}
                      variant="ghost"
                      size="xs"
                      radius="full"
                      className="group"
                      onPress={() => void handleUndo([workspacePath])}
                      isDisabled={!runtimeReady || undoing || gitSupported === false}
                    >
                      <Undo
                        className="h-3.5 w-3.5 text-slate-500 group-hover:text-rose-600 group-data-[hovered]:text-rose-600 dark:text-slate-400 dark:group-hover:text-rose-300 dark:group-data-[hovered]:text-rose-300"
                        aria-hidden="true"
                      />
                    </IconButton>
                  </>
                ) : null}
              </div>
            </div>
            {!isReverted ? (
              <div className="border-t border-slate-200/70 bg-slate-50/80 font-mono text-xs dark:border-white/[0.07] dark:bg-white/[0.02]">
                {stat?.kind === "ready" ? (
                  previewMode === "content" ? (
                    <div className="max-h-56 overflow-auto">
                      <div className="border-b border-slate-200/70 px-3 py-2 text-xxs font-medium uppercase tracking-[0.08em] text-slate-500 dark:border-white/[0.06] dark:text-slate-400">
                        Current file contents
                      </div>
                      <pre className="overflow-x-auto px-3 py-2 whitespace-pre-wrap break-words text-slate-700 dark:text-slate-300">
                        {stat.diffPreview.length > 0 ? stat.diffPreview : "No preview available."}
                      </pre>
                      {stat.truncated ? (
                        <div className="border-t border-slate-200/70 px-3 py-2 text-xs text-slate-500 dark:border-white/[0.06] dark:text-slate-400">
                          File preview truncated.
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <div className="max-h-56 overflow-auto">
                        {diffRows.length > 0 ? (
                          diffRows.map((row, rowIndex) => {
                            if (row.kind === "hunk") {
                              if (rowIndex === 0) {
                                return null;
                              }
                              return (
                                <div key={`${workspacePath}-diff-hunk-${rowIndex}`} className="px-3 py-1">
                                  <div className="h-px bg-slate-200/60 dark:bg-white/[0.06]" />
                                </div>
                              );
                            }
                            return (
                              <div
                                key={`${workspacePath}-diff-${rowIndex}`}
                                className={["px-3 py-0.5 whitespace-pre", getUnifiedDiffRowClass(row)].join(" ")}
                              >
                                {row.text.length === 0 ? "\u00A0" : row.text}
                              </div>
                            );
                          })
                        ) : (
                          <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                            No diff available.
                          </div>
                        )}
                        {stat.truncated ? (
                          <div className="px-3 py-1 text-xs text-slate-500 dark:text-slate-400">…</div>
                        ) : null}
                      </div>
                      {stat.truncated ? (
                        <div className="flex items-center justify-between gap-3 border-t border-slate-200/70 px-3 py-2 text-xs text-slate-500 dark:border-white/[0.06] dark:text-slate-300">
                          <span>Diff preview truncated.</span>
                          <button
                            type="button"
                            className="text-primary-600 hover:text-primary-700 dark:text-primary-200 dark:hover:text-primary-100"
                            onClick={() => openDiff()}
                          >
                            Open full diff
                          </button>
                        </div>
                      ) : null}
                    </>
                  )
                ) : (
                  <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-200/80">
                    {stat?.kind === "loading"
                      ? "Loading diff…"
                      : stat?.kind === "unsupported"
                        ? "Version tracking isn't available for this space."
                        : "Diff unavailable."}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
