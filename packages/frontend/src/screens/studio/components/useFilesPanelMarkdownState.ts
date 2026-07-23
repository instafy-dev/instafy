import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { parseMarkdownOutline, type MarkdownOutlineItem } from "../../../components/markdownOutline";
import { controllerClient, type ControllerWorkspaceEntry } from "../../../sdk/instafy";
import type { CodeFile } from "../../../types";

type UseFilesPanelMarkdownStateOptions = {
  activeFile: CodeFile | null;
  activeProjectId: string | null;
  effectiveRuntimeId: string | null;
  markdownPreviewContainerRef: RefObject<HTMLDivElement | null>;
  normalizePath: (path: string) => string;
  isMarkdownWorkspacePath: (path: string) => boolean;
};

export function useFilesPanelMarkdownState({
  activeFile,
  activeProjectId,
  effectiveRuntimeId,
  markdownPreviewContainerRef,
  normalizePath,
  isMarkdownWorkspacePath,
}: UseFilesPanelMarkdownStateOptions) {
  const [markdownView, setMarkdownView] = useState<"edit" | "preview">("edit");
  const [markdownOutlines, setMarkdownOutlines] = useState<Record<string, MarkdownOutlineItem[]>>(
    {},
  );
  const markdownOutlinesRef = useRef<Record<string, MarkdownOutlineItem[]>>({});
  const markdownOutlineRequestsRef = useRef<Record<string, Promise<MarkdownOutlineItem[]>>>({});
  const [markdownOutlineLoadingPaths, setMarkdownOutlineLoadingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedMarkdownPaths, setExpandedMarkdownPaths] = useState<Set<string>>(() => new Set());
  const [collapsedMarkdownSectionKeys, setCollapsedMarkdownSectionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingMarkdownHeadingSlug, setPendingMarkdownHeadingSlug] = useState<string | null>(
    null,
  );

  useEffect(() => {
    markdownOutlinesRef.current = markdownOutlines;
  }, [markdownOutlines]);

  const setMarkdownOutlineForPath = useCallback(
    (path: string, content: string) => {
      const normalizedPath = normalizePath(path);
      const nextItems = parseMarkdownOutline(content);
      setMarkdownOutlines((current) => {
        const previousItems = current[normalizedPath] ?? [];
        const unchanged =
          previousItems.length === nextItems.length &&
          previousItems.every((item, index) => {
            const nextItem = nextItems[index];
            return (
              nextItem &&
              item.title === nextItem.title &&
              item.depth === nextItem.depth &&
              item.line === nextItem.line &&
              item.slug === nextItem.slug
            );
          });
        if (unchanged) {
          return current;
        }
        return {
          ...current,
          [normalizedPath]: nextItems,
        };
      });
      return nextItems;
    },
    [normalizePath],
  );

  const ensureMarkdownOutline = useCallback(
    async (entry: ControllerWorkspaceEntry): Promise<MarkdownOutlineItem[]> => {
      const normalizedPath = normalizePath(entry.path);
      if (!isMarkdownWorkspacePath(normalizedPath)) {
        return [];
      }

      if (activeFile?.path === entry.path) {
        return setMarkdownOutlineForPath(normalizedPath, activeFile.modified);
      }

      const existing = markdownOutlinesRef.current[normalizedPath];
      if (existing) {
        return existing;
      }

      const inflight = markdownOutlineRequestsRef.current[normalizedPath];
      if (inflight) {
        return inflight;
      }

      setMarkdownOutlineLoadingPaths((current) => {
        const next = new Set(current);
        next.add(normalizedPath);
        return next;
      });

      const request = (async () => {
        try {
          if (!activeProjectId) {
            return [];
          }
          const file = await controllerClient.workspace.files.read({
            projectId: activeProjectId,
            path: normalizedPath,
            runtimeId: effectiveRuntimeId ?? null,
          });
          const content = file?.isText ? file.contentText ?? "" : "";
          return setMarkdownOutlineForPath(normalizedPath, content);
        } catch (error) {
          console.warn("[files-panel] failed to load markdown outline", normalizedPath, error);
          return setMarkdownOutlineForPath(normalizedPath, "");
        } finally {
          delete markdownOutlineRequestsRef.current[normalizedPath];
          setMarkdownOutlineLoadingPaths((current) => {
            if (!current.has(normalizedPath)) {
              return current;
            }
            const next = new Set(current);
            next.delete(normalizedPath);
            return next;
          });
        }
      })();

      markdownOutlineRequestsRef.current[normalizedPath] = request;
      return request;
    },
    [
      activeFile,
      activeProjectId,
      effectiveRuntimeId,
      isMarkdownWorkspacePath,
      normalizePath,
      setMarkdownOutlineForPath,
    ],
  );

  useEffect(() => {
    if (!activeFile?.path || !isMarkdownWorkspacePath(activeFile.path)) {
      return;
    }
    setMarkdownOutlineForPath(activeFile.path, activeFile.modified);
  }, [activeFile, isMarkdownWorkspacePath, setMarkdownOutlineForPath]);

  useEffect(() => {
    setMarkdownOutlines({});
    markdownOutlinesRef.current = {};
    markdownOutlineRequestsRef.current = {};
    setMarkdownOutlineLoadingPaths(new Set());
    setExpandedMarkdownPaths(new Set());
    setCollapsedMarkdownSectionKeys(new Set());
    setPendingMarkdownHeadingSlug(null);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeFile?.path) {
      setMarkdownView("edit");
      return;
    }
    if (!isMarkdownWorkspacePath(activeFile.path)) {
      setMarkdownView("edit");
    }
  }, [activeFile?.path, isMarkdownWorkspacePath]);

  const handleToggleMarkdownOutline = useCallback(
    async (entry: ControllerWorkspaceEntry) => {
      if (entry.kind !== "file" || !isMarkdownWorkspacePath(entry.path)) {
        return;
      }
      const normalizedPath = normalizePath(entry.path);
      const wasExpanded = expandedMarkdownPaths.has(normalizedPath);
      setExpandedMarkdownPaths((current) => {
        const next = new Set(current);
        if (next.has(normalizedPath)) {
          next.delete(normalizedPath);
        } else {
          next.add(normalizedPath);
        }
        return next;
      });
      if (!wasExpanded) {
        await ensureMarkdownOutline(entry);
      }
    },
    [ensureMarkdownOutline, expandedMarkdownPaths, isMarkdownWorkspacePath, normalizePath],
  );

  const handleToggleMarkdownSectionCollapse = useCallback(
    (entryPath: string, slug: string) => {
      const key = `${normalizePath(entryPath)}:${slug}`;
      setCollapsedMarkdownSectionKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [normalizePath],
  );

  const queueMarkdownHeadingJump = useCallback((slug: string | null) => {
    setPendingMarkdownHeadingSlug(slug);
  }, []);

  useEffect(() => {
    if (
      markdownView !== "preview" ||
      !pendingMarkdownHeadingSlug ||
      !activeFile?.path ||
      !isMarkdownWorkspacePath(activeFile.path)
    ) {
      return;
    }

    let frameA = 0;
    let frameB = 0;
    const slug = pendingMarkdownHeadingSlug;

    const scrollToHeading = () => {
      const container = markdownPreviewContainerRef.current;
      const target =
        container?.querySelector<HTMLElement>(`[data-markdown-heading-slug="${slug}"]`) ?? null;
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      setPendingMarkdownHeadingSlug(null);
    };

    frameA = window.requestAnimationFrame(() => {
      frameB = window.requestAnimationFrame(scrollToHeading);
    });

    return () => {
      window.cancelAnimationFrame(frameA);
      window.cancelAnimationFrame(frameB);
    };
  }, [
    activeFile?.modified,
    activeFile?.path,
    isMarkdownWorkspacePath,
    markdownPreviewContainerRef,
    markdownView,
    pendingMarkdownHeadingSlug,
  ]);

  return {
    markdownView,
    setMarkdownView,
    markdownOutlines,
    markdownOutlineLoadingPaths,
    expandedMarkdownPaths,
    collapsedMarkdownSectionKeys,
    ensureMarkdownOutline,
    handleToggleMarkdownOutline,
    handleToggleMarkdownSectionCollapse,
    queueMarkdownHeadingJump,
  };
}
