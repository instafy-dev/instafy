import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  CloudUpload,
  Eye,
  Folder,
  GitBranch,
  MinusSquare,
  NavArrowLeft,
  NavArrowRight,
  Refresh,
  Trash,
  Xmark,
} from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Checkbox } from "../../../components/Checkbox";
import { Input } from "../../../components/Input";
import { Text } from "../../../components/Text";
import { DrawerHeader } from "../../../components/DrawerHeader";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import {
  DRAWER_ICON_BUTTON_TONE_CLASS,
  DRAWER_LIST_ROW_META_CLASS,
  LIST_ROW_FOCUS_RING,
  LIST_ROW_SURFACE_BASE,
  listRowSurfaceToneClassName,
} from "../../../components/listRowStyles";
import { useProject } from "../../../projects/useProject";
import { useRuntime } from "../../../runtime/useRuntime";
import { useStatus } from "../../../status/useStatus";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import {
  controllerClient,
  type WorkspaceGitHistory,
  type WorkspaceGitStatus,
} from "../../../sdk/instafy";
import { WorkspaceGitDiffPanel } from "./WorkspaceGitDiffPanel";
import { WorkspaceGitRollingDiffPanel } from "./WorkspaceGitRollingDiffPanel";
import { type GitReviewMode } from "../../../workspace/gitReviewTypes";
import {
  formatEmbeddedRepoLabel,
  formatEmbeddedRepoTitle,
  formatRelativeCommitTime,
  getStatusBadge,
  parseSavedVersionSubject,
} from "./workspaceGitReviewShared";

const LARGE_CHANGESET_THRESHOLD = 150;
const DIRTY_PATH_PAGE_LIMIT = 100;
const {
  fetchHistory: fetchWorkspaceGitHistoryFromController,
  fetchStatus: fetchWorkspaceGitStatusFromController,
  revertPaths: revertWorkspaceGitPathsFromController,
  revertCommit: revertWorkspaceGitCommitFromController,
  syncToRemote: syncWorkspaceGitToRemoteFromController,
} = controllerClient.workspace.git;

function buildScopeSegments(scopePrefix: string | null): Array<{ prefix: string; label: string }> {
  if (!scopePrefix) {
    return [];
  }
  const parts = scopePrefix.split("/").filter(Boolean);
  return parts.map((label, index) => ({
    label,
    prefix: parts.slice(0, index + 1).join("/"),
  }));
}

function sanitizeScopeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function reviewModeButtonClassName(active: boolean): string {
  return active
    ? "bg-white text-slate-900 shadow-sm shadow-slate-200/80 hover:bg-white dark:bg-slate-100 dark:text-slate-900 dark:shadow-none dark:hover:bg-white"
    : "text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100";
}

function reviewModeRailClassName(): string {
  return "inline-flex items-center rounded-full border border-slate-200/70 bg-slate-100/90 p-0.5 shadow-sm shadow-slate-200/60 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-none";
}

