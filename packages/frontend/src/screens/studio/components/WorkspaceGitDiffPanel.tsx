import { useCallback, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { GitBranch, NavArrowDown, Refresh } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { ContentHeader } from "../../../components/ContentHeader";
import { InlineNotice } from "../../../components/InlineNotice";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { DARK_DIVIDER_BORDER_CLASS, DARK_DIVIDER_CLASS, DARK_PANEL_BG_CLASS, DARK_PANEL_SOFT_BG_CLASS, DARK_RAIL_BG_CLASS } from "../../../theme/darkSurfaces";
import { controllerClient } from "../../../sdk/instafy";
import {
  buildSplitDiffRows,
  getUnifiedDiffRowClass,
  parseUnifiedDiff,
  splitUnifiedDiffHeader,
  type SplitDiffCell,
} from "../../../utils/unifiedDiff";

const { fetchDiff: fetchWorkspaceGitDiffFromController } = controllerClient.workspace.git;

const TRANSIENT_BUSY_DIFF_PATTERN = /workspace is busy applying\/syncing changes/i;

function isTransientBusyDiffError(value: string | null | undefined): boolean {
  return typeof value === "string" && TRANSIENT_BUSY_DIFF_PATTERN.test(value);
}

function normalizePath(path: string | null | undefined): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

type DiffHeaderChange = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";

type DiffHeaderSummary = {
  change: DiffHeaderChange;
  aPath: string | null;
  bPath: string | null;
  indexLine: string | null;
  modeLine: string | null;
  binaryLine: string | null;
};

function stripDiffSidePrefix(path: string | null): string | null {
  if (!path) {
    return null;
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return path.slice(2);
  }
  return path;
}

function parseDiffHeader(lines: string[]): DiffHeaderSummary | null {
  const rawLines = lines.map((line) => line.replace(/\s+$/g, "")).filter((line) => line.length > 0);
  if (rawLines.length === 0) {
    return null;
  }

  const diffGitLine = rawLines.find((line) => line.startsWith("diff --git ")) ?? null;
  const indexLine = rawLines.find((line) => line.startsWith("index ")) ?? null;
  const modeLine =
    rawLines.find(
      (line) =>
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode"),
    ) ?? null;
  const binaryLine = rawLines.find((line) => line.startsWith("Binary files ")) ?? null;

  let aPath: string | null = null;
  let bPath: string | null = null;
  if (diffGitLine) {
    const parts = diffGitLine.trim().split(/\s+/);
    aPath = parts[2] ?? null;
    bPath = parts[3] ?? null;
  }

  const change: DiffHeaderChange = binaryLine
    ? "binary"
    : rawLines.some((line) => line.startsWith("new file mode"))
      ? "added"
      : rawLines.some((line) => line.startsWith("deleted file mode"))
        ? "deleted"
        : rawLines.some((line) => line.startsWith("rename from") || line.startsWith("rename to"))
          ? "renamed"
          : rawLines.some((line) => line.startsWith("copy from") || line.startsWith("copy to"))
            ? "copied"
            : "modified";

  return {
    change,
    aPath,
    bPath,
    indexLine,
    modeLine,
    binaryLine,
  };
}

function getDiffHeaderBadgeTone(change: DiffHeaderChange): ComponentProps<typeof Badge>["tone"] {
  switch (change) {
    case "added":
      return "success";
    case "deleted":
      return "danger";
    case "renamed":
    case "copied":
      return "info";
    case "binary":
      return "warning";
    default:
      return "neutral";
  }
}

function getDiffHeaderLabel(change: DiffHeaderChange): string {
  switch (change) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "binary":
      return "Binary";
    default:
      return "Modified";
  }
}

function getDiffHeaderGlyph(change: DiffHeaderChange): string {
  switch (change) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "binary":
      return "B";
    default:
      return "M";
  }
}

function getSplitDiffCellClass(kind: SplitDiffCell["kind"] | "empty"): string {
  switch (kind) {
    case "add":
      return "bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200";
    case "del":
      return "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200";
    case "empty":
      return `bg-slate-50/60 text-slate-300 ${DARK_PANEL_SOFT_BG_CLASS} dark:text-slate-700`;
    case "context":
    default:
      return "text-slate-700 dark:text-slate-200";
  }
}

