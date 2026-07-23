import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { WorkspaceGitDiffPanel } from "./WorkspaceGitDiffPanel";

function sanitizeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

const INITIAL_RENDER_BATCH = 12;
const LOAD_MORE_BATCH = 12;

export interface WorkspaceGitRollingDiffPanelProps {
  paths: string[];
  projectId: string | null;
  commit?: string | null;
  runtimeId?: string | null;
  initialPath?: string | null;
  diffViewMode?: "unified" | "split";
  onOpenFile?: (path: string) => void;
  showHeader?: boolean;
  layoutStyle?: "cards" | "flat";
  dataTestId?: string;
  testIdPrefix?: string;
  emptyState?: ReactNode;
  diffOverrides?: Record<
    string,
    {
      diff: string;
      error?: string | null;
      truncated?: boolean | null;
      previewMode?: "diff" | "content";
      synthetic?: boolean;
    }
  >;
}

export function WorkspaceGitRollingDiffPanel({
  paths,
  projectId,
  commit = null,
  runtimeId = null,
  initialPath = null,
  diffViewMode = "unified",
  onOpenFile,
  showHeader = true,
  layoutStyle = "cards",
  dataTestId = "git-rolling-diff-view",
  testIdPrefix = "git-rolling-diff",
  emptyState,
  diffOverrides,
}: WorkspaceGitRollingDiffPanelProps) {
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const initialVisibleCount = useMemo(() => {
    const initialIndex = initialPath ? paths.indexOf(initialPath) : -1;
    return Math.min(paths.length, Math.max(INITIAL_RENDER_BATCH, initialIndex + 1));
  }, [initialPath, paths]);
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const [collapsedByPath, setCollapsedByPath] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setVisibleCount(initialVisibleCount);
  }, [initialVisibleCount]);

  useEffect(() => {
    setCollapsedByPath((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const path of paths) {
        const collapsed = current[path] ?? false;
        if (collapsed) {
          next[path] = true;
        }
        if (current[path] !== collapsed) {
          changed = true;
        }
      }
      if (Object.keys(current).some((path) => !(path in next))) {
        changed = true;
      }
      return changed ? next : current;
    });
  }, [paths]);

  const visiblePaths = useMemo(() => paths.slice(0, visibleCount), [paths, visibleCount]);
  const hasMore = visibleCount < paths.length;

  useEffect(() => {
    if (!initialPath || !visiblePaths.includes(initialPath)) {
      return;
    }
    const element = itemRefs.current.get(initialPath);
    element?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [initialPath, visiblePaths]);

  if (paths.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-8" data-testid={dataTestId}>
        {emptyState ?? <Text tone="secondary">No diffs available.</Text>}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={dataTestId}>
      {showHeader ? (
        <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 px-4 py-3 dark:border-slate-800">
          <div className="min-w-0">
            <Text as="div" variant="bodyStrong" tone="inherit" className="text-sm text-slate-800 dark:text-slate-100">
              All changes
            </Text>
            <Text tone="secondary" className="text-xs">
              Scroll through changed files without switching views.
            </Text>
          </div>
          <Text tone="secondary" className="shrink-0 text-xs">
            {paths.length} {paths.length === 1 ? "file" : "files"}
          </Text>
        </div>
      ) : null}

      <div className={layoutStyle === "flat" ? "flex-1 overflow-y-auto" : "flex-1 overflow-y-auto p-3"}>
        <div
          className={
            layoutStyle === "flat"
              ? "divide-y divide-slate-200/70 dark:divide-slate-800"
              : "flex flex-col gap-3"
          }
        >
          {visiblePaths.map((path) => {
            const itemTestId = `${testIdPrefix}-item-${sanitizeTestId(path)}`;
            return (
              <div
                key={path}
                ref={(element) => {
                  if (element) {
                    itemRefs.current.set(path, element);
                  } else {
                    itemRefs.current.delete(path);
                  }
                }}
                className={
                  layoutStyle === "flat"
                    ? ""
                    : "overflow-hidden rounded-2xl border border-slate-200/70 bg-white/80 dark:border-slate-800 dark:bg-slate-950/40"
                }
                data-testid={itemTestId}
              >
                <WorkspaceGitDiffPanel
                  path={path}
                  commit={commit}
                  projectId={projectId}
                  runtimeId={runtimeId}
                  onOpenFile={onOpenFile}
                  diffOverride={diffOverrides?.[path] ?? null}
                  dataTestId={`${itemTestId}-panel`}
                  testIdPrefix={`${itemTestId}-diff`}
                  className={layoutStyle === "flat" ? "rounded-none border-0 bg-transparent" : undefined}
                  bodyClassName={layoutStyle === "flat" ? "p-0" : "p-3"}
                  showModeLabel={false}
                  showDiffHeaderSummary={false}
                  showOpenFileButton={false}
                  showRefreshButton={false}
                  compactHeader
                  diffViewMode={diffViewMode}
                  collapsed={Boolean(collapsedByPath[path])}
                  onToggleCollapsed={() =>
                    setCollapsedByPath((current) => ({
                      ...current,
                      [path]: !current[path],
                    }))
                  }
                />
              </div>
            );
          })}
        </div>

        {hasMore ? (
          <div className={layoutStyle === "flat" ? "flex justify-center px-4 py-4" : "mt-3 flex justify-center"}>
            <Button
              variant="ghost"
              size="sm"
              radius="xl"
              onPress={() => setVisibleCount((current) => Math.min(paths.length, current + LOAD_MORE_BATCH))}
              data-testid={`${testIdPrefix}-load-more`}
            >
              Show {Math.min(LOAD_MORE_BATCH, paths.length - visibleCount)} more diffs
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