export function SourceControlDrawer({
  onRequestClose,
  openRequest,
}: {
  onRequestClose?: () => void;
  openRequest?: {
    key: number;
    previewPath: string | null;
    reviewMode?: GitReviewMode;
  } | null;
}) {
  const {
    activeProjectId,
    projectCapabilitiesResolved,
    canWriteProject,
  } = useProject();
  const projectWriteEnabled =
    projectCapabilitiesResolved === true && canWriteProject === true;
  const { effectiveRuntimeId } = useRuntime();
  const { showStatus } = useStatus();
  const isLargeScreen = useBreakpoint("lg");
  const { activeConversationId, createConversation, setConversationDraft } = useConversations();
  const { openConversationTab, openGitReviewTab, openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const [history, setHistory] = useState<WorkspaceGitHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [scopePrefix, setScopePrefix] = useState<string | null>(null);
  const [pageOffset, setPageOffset] = useState(0);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<GitReviewMode>("focused");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [expandedHistoryCommits, setExpandedHistoryCommits] = useState<Set<string>>(() => new Set());
  const [revertingCommit, setRevertingCommit] = useState<string | null>(null);
  const selectedPathsRef = useRef<Set<string>>(new Set());
  const previousDirtyPathsRef = useRef<Set<string>>(new Set());
  const pendingPreviewPathRef = useRef<string | null>(null);
  const statusRef = useRef<WorkspaceGitStatus | null>(null);
  const historyRef = useRef<WorkspaceGitHistory | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const [syncConflict, setSyncConflict] = useState<{ error: string | null } | null>(null);

  const dirtyPaths = useMemo(() => status?.dirtyPaths ?? [], [status?.dirtyPaths]);
  const pathGroups = status?.pathGroups ?? [];
  const visibleDirtyPaths = useMemo(() => dirtyPaths.map((entry) => entry.path), [dirtyPaths]);
  const supported = status?.supported === true;
  const dirtyCount = supported ? (status?.dirtyCount ?? dirtyPaths.length) : 0;
  const historyEntries = history?.entries ?? [];
  const historySupported = history?.supported !== false;
  const historyHeadLabel =
    typeof history?.branch === "string" && history.branch.trim().length > 0
      ? history.branch.trim()
      : typeof history?.headRef === "string" && history.headRef.trim().length > 0
        ? history.headRef.trim()
        : null;
  const statusBusy = status?.busy === true;
  const historyBusy = history?.busy === true;
  const workspaceBusy = statusBusy && historyBusy;
  const hasUsableSnapshot = dirtyCount > 0 || historyEntries.length > 0 || pathGroups.length > 0;
  const busyBlocksReviewControls = workspaceBusy && !hasUsableSnapshot;
  const busyBlocksMutations = workspaceBusy;
  const effectiveScopePrefix =
    typeof status?.scopePrefix === "string" && status.scopePrefix.trim().length > 0
      ? status.scopePrefix
      : scopePrefix;
  const currentPageOffset = typeof status?.pageOffset === "number" ? status.pageOffset : pageOffset;
  const currentPageLimit =
    typeof status?.pageLimit === "number" && status.pageLimit > 0 ? status.pageLimit : DIRTY_PATH_PAGE_LIMIT;
  const hasMoreFiles = status?.hasMoreFiles === true;
  const largeChangeSet = dirtyCount >= LARGE_CHANGESET_THRESHOLD;
  const folderMode = largeChangeSet || effectiveScopePrefix !== null || pathGroups.length > 0 || hasMoreFiles;
  const scopeSegments = useMemo(() => buildScopeSegments(effectiveScopePrefix ?? null), [effectiveScopePrefix]);
  const previewIndex = previewPath ? visibleDirtyPaths.indexOf(previewPath) : -1;
  const previewCanPrevious = previewIndex > 0;
  const previewCanNext = previewIndex >= 0 && previewIndex < visibleDirtyPaths.length - 1;
  const showDesktopDiffPreview = isLargeScreen && dirtyCount > 0 && reviewMode === "focused";
  const showDesktopRollingDiffPreview = isLargeScreen && dirtyCount > 0 && reviewMode === "all";
  const showMobileDiffPreview = !isLargeScreen && previewIndex >= 0 && reviewMode === "focused";
  const showMobileRollingDiffPreview = !isLargeScreen && dirtyCount > 0 && reviewMode === "all";
  const toggleHistoryEntry = useCallback((commit: string) => {
    setExpandedHistoryCommits((previous) => {
      const next = new Set(previous);
      if (next.has(commit)) {
        next.delete(commit);
      } else {
        next.add(commit);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    setPreviewPath((previous) => {
      const pendingPreviewPath = pendingPreviewPathRef.current;
      if (pendingPreviewPath) {
        if (visibleDirtyPaths.length === 0) {
          return pendingPreviewPath;
        }
        if (visibleDirtyPaths.includes(pendingPreviewPath)) {
          pendingPreviewPathRef.current = null;
          return pendingPreviewPath;
        }
      }
      if (previous && visibleDirtyPaths.includes(previous)) {
        return previous;
      }
      if (visibleDirtyPaths.length === 0) {
        return null;
      }
      return isLargeScreen ? visibleDirtyPaths[0] ?? null : null;
    });
  }, [isLargeScreen, visibleDirtyPaths]);

  useEffect(() => {
    if (!openRequest) {
      return;
    }
    pendingPreviewPathRef.current = openRequest.previewPath;
    setScopePrefix(null);
    setPageOffset(0);
    setPreviewPath(openRequest.previewPath);
    setReviewMode(openRequest.reviewMode ?? "focused");
  }, [openRequest]);

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!activeProjectId) {
        return;
      }
      if (refreshInFlightRef.current) {
        await refreshInFlightRef.current;
        return;
      }
      const silent = options?.silent === true;
      const run = (async () => {
        if (!silent) {
          setLoading(true);
        }
        try {
          // Keep retrying history for version-tracked spaces. New workspaces can move from
          // "no saved versions yet" to having history after the first save, so only skip
          // polling once the workspace itself is known to have version tracking disabled.
          const shouldFetchHistory = statusRef.current?.supported !== false;
          const [next, nextHistory] = await Promise.all([
            fetchWorkspaceGitStatusFromController({
              projectId: activeProjectId,
              runtimeId: effectiveRuntimeId ?? null,
              scope: scopePrefix,
              limit: DIRTY_PATH_PAGE_LIMIT,
              offset: pageOffset,
            }),
            shouldFetchHistory
              ? fetchWorkspaceGitHistoryFromController({
                  projectId: activeProjectId,
                  runtimeId: effectiveRuntimeId ?? null,
                  limit: 6,
                })
              : Promise.resolve(historyRef.current),
          ]);
          const previousStatus = statusRef.current;
          const previousHistory = historyRef.current;
          const resolvedStatus =
            next?.busy === true
              ? previousStatus
                ? { ...previousStatus, busy: true }
                : next
              : next
                ? { ...next, busy: false }
                : next;
          const resolvedHistory =
            nextHistory?.busy === true
              ? previousHistory
                ? { ...previousHistory, busy: true }
                : nextHistory
              : nextHistory
                ? { ...nextHistory, busy: false }
                : nextHistory;

          statusRef.current = resolvedStatus;
          historyRef.current = resolvedHistory;
          setStatus(resolvedStatus);
          setHistory(resolvedHistory);
          if (resolvedStatus?.busy !== true) {
            setScopePrefix(
              typeof resolvedStatus?.scopePrefix === "string" && resolvedStatus.scopePrefix.trim().length > 0
                ? resolvedStatus.scopePrefix
                : null,
            );
            setPageOffset(typeof resolvedStatus?.pageOffset === "number" ? resolvedStatus.pageOffset : 0);
          }
          const nextDirtyPaths = new Set((resolvedStatus?.dirtyPaths ?? []).map((entry) => entry.path));
          const previousDirtyPaths = previousDirtyPathsRef.current;
          const previousSelected = selectedPathsRef.current;
          previousDirtyPathsRef.current = nextDirtyPaths;
          const nextPartialStatusView =
            (resolvedStatus?.dirtyCount ?? 0) > (resolvedStatus?.dirtyPaths?.length ?? 0) ||
            (resolvedStatus?.pathGroups?.length ?? 0) > 0 ||
            resolvedStatus?.hasMoreFiles === true ||
            (typeof resolvedStatus?.scopePrefix === "string" && resolvedStatus.scopePrefix.trim().length > 0);

          const wasClean = previousDirtyPaths.size === 0;
          const hadAllSelected =
            previousSelected.size > 0 &&
            previousSelected.size === previousDirtyPaths.size &&
            Array.from(previousSelected).every((path) => previousDirtyPaths.has(path));

          let nextSelected: Set<string>;
          if (resolvedStatus?.dirtyCount === 0) {
            nextSelected = new Set<string>();
          } else if (nextPartialStatusView) {
            nextSelected = previousSelected.size === 0 && wasClean ? nextDirtyPaths : new Set(previousSelected);
          } else if (hadAllSelected) {
            nextSelected = nextDirtyPaths;
          } else if (previousSelected.size === 0) {
            // Keep "unstage all" stable across refreshes. Empty selection only auto-selects on initial load
            // (or after the working tree was clean) so polling doesn't re-stage everything mid-interaction.
            nextSelected = wasClean ? nextDirtyPaths : new Set<string>();
          } else {
            nextSelected = new Set<string>();
            previousSelected.forEach((path) => {
              if (nextDirtyPaths.has(path)) {
                nextSelected.add(path);
              }
            });
          }

          selectedPathsRef.current = nextSelected;
          setSelectedPaths(nextSelected);
          if ((resolvedStatus?.dirtyPaths?.length ?? 0) === 0) {
            setSyncConflict(null);
          }
        } finally {
          refreshInFlightRef.current = null;
          if (!silent) {
            setLoading(false);
          }
        }
      })();
      refreshInFlightRef.current = run;
      await run;
    },
    [activeProjectId, effectiveRuntimeId, pageOffset, scopePrefix],
  );

  const waitForSavedVersionHistoryEntry = useCallback(
    async (options: { commit?: string | null; message?: string | null }) => {
      const expectedCommit =
        typeof options.commit === "string" && options.commit.trim().length > 0
          ? options.commit.trim()
          : null;
      const expectedMessage =
        typeof options.message === "string" && options.message.trim().length > 0
          ? options.message.trim()
          : null;
      if (!expectedCommit && !expectedMessage) {
        return;
      }

      const hasExpectedEntry = () =>
        (historyRef.current?.entries ?? []).some(
          (entry) =>
            (expectedCommit !== null && entry.commit === expectedCommit) ||
            (expectedMessage !== null && entry.subject.trim() === expectedMessage),
        );

      if (hasExpectedEntry()) {
        return;
      }

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await refresh({ silent: true });
        if (hasExpectedEntry()) {
          return;
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 750);
        });
      }
    },
    [refresh],
  );

  useEffect(() => {
    selectedPathsRef.current = new Set<string>();
    previousDirtyPathsRef.current = new Set<string>();
    setSelectedPaths(new Set<string>());
    setScopePrefix(null);
    setPageOffset(0);
    refreshInFlightRef.current = null;
    statusRef.current = null;
    historyRef.current = null;
    setStatus(null);
    setHistory(null);
    setSyncConflict(null);
  }, [activeProjectId]);

  useEffect(() => {
    void refresh({ silent: false });
  }, [refresh]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) {
        return;
      }
      await refresh({ silent: true });
    };
    void tick();
    const interval = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeProjectId, refresh]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{
        projectId?: string | null;
        ok?: boolean;
        conflict?: boolean;
        error?: string | null;
      }>;
      const projectIdFromEvent =
        custom.detail && typeof custom.detail.projectId === "string" ? custom.detail.projectId : null;
      if (projectIdFromEvent && activeProjectId && projectIdFromEvent !== activeProjectId) {
        return;
      }

      if (custom.detail?.ok === true) {
        setSyncConflict(null);
        return;
      }

      if (custom.detail?.conflict === true) {
        const error =
          typeof custom.detail?.error === "string" && custom.detail.error.trim().length > 0
            ? custom.detail.error.trim()
            : null;
        setSyncConflict({ error });
        return;
      }

      if (custom.detail?.ok === false) {
        setSyncConflict(null);
      }
    };
    window.addEventListener("instafy:workspace-git-sync-result", handler as EventListener);
    return () => {
      window.removeEventListener("instafy:workspace-git-sync-result", handler as EventListener);
    };
  }, [activeProjectId]);

  const handleSelectAll = useCallback(() => {
    const nextSelected = new Set(dirtyPaths.map((entry) => entry.path));
    selectedPathsRef.current = nextSelected;
    setSelectedPaths(nextSelected);
  }, [dirtyPaths]);

  const handleSelectNone = useCallback(() => {
    const nextSelected = new Set<string>();
    selectedPathsRef.current = nextSelected;
    setSelectedPaths(nextSelected);
  }, []);

  const handleSync = useCallback(async () => {
    if (!projectWriteEnabled) {
      showStatus(
        projectCapabilitiesResolved
          ? "This space is read-only. Ask an admin for edit access."
          : "Checking your access to this space. Try again in a moment.",
        "warning",
        3500,
      );
      return;
    }
    if (!activeProjectId) {
      showStatus("Select a space before saving a version.", "error", 4000);
      return;
    }
    if (!supported) {
      showStatus("This space is not using version tracking yet.", "error", 5000);
      return;
    }

    const paths = Array.from(selectedPathsRef.current);
    const syncAllDirty = folderMode && dirtyCount > 0 && paths.length === 0;
    if (!syncAllDirty && paths.length === 0) {
      showStatus("Select at least one file to save a version.", "error", 4500);
      return;
    }

    if (syncing) {
      return;
    }

    setSyncing(true);
    setSyncConflict(null);
    try {
      const requestedMessage = commitMessage.trim().length > 0 ? commitMessage.trim() : null;
      const result = await syncWorkspaceGitToRemoteFromController({
        projectId: activeProjectId,
        runtimeId: effectiveRuntimeId ?? null,
        message: requestedMessage,
        paths: syncAllDirty ? undefined : paths,
      });

      if (!result?.ok) {
        const detail =
          typeof result?.error === "string" && result.error.trim().length > 0
            ? result.error.trim()
            : null;
        if (result?.conflict) {
          setSyncConflict({ error: detail });
        }
        const baseMessage = result?.conflict
          ? "Save version failed due to conflicts."
          : "Save version failed.";
        showStatus(detail ? `${baseMessage} ${detail}` : baseMessage, "error", 6500);
        return;
      }

      setSyncConflict(null);
      showStatus(
        result.rev ? `Saved version (${result.rev.slice(0, 8)}).` : "Saved version.",
        "success",
        4000,
      );
      await refresh({ silent: true });
      await waitForSavedVersionHistoryEntry({
        commit: result.rev ?? null,
        message: requestedMessage,
      });
    } finally {
      setSyncing(false);
    }
  }, [
    activeProjectId,
    commitMessage,
    effectiveRuntimeId,
    refresh,
    showStatus,
    supported,
    syncing,
    dirtyCount,
    folderMode,
    projectCapabilitiesResolved,
    projectWriteEnabled,
    waitForSavedVersionHistoryEntry,
  ]);

  const handleEnterScope = useCallback((nextScopePrefix: string | null) => {
    setScopePrefix(nextScopePrefix);
    setPageOffset(0);
  }, []);

  const handlePreviousPage = useCallback(() => {
    setPageOffset((current) => Math.max(0, current - currentPageLimit));
  }, [currentPageLimit]);

  const handleNextPage = useCallback(() => {
    if (!hasMoreFiles) {
      return;
    }
    setPageOffset((current) => current + currentPageLimit);
  }, [currentPageLimit, hasMoreFiles]);

  const handleNavigateUp = useCallback(() => {
    if (!effectiveScopePrefix) {
      return;
    }
    const parentParts = effectiveScopePrefix.split("/").filter(Boolean).slice(0, -1);
    handleEnterScope(parentParts.length > 0 ? parentParts.join("/") : null);
  }, [effectiveScopePrefix, handleEnterScope]);

  const handleResolveConflicts = useCallback(() => {
    const conversationId =
      activeConversationId ??
      createConversation({ title: "Resolve conflicts", select: true }).localId;

    const stagedPaths = Array.from(selectedPathsRef.current);
    const prompt = [
      "I tried `Save version` from the Changes drawer and hit a git-canonical conflict.",
      "",
      "Please follow `packages/runtime-agent/assets/instafy/.agents/skills/instafy-git-canonical-conflicts/SKILL.md` as the default procedure.",
      "",
      "Start with:",
      "- `instafy git status -sb`",
      "- `instafy git status --porcelain=v1`",
      activeProjectId ? "" : null,
      activeProjectId ? "Space:" : null,
      activeProjectId ? `- ${activeProjectId}` : null,
      stagedPaths.length > 0 ? "" : null,
      stagedPaths.length > 0 ? "Selected paths:" : null,
      stagedPaths.length > 0 ? stagedPaths.map((path) => `- ${path}`).join("\n") : null,
      syncConflict?.error ? "" : null,
      syncConflict?.error ? "Error:" : null,
      syncConflict?.error ? syncConflict.error : null,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");

    setConversationDraft(conversationId, prompt);
    openConversationTab(conversationId);
    onRequestClose?.();
  }, [
    activeConversationId,
    activeProjectId,
    createConversation,
    onRequestClose,
    openConversationTab,
    setConversationDraft,
    syncConflict,
  ]);

  const handleRevertHistoryCommit = useCallback(
    async (entry: WorkspaceGitHistory["entries"][number]) => {
      if (!projectWriteEnabled) {
        showStatus(
          projectCapabilitiesResolved
            ? "This space is read-only. Ask an admin for edit access."
            : "Checking your access to this space. Try again in a moment.",
          "warning",
          3500,
        );
        return;
      }
      if (!activeProjectId) {
        showStatus("Select a space before reverting a version.", "error", 4000);
        return;
      }
      const confirmRevert = window.confirm(
        `Revert "${entry.subject}"? A new version undoing this change is saved on top — nothing is deleted from history.`,
      );
      if (!confirmRevert) {
        return;
      }
      setRevertingCommit(entry.commit);
      try {
        const result = await revertWorkspaceGitCommitFromController({
          projectId: activeProjectId,
          commit: entry.commit,
        });
        if (!result?.ok) {
          const detail = result?.error ?? "Unable to revert this version right now.";
          if (result?.conflict) {
            showStatus(
              "This version can't be reverted automatically — later changes touch the same files. Ask the Assistant to undo it instead.",
              "warning",
              6500,
            );
          } else {
            showStatus(detail, "error", 6000);
          }
          return;
        }
        showStatus("Version reverted. A new version with the undo was saved.", "success", 4000);
        await refresh({ silent: true });
      } finally {
        setRevertingCommit(null);
      }
    },
    [activeProjectId, projectCapabilitiesResolved, projectWriteEnabled, refresh, showStatus],
  );

  const handleDiscardStaged = useCallback(async () => {
    if (!projectWriteEnabled) {
      showStatus(
        projectCapabilitiesResolved
          ? "This space is read-only. Ask an admin for edit access."
          : "Checking your access to this space. Try again in a moment.",
        "warning",
        3500,
      );
      return;
    }
    if (!activeProjectId) {
      showStatus("Select a space before discarding changes.", "error", 4000);
      return;
    }
    if (!supported) {
      showStatus("This space is not using version tracking yet.", "error", 5000);
      return;
    }

    const paths = Array.from(selectedPathsRef.current);
    if (paths.length === 0) {
      showStatus("Select at least one file to discard.", "error", 4500);
      return;
    }

    if (discarding || syncing) {
      return;
    }

    const confirmDiscard = window.confirm(
      `Discard changes for ${paths.length} path${paths.length === 1 ? "" : "s"}? This cannot be undone.`,
    );
    if (!confirmDiscard) {
      return;
    }

    setDiscarding(true);
    try {
      const result = await revertWorkspaceGitPathsFromController({
        projectId: activeProjectId,
        runtimeId: effectiveRuntimeId ?? null,
        paths,
      });

      if (!result?.ok) {
        const detail =
          typeof result?.error === "string" && result.error.trim().length > 0
            ? result.error.trim()
            : null;
        showStatus(detail ? `Discard failed. ${detail}` : "Discard failed.", "error", 6500);
        return;
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("instafy:workspace-commit", { detail: { projectId: activeProjectId } }),
        );
      }
      showStatus("Discarded changes.", "success", 4000);
      await refresh({ silent: true });
    } finally {
      setDiscarding(false);
    }
  }, [
    activeProjectId,
    discarding,
    effectiveRuntimeId,
    projectCapabilitiesResolved,
    projectWriteEnabled,
    refresh,
    showStatus,
    supported,
    syncing,
  ]);

  const handleDiscardPath = useCallback(
    async (path: string) => {
      if (!projectWriteEnabled) {
        showStatus(
          projectCapabilitiesResolved
            ? "This space is read-only. Ask an admin for edit access."
            : "Checking your access to this space. Try again in a moment.",
          "warning",
          3500,
        );
        return;
      }
      if (!activeProjectId) {
        showStatus("Select a space before discarding changes.", "error", 4000);
        return;
      }
      if (!supported) {
        showStatus("This space is not using version tracking yet.", "error", 5000);
        return;
      }
      const normalizedPath = path.trim();
      if (!normalizedPath) {
        return;
      }
      if (discarding || syncing) {
        return;
      }

      const confirmDiscard = window.confirm(`Discard changes for ${normalizedPath}? This cannot be undone.`);
      if (!confirmDiscard) {
        return;
      }

      setDiscarding(true);
      try {
        const result = await revertWorkspaceGitPathsFromController({
          projectId: activeProjectId,
          runtimeId: effectiveRuntimeId ?? null,
          paths: [normalizedPath],
        });

        if (!result?.ok) {
          const detail =
            typeof result?.error === "string" && result.error.trim().length > 0 ? result.error.trim() : null;
          showStatus(detail ? `Discard failed. ${detail}` : "Discard failed.", "error", 6500);
          return;
        }

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("instafy:workspace-commit", { detail: { projectId: activeProjectId } }),
          );
        }
        showStatus(`Discarded changes for ${normalizedPath}.`, "success", 4000);
        await refresh({ silent: true });
      } finally {
        setDiscarding(false);
      }
    },
    [
      activeProjectId,
      discarding,
      effectiveRuntimeId,
      projectCapabilitiesResolved,
      projectWriteEnabled,
      refresh,
      showStatus,
      supported,
      syncing,
    ],
  );

  const handleOpenPath = useCallback(
    async (path: string) => {
      if (!activeProjectId) {
        showStatus("Select a space before opening files.", "error", 4000);
        return;
      }
      if (typeof window === "undefined") {
        return;
      }

      const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
      if (!normalizedPath) {
        return;
      }

      const detail: { path: string; projectId?: string | null } = { path: normalizedPath };
      detail.projectId = activeProjectId;
      const runtimeWindow = window as typeof window & {
        __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
      };
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
      requestUrlPush();
      openPanelTab("code");
      window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
      onRequestClose?.();
    },
    [
      activeProjectId,
      onRequestClose,
      openPanelTab,
      requestUrlPush,
      showStatus,
    ],
  );

  const handlePreviewPath = useCallback((path: string) => {
    setReviewMode("focused");
    setPreviewPath(path);
  }, []);

  const handlePreviewPrevious = useCallback(() => {
    if (previewIndex <= 0) {
      return;
    }
    setPreviewPath(visibleDirtyPaths[previewIndex - 1] ?? null);
  }, [previewIndex, visibleDirtyPaths]);

  const handlePreviewNext = useCallback(() => {
    if (previewIndex < 0 || previewIndex >= visibleDirtyPaths.length - 1) {
      return;
    }
    setPreviewPath(visibleDirtyPaths[previewIndex + 1] ?? null);
  }, [previewIndex, visibleDirtyPaths]);

  const openSavedVersionInReviewTab = useCallback(
    (entry: WorkspaceGitHistory["entries"][number]) => {
      const parsed = parseSavedVersionSubject(entry.subject);
      requestUrlPush();
      openGitReviewTab({
        kind: "savedVersion",
        commit: entry.commit,
        shortCommit: entry.shortCommit,
        title: parsed.summary,
        committedAt: entry.committedAt,
        initialMode: "all",
      });
    },
    [openGitReviewTab, requestUrlPush],
  );

  const diffPreviewActions = previewPath ? (
    <>
      <Button
        variant="ghost"
        size="xs"
        radius="xl"
        onPress={handlePreviewPrevious}
        isDisabled={!previewCanPrevious}
        data-testid="source-control-diff-prev"
      >
        <NavArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Prev
      </Button>
      <Button
        variant="ghost"
        size="xs"
        radius="xl"
        onPress={handlePreviewNext}
        isDisabled={!previewCanNext}
        data-testid="source-control-diff-next"
      >
        Next
        <NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      {!isLargeScreen ? (
        <IconButton
          variant="ghost"
          size="sm"
          radius="lg"
          aria-label="Close diff preview"
          onPress={() => setPreviewPath(null)}
          data-testid="source-control-diff-close"
        >
          <Xmark className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      ) : null}
    </>
  ) : null;


  const changesListContent = (
    <>
      {folderMode ? (
        <div className="flex flex-col gap-2 px-1 pb-1">
          {effectiveScopePrefix !== null ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="source-control-scope-breadcrumbs">
                <Button
                  variant="ghost"
                  size="xs"
                  radius="xl"
                  onPress={() => handleEnterScope(null)}
                  data-testid="source-control-scope-root"
                >
                  Root
                </Button>
                {scopeSegments.map((segment, index) => (
                  <div key={segment.prefix} className="flex items-center gap-1">
                    <NavArrowRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <Button
                      variant="ghost"
                      size="xs"
                      radius="xl"
                      onPress={() => handleEnterScope(segment.prefix)}
                      isDisabled={index === scopeSegments.length - 1}
                      data-testid={`source-control-scope-segment-${sanitizeScopeTestId(segment.prefix)}`}
                    >
                      {segment.label}
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="ghost"
                size="xs"
                radius="xl"
                onPress={handleNavigateUp}
                data-testid="source-control-scope-parent"
              >
                <NavArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Parent
              </Button>
            </div>
          ) : null}

          {pathGroups.length > 0 ? (
            <div className="flex flex-col gap-1" data-testid="source-control-groups">
              {pathGroups.map((group) => {
                const embeddedRepoRoot =
                  typeof group.embeddedRepoRoot === "string" && group.embeddedRepoRoot.trim().length > 0
                    ? formatEmbeddedRepoLabel(group.embeddedRepoRoot)
                    : null;
                const embeddedRepoTitle = embeddedRepoRoot ? formatEmbeddedRepoTitle(embeddedRepoRoot) : null;
                return (
                  <button
                    key={group.prefix}
                    type="button"
                    className={[
                      LIST_ROW_SURFACE_BASE,
                      LIST_ROW_FOCUS_RING,
                      "flex items-center justify-between gap-3 px-2 py-2 text-left",
                    ].join(" ")}
                    onClick={() => handleEnterScope(group.prefix)}
                    data-testid={`source-control-group-${sanitizeScopeTestId(group.prefix)}`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        <Folder className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-slate-700 dark:text-slate-200">{group.label}</div>
                        {embeddedRepoRoot ? (
                          <div
                            className="truncate text-xxs text-sky-700/90 dark:text-sky-300/90"
                            title={embeddedRepoTitle ?? undefined}
                          >
                            Embedded repo
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xxs text-slate-500 dark:text-slate-400">
                      <span>{group.count}</span>
                      <NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          {(currentPageOffset > 0 || hasMoreFiles) && dirtyPaths.length > 0 ? (
            <div className="flex items-center justify-between gap-2 pb-1" data-testid="source-control-pagination">
              <Button
                variant="ghost"
                size="xs"
                radius="xl"
                onPress={handlePreviousPage}
                isDisabled={currentPageOffset === 0}
                data-testid="source-control-page-prev"
              >
                <NavArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Previous
              </Button>
              <Text variant="label" tone="secondary">
                {currentPageOffset + 1}-{currentPageOffset + dirtyPaths.length} of {dirtyCount}
              </Text>
              <Button
                variant="ghost"
                size="xs"
                radius="xl"
                onPress={handleNextPage}
                isDisabled={!hasMoreFiles}
                data-testid="source-control-page-next"
              >
                Next
                <NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {dirtyPaths.length === 0 && folderMode ? (
        <div className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
          {pathGroups.length > 0 ? "Choose a folder to inspect its files." : "No files on this page."}
        </div>
      ) : null}
      {dirtyPaths.map((entry) => {
        const selected = selectedPaths.has(entry.path);
        const previewSelected = previewPath === entry.path;
        const rowSelected = selected || previewSelected;
        const badge = getStatusBadge(entry.code);
        const embeddedRepoRoot =
          typeof entry.embeddedRepoRoot === "string" && entry.embeddedRepoRoot.trim().length > 0
            ? formatEmbeddedRepoLabel(entry.embeddedRepoRoot)
            : null;
        const embeddedRepoTitle = embeddedRepoRoot ? formatEmbeddedRepoTitle(embeddedRepoRoot) : null;

        return (
          <div
            key={entry.path}
            className={[
              LIST_ROW_SURFACE_BASE,
              listRowSurfaceToneClassName(rowSelected),
              "group px-2 py-1.5",
            ].join(" ")}
            style={
              largeChangeSet
                ? {
                    contentVisibility: "auto",
                    containIntrinsicSize: "44px",
                  }
                : undefined
            }
          >
            <div
              role="button"
              tabIndex={0}
              aria-label={entry.path}
              className={["flex cursor-pointer items-center justify-between gap-2", LIST_ROW_FOCUS_RING].join(" ")}
              title={`Preview diff for ${entry.path}`}
              onClick={() => handlePreviewPath(entry.path)}
              onKeyDown={(event) => {
                if (event.currentTarget !== event.target) {
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handlePreviewPath(entry.path);
                }
              }}
            >
              <div
                className="flex h-5 w-5 flex-none items-center justify-center"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <Checkbox
                  aria-label={`Select ${entry.path}`}
                  isSelected={selected}
                  onChange={(nextSelected) => {
                    const next = new Set(selectedPathsRef.current);
                    if (nextSelected) {
                      next.add(entry.path);
                    } else {
                      next.delete(entry.path);
                    }
                    selectedPathsRef.current = next;
                    setSelectedPaths(next);
                  }}
                  size="sm"
                />
              </div>

              <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="min-w-0 truncate font-mono text-xs text-slate-700 dark:text-slate-200">{entry.path}</div>
                  {embeddedRepoRoot ? (
                    <div
                      className="truncate text-xxs text-sky-700/90 dark:text-sky-300/90"
                      data-testid="source-control-embedded-repo-label"
                      title={embeddedRepoTitle ?? undefined}
                    >
                      Embedded repo
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <div
                    className="opacity-0 transition group-hover:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <IconButton
                      size="xs"
                      variant="ghost"
                      radius="full"
                      aria-label={`Discard changes for ${entry.path}`}
                      title="Discard changes"
                      onPress={() => void handleDiscardPath(entry.path)}
                      isDisabled={!projectWriteEnabled || !supported || syncing || discarding || busyBlocksReviewControls}
                    >
                      <Trash className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                  {badge ? (
                    <span
                      className={["select-none font-mono text-xs font-semibold", badge.className].join(" ")}
                      title={badge.title}
                      aria-label={badge.title}
                    >
                      {badge.label}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );

  return (
    <div className="relative flex h-full flex-col" data-testid="source-control-drawer">
      <div className="px-4 py-3">
        <DrawerHeader
          title="Changes"
          icon={<GitBranch className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
          actions={
            <>
              <IconButton
                variant="ghost"
                size="xs"
                radius="full"
                aria-label="Refresh changes"
                title="Refresh"
                data-testid="source-control-refresh"
                onPress={() => refresh({ silent: false })}
                isDisabled={!activeProjectId || loading}
                className={`h-10 w-10 lg:h-6 lg:w-6 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
              >
                <Refresh className="h-4 w-4" aria-hidden="true" />
              </IconButton>
              {onRequestClose ? (
                <IconButton
                  variant="ghost"
                  size="xs"
                  radius="full"
                  aria-label="Close changes"
                  title="Close"
                  data-testid="source-control-close"
                  onPress={onRequestClose}
                  className={`h-10 w-10 lg:h-6 lg:w-6 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
                >
                  <Xmark className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ) : null}
            </>
          }
        />
      </div>

      <div className="flex-1 overflow-hidden">
        {loading && !status ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <Text tone="secondary">Loading changes…</Text>
          </div>
        ) : status && !supported ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Text tone="secondary">This space is not using version tracking yet.</Text>
            <Text variant="label" tone="secondary">
              Turn on version tracking to inspect changes, save versions, and resolve conflicts.
            </Text>
          </div>
        ) : (
          <div className="flex h-full flex-col gap-2 overflow-hidden px-4 py-4">
            {status?.error && !workspaceBusy ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
                {status.error}
              </div>
            ) : null}
            {history?.error && !workspaceBusy ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                {history.error}
              </div>
            ) : null}
            {syncConflict ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                data-testid="source-control-conflict"
              >
                <div className="min-w-0">
                  <div className="font-medium">Conflicts detected while saving a version.</div>
                  <div className="text-xs opacity-90">
                    Use the Assistant to follow the pinned conflict playbook.
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  radius="xl"
                  onPress={handleResolveConflicts}
                  isDisabled={syncing}
                  data-testid="source-control-resolve-conflicts"
                >
                  Resolve conflicts
                </Button>
              </div>
            ) : null}
            {largeChangeSet ? (
              <div
                className="rounded-xl border border-slate-200/70 bg-slate-50/80 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-200"
                data-testid="source-control-large-changes-note"
              >
                Large change set detected. Grouping by folder and rendering files progressively to keep the drawer responsive.
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="source-control-commit-message" className="sr-only">
                Version note
              </label>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    id="source-control-commit-message"
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder="Add a version note (optional)"
                    disabled={!projectWriteEnabled || !supported || syncing || busyBlocksMutations}
                    data-testid="source-control-commit-message"
                  />
                </div>
                <div className="flex items-center gap-1 pb-0.5">
                  <IconButton
                    variant="primary"
                    size="md"
                    radius="full"
                    onPress={handleSync}
                    isDisabled={!projectWriteEnabled || !supported || syncing || discarding || busyBlocksMutations}
                    data-testid="source-control-sync"
                    aria-label={syncing ? "Saving version" : "Save selected files as a version"}
                    title={syncing ? "Saving…" : "Save version"}
                  >
                    {syncing ? (
                      <Refresh className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <CloudUpload className="h-4 w-4" aria-hidden="true" />
                    )}
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="md"
                    radius="full"
                    onPress={handleDiscardStaged}
                    isDisabled={
                      !supported ||
                      !projectWriteEnabled ||
                      syncing ||
                      discarding ||
                      busyBlocksMutations ||
                      dirtyCount === 0 ||
                      selectedPaths.size === 0
                    }
                    data-testid="source-control-discard"
                    aria-label={discarding ? "Discarding selected changes" : "Discard selected changes"}
                    title={discarding ? "Discarding…" : "Discard selected changes"}
                    className="text-rose-600 hover:bg-rose-50 data-[hovered]:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10 dark:data-[hovered]:bg-rose-500/10"
                  >
                    <Trash className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-hidden">
              <div className="flex h-full flex-col overflow-hidden border-t border-slate-200/70 pt-1 dark:border-slate-800">
                <div className="flex items-center justify-between gap-2 px-1 py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    {workspaceBusy ? (
                      <span
                        className="inline-flex items-center gap-1.5 text-xxs text-slate-500 dark:text-slate-400"
                        data-testid="source-control-busy-indicator"
                      >
                        <Refresh className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        <span>Checking…</span>
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {dirtyCount > 0 ? (
                      <div className={`mr-1 ${reviewModeRailClassName()}`}>
                        <Button
                          variant="ghost"
                          size="xs"
                          radius="full"
                          onPress={() => setReviewMode("focused")}
                          data-testid="source-control-review-mode-focused"
                          className={reviewModeButtonClassName(reviewMode === "focused")}
                        >
                          Files
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          radius="full"
                          onPress={() => setReviewMode("all")}
                          data-testid="source-control-review-mode-all"
                          className={reviewModeButtonClassName(reviewMode === "all")}
                          aria-label="Preview all changes"
                          title="Preview all changes"
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    ) : null}
                    <IconButton
                      variant="ghost"
                      size="xs"
                      radius="full"
                      onPress={handleSelectAll}
                      isDisabled={!supported || syncing || discarding || busyBlocksReviewControls || dirtyPaths.length === 0}
                      data-testid="source-control-select-all"
                      aria-label="Select visible files"
                      title="Select visible files"
                      className={DRAWER_ICON_BUTTON_TONE_CLASS}
                    >
                      <CheckSquare className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="xs"
                      radius="full"
                      onPress={handleSelectNone}
                      isDisabled={!supported || syncing || discarding || busyBlocksReviewControls || selectedPaths.size === 0}
                      data-testid="source-control-select-none"
                      aria-label="Clear selection"
                      title="Clear selection"
                      className={DRAWER_ICON_BUTTON_TONE_CLASS}
                    >
                      <MinusSquare className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>

                <div className="flex-1 overflow-hidden">
                  {dirtyCount === 0 ? (
                    <div className="flex h-full items-center justify-center px-4 py-10">
                      {workspaceBusy ? (
                        <div
                          className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400"
                          data-testid="source-control-empty-busy-state"
                        >
                          <Refresh className="h-4 w-4 animate-spin" aria-hidden="true" />
                          <Text tone="secondary">Checking changes…</Text>
                        </div>
                      ) : (
                        <Text tone="secondary">No pending changes.</Text>
                      )}
                    </div>
                  ) : showDesktopRollingDiffPreview ? (
                    <div
                      className="h-full min-h-0 overflow-hidden rounded-2xl border border-slate-200/70 bg-white/80 dark:border-slate-800 dark:bg-slate-950/40"
                      data-testid="source-control-rolling-diff-preview"
                    >
                      <WorkspaceGitRollingDiffPanel
                        paths={visibleDirtyPaths}
                        initialPath={previewPath}
                        projectId={activeProjectId}
                        runtimeId={effectiveRuntimeId ?? null}
                        onOpenFile={handleOpenPath}
                        dataTestId="source-control-rolling-diff-view"
                        testIdPrefix="source-control-rolling-diff"
                      />
                    </div>
                  ) : showDesktopDiffPreview ? (
                    <div className="grid h-full min-h-0 grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)] gap-3" data-testid="source-control-review-layout">
                      <div className="min-h-0 overflow-y-auto pr-1" data-testid="source-control-changes">
                        <div className="flex flex-col gap-1 px-1">{changesListContent}</div>
                      </div>
                      <div className="min-h-0 overflow-hidden rounded-2xl border border-slate-200/70 bg-white/80 dark:border-slate-800 dark:bg-slate-950/40" data-testid="source-control-diff-preview">
                        <WorkspaceGitDiffPanel
                          path={previewPath}
                          projectId={activeProjectId}
                          runtimeId={effectiveRuntimeId ?? null}
                          onOpenFile={handleOpenPath}
                          actions={diffPreviewActions}
                          dataTestId="source-control-diff-view"
                          testIdPrefix="source-control-diff"
                          bodyClassName="p-3"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full flex-col gap-1 overflow-y-auto pr-1" data-testid="source-control-changes">
                      <div className="flex flex-col gap-1 px-1">{changesListContent}</div>
                    </div>
                  )}
                </div>

                {historySupported ? (
                  <div className="border-t border-slate-200/70 pt-1 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-2 px-1 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <Text
                          variant="caption"
                          tone="secondary"
                          className="text-xxs font-medium tracking-[0.02em]"
                        >
                          Saved versions
                        </Text>
                        {historyHeadLabel ? (
                          <Text
                            variant="caption"
                            tone="secondary"
                            className="text-xxs font-medium tracking-[0.02em] text-slate-500 dark:text-slate-400"
                            data-testid="source-control-history-head-ref"
                          >
                            · {historyHeadLabel}
                          </Text>
                        ) : null}
                      </div>
                      {historyEntries.length > 0 ? (
                        <Text variant="caption" tone="secondary" className={DRAWER_LIST_ROW_META_CLASS}>
                          {historyEntries.length}
                        </Text>
                      ) : null}
                    </div>

                    <div className="max-h-56 overflow-y-auto pr-1 pb-1" data-testid="source-control-history">
                      {historyEntries.length === 0 ? (
                        <div className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
                          {workspaceBusy ? (
                            <div className="inline-flex items-center gap-2" data-testid="source-control-history-busy-state">
                              <Refresh className="h-4 w-4 animate-spin" aria-hidden="true" />
                              <span>Checking saved versions…</span>
                            </div>
                          ) : (
                            "No saved versions yet."
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {historyEntries.map((entry) => {
                            const parsed = parseSavedVersionSubject(entry.subject);
                            const expanded = expandedHistoryCommits.has(entry.commit);
                            const authorLabel = entry.authorName || entry.authorEmail || "Instafy";
                            const showAuthorLabel = parsed.systemLabel === null;
                            return (
                              <div
                                key={entry.commit}
                                className={[LIST_ROW_SURFACE_BASE, "pl-1 pr-2 py-1.5"].join(" ")}
                                data-testid="source-control-history-entry"
                                data-expanded={expanded ? "true" : "false"}
                              >
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                                    onClick={() => {
                                      openSavedVersionInReviewTab(entry);
                                    }}
                                    data-testid="source-control-history-review"
                                  >
                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                      {parsed.systemLabel ? (
                                        <span className="rounded-full border border-sky-300/70 bg-sky-50 px-2 py-0.5 text-3xs font-semibold uppercase tracking-[0.18em] text-sky-700 dark:border-sky-400/40 dark:bg-sky-500/10 dark:text-sky-200">
                                          {parsed.systemLabel}
                                        </span>
                                      ) : null}
                                      {entry.resolvedBy ? (
                                        <span
                                          className="rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-3xs font-semibold uppercase tracking-[0.18em] text-amber-700 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-200"
                                          title="The Assistant resolved a merge conflict in this version. Review it to confirm the result."
                                          data-testid="source-control-history-resolved-badge"
                                        >
                                          Assistant-resolved
                                        </span>
                                      ) : null}
                                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                                        {parsed.summary}
                                      </span>
                                    </div>
                                    <div className="ml-auto flex shrink-0 items-center justify-end gap-2 pl-2 text-xxs text-slate-500 dark:text-slate-400">
                                      {showAuthorLabel ? (
                                        <span className="max-w-[8rem] truncate">{authorLabel}</span>
                                      ) : null}
                                      <span className="shrink-0 whitespace-nowrap">
                                        {formatRelativeCommitTime(entry.committedAt)}
                                      </span>
                                    </div>
                                  </button>
                                  <IconButton
                                    variant="ghost"
                                    size="xs"
                                    radius="full"
                                    onPress={() => toggleHistoryEntry(entry.commit)}
                                    data-testid="source-control-history-toggle"
                                    aria-label={expanded ? "Collapse saved version details" : "Expand saved version details"}
                                    title={expanded ? "Collapse" : "Expand"}
                                    className={DRAWER_ICON_BUTTON_TONE_CLASS}
                                  >
                                    <NavArrowRight
                                      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${
                                        expanded ? "rotate-90" : ""
                                      }`}
                                      aria-hidden="true"
                                    />
                                  </IconButton>
                                </div>
                                {expanded ? (
                                  <div className="mt-2 border-t border-slate-200/70 pt-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                                    <div className="text-slate-600 dark:text-slate-300">{parsed.fullSubject}</div>
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                      <span className="rounded-full border border-slate-200 px-1.5 py-0.5 font-mono dark:border-slate-700">
                                        {entry.shortCommit}
                                      </span>
                                      <span>{authorLabel}</span>
                                      <span>{formatRelativeCommitTime(entry.committedAt)}</span>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        radius="xl"
                                        onPress={() => {
                                          openSavedVersionInReviewTab(entry);
                                        }}
                                        data-testid="source-control-history-review-inline"
                                      >
                                        Review version
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        radius="xl"
                                        isDisabled={!projectWriteEnabled || revertingCommit !== null}
                                        onPress={() => {
                                          void handleRevertHistoryCommit(entry);
                                        }}
                                        data-testid="source-control-history-revert"
                                      >
                                        {revertingCommit === entry.commit ? "Reverting…" : "Revert"}
                                      </Button>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>

      {showMobileRollingDiffPreview ? (
        <div className="absolute inset-0 z-20 flex items-end" data-testid="source-control-rolling-diff-sheet-overlay">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/45"
            aria-label="Close all changes review"
            data-testid="source-control-rolling-diff-sheet-backdrop"
            onClick={() => setReviewMode("focused")}
          />
          <div
            className="relative z-10 flex max-h-[78vh] w-full flex-col overflow-hidden rounded-t-[28px] border border-slate-200/70 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950"
            data-testid="source-control-rolling-diff-sheet"
          >
            <div className="flex items-center justify-between px-3 pt-2">
              <div className="w-8" />
              <div className="h-1.5 w-12 rounded-full bg-slate-300 dark:bg-slate-700" />
              <IconButton
                variant="ghost"
                size="xs"
                radius="full"
                aria-label="Close all changes review"
                onPress={() => setReviewMode("focused")}
                data-testid="source-control-rolling-diff-close"
                className={DRAWER_ICON_BUTTON_TONE_CLASS}
              >
                <Xmark className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
            <WorkspaceGitRollingDiffPanel
              paths={visibleDirtyPaths}
              initialPath={previewPath}
              projectId={activeProjectId}
              runtimeId={effectiveRuntimeId ?? null}
              onOpenFile={handleOpenPath}
              dataTestId="source-control-rolling-diff-sheet-panel"
              testIdPrefix="source-control-rolling-diff"
            />
          </div>
        </div>
      ) : null}

      {showMobileDiffPreview ? (
        <div className="absolute inset-0 z-20 flex items-end" data-testid="source-control-diff-sheet-overlay">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/45"
            aria-label="Close diff preview"
            data-testid="source-control-diff-sheet-backdrop"
            onClick={() => setPreviewPath(null)}
          />
          <div
            className="relative z-10 flex max-h-[78vh] w-full flex-col overflow-hidden rounded-t-[28px] border border-slate-200/70 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950"
            data-testid="source-control-diff-sheet"
          >
            <div className="flex justify-center pt-2">
              <div className="h-1.5 w-12 rounded-full bg-slate-300 dark:bg-slate-700" />
            </div>
            <WorkspaceGitDiffPanel
              path={previewPath}
              projectId={activeProjectId}
              runtimeId={effectiveRuntimeId ?? null}
              onOpenFile={handleOpenPath}
              actions={diffPreviewActions}
              bodyClassName="p-3 pb-6"
              dataTestId="source-control-diff-sheet-panel"
              testIdPrefix="source-control-diff"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