export interface WorkspaceGitDiffPanelProps {
  path: string | null;
  projectId: string | null;
  commit?: string | null;
  // With base set, the origin diffs base→commit (or base→worktree) tree-to-tree:
  // the pinned per-run view used by chat diff cards.
  base?: string | null;
  /** Read objects from a recovery ref (History, unsaved work). */
  gitRef?: string | null;
  /** History pins its reads to the default origin; unset keeps legacy routing. */
  routing?: "default";
  originId?: string | null;
  runtimeId?: string | null;
  onOpenFile?: (path: string) => void;
  actions?: ReactNode;
  dataTestId?: string;
  testIdPrefix?: string;
  className?: string;
  bodyClassName?: string;
  emptyState?: ReactNode;
  showModeLabel?: boolean;
  modeLabelText?: string | null;
  showRefreshButton?: boolean;
  showOpenFileButton?: boolean;
  compactHeader?: boolean;
  /** The containing review owns its frame; keep only meaningful content dividers. */
  frame?: "standalone" | "embedded";
  showDiffHeaderSummary?: boolean;
  diffViewMode?: "unified" | "split";
  collapsed?: boolean;
  onToggleCollapsed?: (() => void) | null;
  diffOverride?: {
    diff: string;
    error?: string | null;
    truncated?: boolean | null;
    previewMode?: "diff" | "content";
    synthetic?: boolean;
  } | null;
}

