import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, NavArrowDown, NavArrowLeft, NavArrowRight, Refresh } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Heading } from "../../../components/Heading";
import { useBreakpoint } from "../../../hooks/useBreakpoint";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { useProject } from "../../../projects/useProject";
import { useRuntime } from "../../../runtime/useRuntime";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import type { GitReviewMode, WorkspaceGitReviewEntry, WorkspaceGitReviewSource } from "../../../workspace/gitReviewTypes";
import { WorkspaceGitDiffPanel } from "./WorkspaceGitDiffPanel";
import { WorkspaceGitRollingDiffPanel } from "./WorkspaceGitRollingDiffPanel";
import { WorkspaceGitReviewPathList, formatRelativeCommitTime } from "./workspaceGitReviewShared";

function reviewModeButtonClassName(active: boolean): string {
  return active
    ? "bg-white text-slate-900 shadow-sm shadow-slate-200/80 hover:bg-white dark:bg-slate-100 dark:text-slate-900 dark:shadow-none dark:hover:bg-white"
    : "text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100";
}

function reviewModeRailClassName(): string {
  return "inline-flex items-center rounded-full border border-slate-200/70 bg-slate-100/90 p-0.5 shadow-sm shadow-slate-200/60 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-none";
}

function normalizePath(path: string | null | undefined): string | null {
  const value = (path ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return value.length > 0 ? value : null;
}

export function GitReviewView({
  review,
  presentation = "full",
  onOpenFullReview,
  onRequestClose,
}: {
  review: WorkspaceGitReviewSource;
  presentation?: "full" | "sheet";
  onOpenFullReview?: (() => void) | null;
  onRequestClose?: (() => void) | null;
}) {
  const { activeProjectId } = useProject();
  const { effectiveRuntimeId } = useRuntime();
  const { showStatus } = useStatus();
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const isLargeScreen = useBreakpoint("lg");
  const [reviewMode, setReviewMode] = useState<GitReviewMode>(review.initialMode ?? "all");
  const [diffViewMode, setDiffViewMode] = useState<"unified" | "split">("unified");
  const [entries, setEntries] = useState<WorkspaceGitReviewEntry[]>(review.entries ?? []);
  const [loading, setLoading] = useState(review.kind === "savedVersion" && !(review.entries && review.entries.length > 0));
  const [error, setError] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(normalizePath(review.initialPath));

  const loadSavedVersion = useCallback(
    async (options?: { silent?: boolean }) => {
      if (review.kind !== "savedVersion" || !activeProjectId) {
        return;
      }

      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);

      const result = await controllerClient.workspace.git.fetchHistoryReview({
        projectId: activeProjectId,
        runtimeId: effectiveRuntimeId ?? null,
        commit: review.commit,
      });

      if (!result) {
        setEntries([]);
        setError("Unable to load saved version review.");
        setLoading(false);
        return;
      }

      if (!result.supported) {
        setEntries([]);
        setError("Saved version review is not available for this space.");
        setLoading(false);
        return;
      }

      setEntries(result.entries);
      setError(result.error ?? (result.entries.length === 0 ? "No file changes recorded for this saved version." : null));
      setLoading(false);
    },
    [activeProjectId, effectiveRuntimeId, review],
  );

  useEffect(() => {
    setReviewMode(review.initialMode ?? "all");
    setDiffViewMode("unified");
    setPreviewPath(normalizePath(review.initialPath));
    setError(null);

    if (review.kind === "workingTree") {
      setEntries(review.entries);
      setLoading(false);
      return;
    }

    setEntries(review.entries ?? []);
    if (review.entries && review.entries.length > 0) {
      setLoading(false);
      return;
    }

    void loadSavedVersion({ silent: false });
  }, [loadSavedVersion, review]);

  useEffect(() => {
    if (!isLargeScreen && diffViewMode === "split") {
      setDiffViewMode("unified");
    }
  }, [diffViewMode, isLargeScreen]);

  useEffect(() => {
    setPreviewPath((current) => {
      const requested = normalizePath(review.initialPath);
      if (requested && entries.some((entry) => entry.path === requested)) {
        return requested;
      }
      if (current && entries.some((entry) => entry.path === current)) {
        return current;
      }
      return entries[0]?.path ?? null;
    });
  }, [entries, review.initialPath]);

  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const diffOverrides = useMemo(
    () =>
      Object.fromEntries(
        entries
          .filter((entry) => typeof entry.diffPreview === "string" && entry.diffPreview.length > 0)
          .map((entry) => [
            entry.path,
            {
              diff: entry.diffPreview ?? "",
              truncated: entry.truncated ?? false,
              previewMode: entry.previewMode ?? "diff",
              synthetic: entry.synthetic ?? false,
            },
          ]),
      ),
    [entries],
  );
  const hasSyntheticEntries = useMemo(
    () => entries.some((entry) => entry.synthetic === true),
    [entries],
  );
  const currentDiffOverride = previewPath ? diffOverrides[previewPath] ?? null : null;
  const supportsSplitView = useMemo(
    () => isLargeScreen && entries.some((entry) => (entry.previewMode ?? "diff") === "diff"),
    [entries, isLargeScreen],
  );
  const previewIndex = previewPath ? paths.indexOf(previewPath) : -1;
  const canPrevious = previewIndex > 0;
  const canNext = previewIndex >= 0 && previewIndex < paths.length - 1;

  const handleOpenFile = useCallback(
    (path: string) => {
      if (!activeProjectId) {
        showStatus("Select a space before opening files.", "error", 4000);
        return;
      }
      if (typeof window === "undefined") {
        return;
      }

      const normalizedPath = normalizePath(path);
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
    },
    [activeProjectId, openPanelTab, requestUrlPush, showStatus],
  );

  const handleOpenChangesDrawer = useCallback(() => {
    if (review.kind !== "workingTree" || typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("instafy:open-source-control", {
        detail: {
          projectId: activeProjectId ?? null,
          previewPath,
          reviewMode: "all",
        },
      }),
    );
  }, [activeProjectId, previewPath, review]);

  const diffActions = previewPath ? (
    <>
      <Button
        variant="ghost"
        size="xs"
        radius="xl"
        onPress={() => setPreviewPath(paths[previewIndex - 1] ?? null)}
        isDisabled={!canPrevious}
        data-testid="git-review-prev"
      >
        <NavArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Prev
      </Button>
      <Button
        variant="ghost"
        size="xs"
        radius="xl"
        onPress={() => setPreviewPath(paths[previewIndex + 1] ?? null)}
        isDisabled={!canNext}
        data-testid="git-review-next"
      >
        Next
        <NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </>
  ) : null;

  const title = review.kind === "savedVersion" ? review.title : review.title ?? "Review changes";
  const reviewLabel =
    review.kind === "savedVersion"
      ? "Saved version review"
      : hasSyntheticEntries
        ? "Batch review"
        : "Working tree review";

  if (presentation === "sheet") {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="git-review-sheet">
        <div className="flex items-center justify-center px-4 pt-3">
          <span className="h-1.5 w-14 rounded-full bg-slate-300 dark:bg-slate-700" aria-hidden="true" />
        </div>
        <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-3">
          <div className="min-w-0">
            <Text variant="caption" tone="secondary" className="text-xxs font-medium tracking-[0.02em]">
              {reviewLabel}
            </Text>
            <Heading level={3} className="truncate leading-tight" data-testid="git-review-sheet-title">
              {title}
            </Heading>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400" data-testid="git-review-sheet-meta">
              <span>{entries.length} {entries.length === 1 ? "file" : "files"}</span>
              {review.kind === "savedVersion" ? (
                <>
                  <span className="rounded-full border border-slate-200 px-1.5 py-0.5 font-mono dark:border-slate-700">
                    {review.shortCommit}
                  </span>
                  <span>{formatRelativeCommitTime(review.committedAt)}</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onOpenFullReview ? (
              <Button
                variant="ghost"
                size="sm"
                radius="xl"
                onPress={onOpenFullReview}
                data-testid="git-review-sheet-open-full"
              >
                Open full review
              </Button>
            ) : null}
            {onRequestClose ? (
              <IconButton
                variant="ghost"
                size="sm"
                radius="lg"
                aria-label="Close review"
                onPress={onRequestClose}
                data-testid="git-review-sheet-close"
              >
                <NavArrowDown className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden border-t border-slate-200/70 dark:border-slate-800">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
              <Spinner aria-hidden="true" tone="slate" size="sm" />
              <span>Loading review…</span>
            </div>
          ) : error && entries.length === 0 ? (
            <div className="px-4 py-6 text-sm text-rose-600 dark:text-rose-300">{error}</div>
          ) : (
            <WorkspaceGitRollingDiffPanel
              paths={paths}
              initialPath={previewPath}
              commit={review.kind === "savedVersion" ? review.commit : null}
              projectId={activeProjectId}
              runtimeId={effectiveRuntimeId ?? null}
              diffViewMode="unified"
              onOpenFile={handleOpenFile}
              showHeader={false}
              layoutStyle="flat"
              diffOverrides={diffOverrides}
              dataTestId="git-review-sheet-rolling-diff"
              testIdPrefix="git-review-sheet-rolling-diff"
              emptyState={<Text tone="secondary">No changed files to review.</Text>}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="git-review-view">
      <div className="border-b border-slate-200/70 px-4 py-3 dark:border-slate-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-300">
                <GitBranch className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <Text variant="caption" tone="secondary" className="text-xxs font-medium tracking-[0.02em]">
                  {reviewLabel}
                </Text>
                <Heading level={3} className="truncate leading-tight" data-testid="git-review-title">
                  {title}
                </Heading>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400" data-testid="git-review-meta">
              <span>{entries.length} {entries.length === 1 ? "file" : "files"}</span>
              {review.kind === "savedVersion" ? (
                <>
                  <span className="rounded-full border border-slate-200 px-1.5 py-0.5 font-mono dark:border-slate-700">
                    {review.shortCommit}
                  </span>
                  <span>{formatRelativeCommitTime(review.committedAt)}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {entries.length > 0 ? (
              <>
                <div className={reviewModeRailClassName()}>
                  <Button
                    variant="ghost"
                    size="xs"
                    radius="full"
                    onPress={() => setReviewMode("focused")}
                    data-testid="git-review-mode-focused"
                    className={reviewModeButtonClassName(reviewMode === "focused")}
                  >
                    Files
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    radius="full"
                    onPress={() => setReviewMode("all")}
                    data-testid="git-review-mode-all"
                    className={reviewModeButtonClassName(reviewMode === "all")}
                  >
                    All changes
                  </Button>
                </div>
                {supportsSplitView ? (
                  <div className={reviewModeRailClassName()}>
                    <Button
                      variant="ghost"
                      size="xs"
                      radius="full"
                      onPress={() => setDiffViewMode("unified")}
                      data-testid="git-review-diff-mode-unified"
                      className={reviewModeButtonClassName(diffViewMode === "unified")}
                    >
                      Unified
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      radius="full"
                      onPress={() => setDiffViewMode("split")}
                      data-testid="git-review-diff-mode-split"
                      className={reviewModeButtonClassName(diffViewMode === "split")}
                    >
                      Split
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
            {review.kind === "workingTree" && !hasSyntheticEntries ? (
              <Button
                variant="ghost"
                size="sm"
                radius="xl"
                onPress={handleOpenChangesDrawer}
                data-testid="git-review-open-source-control"
              >
                Open Changes
              </Button>
            ) : null}
            {review.kind === "savedVersion" ? (
              <IconButton
                variant="ghost"
                size="sm"
                radius="lg"
                aria-label="Refresh saved version review"
                onPress={() => void loadSavedVersion({ silent: false })}
                isDisabled={loading}
                data-testid="git-review-refresh"
              >
                <Refresh className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden px-4 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-slate-500 dark:text-slate-400" data-testid="git-review-loading">
            <Refresh className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Loading review…</span>
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500 dark:text-slate-400" data-testid="git-review-error">
            {error}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500 dark:text-slate-400" data-testid="git-review-empty">
            No diffs available for this review.
          </div>
        ) : reviewMode === "all" ? (
          <div className="h-full min-h-0 overflow-hidden">
            <WorkspaceGitRollingDiffPanel
              paths={paths}
              initialPath={previewPath}
              commit={review.kind === "savedVersion" ? review.commit : null}
              projectId={activeProjectId}
              runtimeId={effectiveRuntimeId ?? null}
              diffViewMode={diffViewMode}
              onOpenFile={handleOpenFile}
              showHeader={false}
              layoutStyle="flat"
              diffOverrides={diffOverrides}
              dataTestId="git-review-rolling-diff"
              testIdPrefix="git-review-rolling-diff"
            />
          </div>
        ) : (
          <div className="grid h-full min-h-0 grid-rows-[minmax(12rem,16rem)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]" data-testid="git-review-layout">
            <div className="min-h-0 overflow-y-auto pr-1">
              <WorkspaceGitReviewPathList
                entries={entries}
                previewPath={previewPath}
                onSelectPath={setPreviewPath}
                dataTestId="git-review-files"
                testIdPrefix="git-review-path"
              />
            </div>
            <div className="min-h-0 overflow-hidden rounded-2xl border border-slate-200/70 bg-white/80 dark:border-slate-800 dark:bg-slate-950/40">
              <WorkspaceGitDiffPanel
                path={previewPath}
                commit={review.kind === "savedVersion" ? review.commit : null}
                projectId={activeProjectId}
                runtimeId={effectiveRuntimeId ?? null}
                onOpenFile={handleOpenFile}
                actions={diffActions}
                diffViewMode={diffViewMode}
                diffOverride={currentDiffOverride}
                modeLabelText={
                  currentDiffOverride?.previewMode === "content"
                    ? "Current file contents"
                    : currentDiffOverride?.synthetic
                      ? "Preview diff"
                      : undefined
                }
                dataTestId="git-review-diff"
                testIdPrefix="git-review-diff"
                bodyClassName="p-3"
                showDiffHeaderSummary={false}
                showRefreshButton={!currentDiffOverride}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