export function WorkspaceGitDiffPanel({
  path,
  projectId,
  commit = null,
  base = null,
  gitRef = null,
  routing,
  originId = null,
  runtimeId = null,
  onOpenFile,
  actions,
  dataTestId = "git-diff-view",
  testIdPrefix = "git-diff",
  className,
  bodyClassName,
  emptyState,
  showModeLabel = true,
  modeLabelText,
  showRefreshButton = true,
  showOpenFileButton = true,
  compactHeader = false,
  frame = "standalone",
  showDiffHeaderSummary = true,
  diffViewMode = "unified",
  collapsed = false,
  onToggleCollapsed = null,
  diffOverride = null,
}: WorkspaceGitDiffPanelProps) {
  const [diff, setDiff] = useState("");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffHeaderDetailsOpen, setDiffHeaderDetailsOpen] = useState(false);

  const normalizedPath = useMemo(() => normalizePath(path), [path]);
  const previewMode = diffOverride?.previewMode ?? "diff";

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!projectId || !normalizedPath) {
        return;
      }

      if (!options?.silent) {
        setDiffLoading(true);
      }
      setDiffError(null);

      try {
        const result = await fetchWorkspaceGitDiffFromController({
          projectId,
          runtimeId,
          path: normalizedPath,
          commit,
          base,
          ...(routing === "default" ? { routing, originId, ref: gitRef } : {}),
        });

        if (!result) {
          setDiff("");
          setDiffError("Unable to load diff.");
          setDiffTruncated(false);
          return;
        }
        if (!result.supported) {
          setDiff("");
          setDiffError("Diff preview is not available for this space.");
          setDiffTruncated(false);
          return;
        }

        if (isTransientBusyDiffError(result.error)) {
          setDiffError(result.error ?? null);
          return;
        }

        setDiff(result.diff ?? "");
        setDiffError(result.error ?? null);
        setDiffTruncated(result.truncated === true);
      } finally {
        setDiffLoading(false);
      }
    },
    [base, commit, gitRef, normalizedPath, originId, projectId, routing, runtimeId],
  );

  useEffect(() => {
    if (diffOverride) {
      setDiff(diffOverride.diff ?? "");
      setDiffError(diffOverride.error ?? null);
      setDiffTruncated(diffOverride.truncated === true);
      setDiffLoading(false);
      return;
    }
    if (!normalizedPath) {
      setDiff("");
      setDiffError(null);
      setDiffTruncated(false);
      setDiffLoading(false);
      return;
    }
    void refresh({ silent: false });
  }, [diffOverride, normalizedPath, refresh]);

  useEffect(() => {
    if (diffOverride) {
      return;
    }
    if (!normalizedPath || !isTransientBusyDiffError(diffError)) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void refresh({ silent: true });
    }, 1500);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [diffError, diffOverride, normalizedPath, refresh]);

  const { headerLines, bodyDiff } = useMemo(() => splitUnifiedDiffHeader(diff), [diff]);
  const diffHeader = useMemo(
    () => (previewMode === "diff" ? parseDiffHeader(headerLines) : null),
    [headerLines, previewMode],
  );
  const diffHeaderSummaryText = useMemo(() => {
    if (!diffHeader) {
      return "";
    }
    if (diffHeader.change === "renamed" || diffHeader.change === "copied") {
      return `${stripDiffSidePrefix(diffHeader.aPath) ?? normalizedPath} → ${stripDiffSidePrefix(diffHeader.bPath) ?? normalizedPath}`;
    }
    const headerPath =
      stripDiffSidePrefix(diffHeader.bPath) ?? stripDiffSidePrefix(diffHeader.aPath) ?? normalizedPath;
    // The panel heading already names the file; echoing it here is noise.
    // Show the change label instead; paths reappear only when they differ.
    return headerPath === normalizedPath ? getDiffHeaderLabel(diffHeader.change) : headerPath;
  }, [diffHeader, normalizedPath]);
  const diffRows = useMemo(
    () => (previewMode === "diff" ? parseUnifiedDiff(bodyDiff) : []),
    [bodyDiff, previewMode],
  );
  const splitDiffRows = useMemo(() => buildSplitDiffRows(diffRows), [diffRows]);
  const hasOldLineNumbers = useMemo(() => diffRows.some((row) => row.oldLine !== null), [diffRows]);
  const hasNewLineNumbers = useMemo(() => diffRows.some((row) => row.newLine !== null), [diffRows]);
  const transientBusy = useMemo(() => isTransientBusyDiffError(diffError), [diffError]);
  const integratedCompactPanel = compactHeader && !showDiffHeaderSummary;

  return (
    <div
      className={[
        "flex h-full flex-col overflow-hidden",
        integratedCompactPanel && frame === "standalone" ? `rounded-lg border border-slate-200/70 bg-white/90 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS}` : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={dataTestId}
    >
      <ContentHeader
        title={normalizedPath || "Diff preview"}
        titleText={normalizedPath || undefined}
        titleAs="h4"
        subtitle={showModeLabel ? (modeLabelText ?? (base ? "Agent run" : commit ? "Saved version" : "Working tree")) : undefined}
        icon={<GitBranch />}
        density={compactHeader ? "compact" : "default"}
        tone={integratedCompactPanel ? "subtle" : "default"}
        data-testid={`${testIdPrefix}-toolbar`}
        actions={<>
          {actions}
          {onToggleCollapsed ? (
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={collapsed ? "Expand diff" : "Collapse diff"}
              aria-expanded={!collapsed}
              onPress={onToggleCollapsed}
              data-testid={`${testIdPrefix}-toggle`}
            >
              <NavArrowDown
                className={["h-4 w-4 transition-transform", collapsed ? "-rotate-90" : ""].join(" ")}
                aria-hidden="true"
              />
            </IconButton>
          ) : null}
          {onOpenFile && showOpenFileButton ? (
            <Button
              size="sm"
              elevation="none"
              variant="ghost"
              aria-label="Open file"
              title="Open file"
              onPress={() => normalizedPath && onOpenFile(normalizedPath)}
              isDisabled={!normalizedPath}
              data-testid={`${testIdPrefix}-open-file`}
            >
              Open
            </Button>
          ) : null}
          {showRefreshButton ? (
            <IconButton
              size="sm"
              variant="ghost"
              aria-label="Refresh diff"
              onPress={() => void refresh({ silent: false })}
              isDisabled={diffLoading || !normalizedPath}
              data-testid={`${testIdPrefix}-refresh`}
            >
              <Refresh className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </>}
      />

      {!collapsed ? (
        <div className={["flex-1 overflow-auto p-4", bodyClassName].filter(Boolean).join(" ")}>
        {!normalizedPath ? (
          emptyState ?? <Text tone="secondary">Select a file to preview its diff.</Text>
        ) : diffLoading ? (
          <Text tone="secondary">Loading diff…</Text>
        ) : transientBusy && diff.trim().length === 0 ? (
          <div
            className={`flex items-center gap-2 rounded-xl border border-slate-200/70 bg-slate-50 px-3 py-2 text-sm text-slate-600 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_SOFT_BG_CLASS} dark:text-slate-300`}
            data-testid={`${testIdPrefix}-transient-busy`}
          >
            <Spinner aria-hidden="true" tone="slate" size="xs" />
            <span>Preparing diff…</span>
          </div>
        ) : diffError ? (
          <InlineNotice tone="danger" density="comfortable" role="alert">
            {diffError}
          </InlineNotice>
        ) : diff.trim().length === 0 ? (
          <Text tone="secondary">No diff available.</Text>
        ) : previewMode === "content" ? (
          <div className={frame === "embedded" ? "overflow-hidden font-mono text-xs" : `overflow-hidden rounded-xl border border-slate-200/70 bg-slate-50 font-mono text-xs ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_SOFT_BG_CLASS}`}>
            <div className={`border-b border-slate-200/70 px-3 py-2 text-xxs font-medium uppercase tracking-[0.08em] text-slate-500 ${DARK_DIVIDER_BORDER_CLASS} dark:text-slate-400`}>
              Current file contents
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 text-slate-700 dark:text-slate-200">
              {diff.length > 0 ? diff : "No preview available."}
            </pre>
            {diffTruncated ? (
              <div className={`border-t border-slate-200/70 px-3 py-2 text-xs text-slate-500 ${DARK_DIVIDER_BORDER_CLASS} dark:text-slate-400`}>
                File preview truncated.
              </div>
            ) : null}
          </div>
        ) : (
          <div className={integratedCompactPanel ? "space-y-0" : "space-y-3"}>
            {transientBusy ? (
              <div
                className={`flex items-center gap-2 rounded-xl border border-slate-200/70 bg-slate-50 px-3 py-2 text-sm text-slate-600 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_SOFT_BG_CLASS} dark:text-slate-300`}
                data-testid={`${testIdPrefix}-transient-busy`}
              >
                <Spinner aria-hidden="true" tone="slate" size="xs" />
                <span>Refreshing diff…</span>
              </div>
            ) : null}
            {diffTruncated ? (
              <Text variant="label" tone="secondary">
                Diff truncated.
              </Text>
            ) : null}
            {diffHeader ? (
              <div className="sr-only">
                <span data-testid={`${testIdPrefix}-header-old`}>{diffHeader.aPath ?? `a/${normalizedPath}`}</span>
                <span data-testid={`${testIdPrefix}-header-new`}>{diffHeader.bPath ?? `b/${normalizedPath}`}</span>
              </div>
            ) : null}
            {showDiffHeaderSummary && diffHeader ? (
              <div
                className={frame === "embedded" ? "px-3 py-2 text-sm" : `rounded-xl border border-slate-200/70 bg-white/80 px-3 py-2 text-sm ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS}`}
                data-testid={`${testIdPrefix}-header`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge
                      size="xs"
                      tone={getDiffHeaderBadgeTone(diffHeader.change)}
                      aria-label={getDiffHeaderLabel(diffHeader.change)}
                      title={getDiffHeaderLabel(diffHeader.change)}
                      className="font-mono"
                    >
                      {getDiffHeaderGlyph(diffHeader.change)}
                    </Badge>
                    <Text
                      as="span"
                      variant="bodyStrong"
                      tone="secondary"
                      className="min-w-0 truncate"
                      title={diffHeaderSummaryText}
                    >
                      {diffHeaderSummaryText}
                    </Text>
                  </div>

                  {diffHeader.indexLine || diffHeader.modeLine || diffHeader.binaryLine ? (
                    <Button
                      variant="ghost"
                      preset="inline"
                      onPress={() => setDiffHeaderDetailsOpen((prev) => !prev)}
                      data-testid={`${testIdPrefix}-header-details`}
                    >
                      {diffHeaderDetailsOpen ? "Hide details" : "Details"}
                    </Button>
                  ) : null}
                </div>

                {diffHeaderDetailsOpen ? (
                  <div className="mt-2 space-y-1 text-xs">
                    {diffHeader.indexLine ? (
                      <div className="font-mono text-slate-500 dark:text-slate-400">{diffHeader.indexLine}</div>
                    ) : null}
                    {diffHeader.modeLine ? (
                      <div className="font-mono text-slate-500 dark:text-slate-400">{diffHeader.modeLine}</div>
                    ) : null}
                    {diffHeader.binaryLine ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                        {diffHeader.binaryLine}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {diffRows.length > 0 ? (
              <div
                className={[
                  "overflow-hidden font-mono text-xs",
                  integratedCompactPanel || frame === "embedded"
                    ? "bg-transparent"
                    : `rounded-xl border border-slate-200/70 bg-slate-50 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_SOFT_BG_CLASS}`,
                ].join(" ")}
              >
                {diffViewMode === "split" ? (
                  <div className="overflow-x-auto" data-testid={`${testIdPrefix}-split`}>
                    <div
                      className={[
                        "grid min-w-[52rem] grid-cols-2 text-xxs font-medium uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400",
                        `border-b border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`,
                      ].join(" ")}
                    >
                      <div className={`border-r border-slate-200/70 px-3 py-2 ${DARK_DIVIDER_BORDER_CLASS}`}>Old</div>
                      <div className="px-3 py-2">New</div>
                    </div>
                    {splitDiffRows.map((row, index) => {
                      if (row.kind === "hunk") {
                        return (
                          <div
                            key={`split-hunk-${index}`}
                            className={`border-y border-slate-200/70 bg-slate-100 px-3 py-1 text-slate-700 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_RAIL_BG_CLASS} dark:text-slate-200`}
                          >
                            {row.text}
                          </div>
                        );
                      }
                      if (row.kind === "meta") {
                        return (
                          <div
                            key={`split-meta-${index}`}
                            className={`border-t border-slate-200/70 px-3 py-1 text-slate-500 ${DARK_DIVIDER_BORDER_CLASS} dark:text-slate-400`}
                          >
                            {row.text}
                          </div>
                        );
                      }

                      const renderCell = (cell: SplitDiffCell | null, side: "left" | "right") => (
                        <div
                          className={[
                            "grid min-w-0 grid-cols-[3.25rem_1fr] px-2",
                            getSplitDiffCellClass(cell?.kind ?? "empty"),
                          ].join(" ")}
                          data-testid={`${testIdPrefix}-split-${side}-${index}`}
                        >
                          <span className="select-none py-0.5 pr-3 text-right tabular-nums text-slate-400 dark:text-slate-500">
                            {cell?.lineNumber ?? "\u00A0"}
                          </span>
                          <span className="min-w-0 whitespace-pre py-0.5">{cell?.text.length ? cell.text : "\u00A0"}</span>
                        </div>
                      );

                      return (
                        <div
                          key={`split-line-${index}`}
                          className={`grid min-w-[52rem] grid-cols-2 border-t border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`}
                        >
                          <div className={`border-r border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`}>{renderCell(row.left, "left")}</div>
                          <div>{renderCell(row.right, "right")}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  diffRows.map((row, index) => {
                    if (row.kind === "hunk") {
                      if (index === 0) {
                        return null;
                      }
                      return (
                        <div key={`hunk-${index}`} className="px-3 py-1">
                          <div className={`h-px bg-slate-200/70 ${DARK_DIVIDER_CLASS}`} />
                        </div>
                      );
                    }
                      return (
                        <div
                          key={`${index}-${row.text}`}
                          className={[
                            hasOldLineNumbers && hasNewLineNumbers
                            ? "grid grid-cols-[3.25rem_3.25rem_1fr]"
                            : hasOldLineNumbers || hasNewLineNumbers
                              ? "grid grid-cols-[3.25rem_1fr]"
                              : "grid grid-cols-[1fr]",
                          integratedCompactPanel ? "px-3" : "px-2",
                          getUnifiedDiffRowClass(row),
                        ].join(" ")}
                      >
                        {hasOldLineNumbers ? (
                          <span className="select-none py-0.5 pr-3 text-right tabular-nums text-slate-400 dark:text-slate-500">
                            {row.oldLine ?? "\u00A0"}
                          </span>
                        ) : null}
                        {hasNewLineNumbers ? (
                          <span className="select-none py-0.5 pr-3 text-right tabular-nums text-slate-400 dark:text-slate-500">
                            {row.newLine ?? "\u00A0"}
                          </span>
                        ) : null}
                        <span className="min-w-0 whitespace-pre py-0.5">{row.text.length === 0 ? "\u00A0" : row.text}</span>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              <Text tone="secondary">No line-by-line diff available.</Text>
            )}
          </div>
        )}
        </div>
      ) : null}
    </div>
  );
}
