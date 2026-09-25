import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction,
} from "react";
import { controllerClient, type ControllerWorkspaceEntry } from "../../../sdk/instafy";
import type { CodeFile, CodeWorkspace, WorkspaceEntryKind } from "../../../types";
import {
  buildBinaryPreviewScopeKey,
  forgetBinaryPreviewRequest,
  readBinaryPreviewRequest,
  rememberBinaryPreviewRequest,
} from "./filesBinaryPreviewMemory";

type DirectoryEntries = Record<string, ControllerWorkspaceEntry[]>;

type ViewerMode = "idle" | "loading" | "text" | "image" | "unsupported" | "directory" | "error";

export interface ViewerState {
  mode: ViewerMode;
  entry: ControllerWorkspaceEntry | null;
  error?: string | null;
  imageUrl?: string | null;
  rawUrl?: string | null;
}

const IDLE_VIEWER_STATE: ViewerState = {
  mode: "idle",
  entry: null,
  error: null,
};

export interface OpenWorkspaceFileEventDetail {
  /** Switching a conversation view must not replace an unsaved editor draft. */
  preserveDraft?: boolean;
  /** In-process callers may cancel an accepted open after navigation changes. */
  signal?: AbortSignal;
  handoffId?: string | null;
  path: string;
  projectId?: string | null;
  returnTarget?: "assistant" | "file_list" | null;
  source?: string | null;
  markdownView?: "edit" | "preview";
  preferPreview?: boolean;
  headingSlug?: string | null;
  line?: number | null;
  range?: {
    from?: number | null;
    to?: number | null;
  } | null;
}

type MonacoEditorInstance = {
  setSelection?: (range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }) => void;
  revealRangeInCenter?: (range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }) => void;
  revealLineInCenter?: (lineNumber: number) => void;
  focus?: () => void;
  getModel?: () => {
    getLineMaxColumn?: (lineNumber: number) => number;
  } | null;
};

export type EditorRevealRange = {
  startLine: number;
  endLine: number;
};

type PendingEditorRevealRequest = {
  path: string;
  range: EditorRevealRange;
  isCurrent: () => boolean;
};

interface FileOpenRequest {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

interface UseFilesPanelViewerStateParams {
  acceptExternalOpenEvents: boolean;
  activeFile: CodeFile | null;
  activeProjectId: string | null;
  workspaceOwnerKey?: string | null;
  directoryEntriesRef: RefObject<DirectoryEntries>;
  editorContainerRef: RefObject<HTMLElement | null>;
  effectiveRuntimeId: string | null;
  getParentPath: (path: string) => string | null;
  isImageEntry: (entry: ControllerWorkspaceEntry) => boolean;
  isLargeScreen: boolean;
  isLikelyTextEntry: (entry: ControllerWorkspaceEntry) => boolean;
  isMarkdownWorkspacePath: (path: string | undefined | null) => boolean;
  lastExplorerSelectionRef: RefObject<ControllerWorkspaceEntry | null>;
  loadDirectory: (
    path: string,
    options?: { force?: boolean; syncMode?: "background" | "blocking"; signal?: AbortSignal },
  ) => Promise<ControllerWorkspaceEntry[] | null>;
  normalizePath: (path: string) => string;
  normalizedRootPath: string;
  openFileTab: (file: Pick<CodeFile, "id" | "path" | "label">) => void;
  previewOwnerId: string | null;
  queueMarkdownHeadingJump: (slug: string) => void;
  onOpenWorkspaceFileEvent?: (detail: OpenWorkspaceFileEventDetail) => void;
  requestUrlPush: () => void;
  setActiveFile: (fileId: string | null) => void;
  setExpandedDirectories: (value: SetStateAction<Set<string>>) => void;
  setMarkdownView: (view: "edit" | "preview") => void;
  setMobileView: (value: SetStateAction<"tree" | "viewer">) => void;
  setRootPath: (value: SetStateAction<string>) => void;
  setSearchTerm: (value: SetStateAction<string>) => void;
  showStatus: (message: string, intent: "success" | "error" | "warning" | "info", durationMs?: number) => void;
  updateWorkspace: (
    updater: (current: CodeWorkspace) => CodeWorkspace,
    options?: { recordHistory?: boolean },
  ) => void;
  workspaceFiles: CodeFile[];
  activeFilePathRef: RefObject<string | null>;
}

function createEntryFromWorkspaceFile(file: CodeFile): ControllerWorkspaceEntry {
  return {
    name: file.label ?? (file.path.includes("/") ? file.path.split("/").pop() ?? file.path : file.path),
    path: file.path,
    kind: "file" as WorkspaceEntryKind,
    size: file.size ?? null,
    modified: file.modifiedAt ?? null,
    mimeType: file.mimeType ?? null,
  };
}

function findEntryByPath(
  map: DirectoryEntries,
  path: string,
  getParentPath: (path: string) => string | null,
  normalizePath: (path: string) => string,
): ControllerWorkspaceEntry | null {
  const normalized = normalizePath(path);
  const entries = map[getParentPath(normalized) ?? ""];
  if (!entries) {
    return null;
  }
  return entries.find((entry) => normalizePath(entry.path) === normalized) ?? null;
}

export function useFilesPanelViewerState({
  acceptExternalOpenEvents,
  activeFile,
  activeProjectId,
  workspaceOwnerKey,
  directoryEntriesRef,
  editorContainerRef,
  effectiveRuntimeId,
  getParentPath,
  isImageEntry,
  isLargeScreen,
  isLikelyTextEntry,
  isMarkdownWorkspacePath,
  lastExplorerSelectionRef,
  loadDirectory,
  normalizePath,
  normalizedRootPath,
  onOpenWorkspaceFileEvent,
  openFileTab,
  previewOwnerId,
  queueMarkdownHeadingJump,
  requestUrlPush,
  setActiveFile,
  setExpandedDirectories,
  setMarkdownView,
  setMobileView,
  setRootPath,
  setSearchTerm,
  showStatus,
  updateWorkspace,
  workspaceFiles,
  activeFilePathRef,
}: UseFilesPanelViewerStateParams) {
  const previewScopeKey = buildBinaryPreviewScopeKey(previewOwnerId, activeProjectId);
  // Identity changes invalidate old closures immediately, including A -> B -> A.
  // Runtime selection is part of workspace ownership even within the same space.
  const lifetimeKey = JSON.stringify([previewOwnerId, activeProjectId, effectiveRuntimeId, workspaceOwnerKey, acceptExternalOpenEvents]);
  const lifetimeRef = useRef({ key: lifetimeKey });
  if (lifetimeRef.current.key !== lifetimeKey) lifetimeRef.current = { key: lifetimeKey };
  const lifetime = lifetimeRef.current;
  const [viewerStateSnapshot, setViewerStateSnapshot] = useState<{
    lifetime: typeof lifetime;
    state: ViewerState;
  }>(() => ({ lifetime, state: IDLE_VIEWER_STATE }));
  const viewerStateState =
    viewerStateSnapshot.lifetime === lifetime
      ? viewerStateSnapshot.state
      : IDLE_VIEWER_STATE;
  const viewerStateRef = useRef<ViewerState>(viewerStateState);
  viewerStateRef.current = viewerStateState;
  const pendingEditorRevealRef = useRef<PendingEditorRevealRequest | null>(null);
  const [pendingEditorRevealEpoch, setPendingEditorRevealEpoch] = useState(0);

  const mountedRef = useRef(true);
  const openRequestRef = useRef<{
    lifetime: typeof lifetime;
    controller: AbortController;
    detach: () => void;
  } | null>(null);
  const cancelOpenRequest = useCallback(() => {
    const previous = openRequestRef.current;
    openRequestRef.current = null;
    previous?.detach();
    previous?.controller.abort();
    pendingEditorRevealRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelOpenRequest();
    };
  }, [cancelOpenRequest]);
  useEffect(() => {
    if (openRequestRef.current?.lifetime !== lifetime) cancelOpenRequest();
  }, [cancelOpenRequest, lifetime]);

  const beginOpenRequest = useCallback((signal?: AbortSignal): FileOpenRequest => {
    const controller = new AbortController();
    if (!mountedRef.current || lifetimeRef.current !== lifetime || signal?.aborted) {
      controller.abort();
      return { signal: controller.signal, isCurrent: () => false };
    }
    cancelOpenRequest();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const request = { lifetime, controller, detach: () => signal?.removeEventListener("abort", abort) };
    openRequestRef.current = request;
    return {
      signal: controller.signal,
      isCurrent: () => mountedRef.current && lifetimeRef.current === lifetime
        && openRequestRef.current === request && !controller.signal.aborted,
    };
  }, [cancelOpenRequest, lifetime]);

  const setViewerState = useCallback((nextState: SetStateAction<ViewerState>) => {
    if (!mountedRef.current || lifetimeRef.current !== lifetime) {
      return;
    }
    const resolvedState =
      typeof nextState === "function"
        ? (nextState as (current: ViewerState) => ViewerState)(viewerStateRef.current)
        : nextState;
    viewerStateRef.current = resolvedState;
    setViewerStateSnapshot({ lifetime, state: resolvedState });
  }, [lifetime]);

  useEffect(() => {
    pendingEditorRevealRef.current = null;
    setPendingEditorRevealEpoch(0);
    viewerStateRef.current = IDLE_VIEWER_STATE;
    setViewerStateSnapshot({ lifetime, state: IDLE_VIEWER_STATE });
  }, [lifetime]);

  const tryRevealEditorRange = useCallback(
    (request: PendingEditorRevealRequest): boolean => {
      if (!request.isCurrent()) return false;
      const container = editorContainerRef.current;
      if (!container) {
        return false;
      }

      const editorPath = container.getAttribute("data-studio-editor-path");
      if (normalizePath(editorPath ?? "") !== request.path) {
        return false;
      }

      const instance =
        (container as unknown as { __studioEditorInstance?: MonacoEditorInstance }).__studioEditorInstance ?? null;
      if (!instance) {
        return false;
      }

      const model = typeof instance.getModel === "function" ? instance.getModel() : null;
      if (!model) {
        return false;
      }

      const startLine = Math.max(1, Math.floor(request.range.startLine));
      const endLine = Math.max(startLine, Math.floor(request.range.endLine));
      const endColumn =
        typeof model.getLineMaxColumn === "function"
          ? model.getLineMaxColumn(endLine)
          : 1;
      const selection = {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: Math.max(endColumn, 1),
      };

      try {
        const revealInCenter = () => {
          if (startLine === endLine && typeof instance.revealLineInCenter === "function") {
            instance.revealLineInCenter(startLine);
          } else if (typeof instance.revealRangeInCenter === "function") {
            instance.revealRangeInCenter(selection);
          } else if (typeof instance.revealLineInCenter === "function") {
            instance.revealLineInCenter(startLine);
          }
        };
        if (typeof instance.setSelection === "function") {
          instance.setSelection(selection);
        }
        if (typeof instance.focus === "function") {
          instance.focus();
        }
        revealInCenter();
        window.requestAnimationFrame(() => {
          if (!request.isCurrent()) return;
          try {
            revealInCenter();
          } catch (error) {
            console.warn("[files-panel] failed to refine editor range reveal", error);
          }
        });
        return true;
      } catch (error) {
        console.warn("[files-panel] failed to focus editor range", error);
        return false;
      }
    },
    [editorContainerRef, normalizePath],
  );

  const ensureEntryVisible = useCallback(
    async (entry: ControllerWorkspaceEntry, request = beginOpenRequest()): Promise<boolean> => {
      if (entry.kind !== "file" && entry.kind !== "directory") {
        return false;
      }
      if (!activeProjectId || !request.isCurrent()) {
        return false;
      }
      const targetPath = normalizePath(entry.path);
      let workingRoot = normalizedRootPath;

      if (workingRoot && !targetPath.startsWith(workingRoot)) {
        workingRoot = "";
        setRootPath("");
        await loadDirectory("", { force: true, signal: request.signal });
        if (!request.isCurrent()) return false;
      }

      const relative = workingRoot
        ? targetPath.slice(workingRoot.length).replace(/^\/+/, "")
        : targetPath;
      if (!relative) {
        return true;
      }
      const segments = relative.split("/");
      const depthLimit = entry.kind === "directory" ? segments.length : segments.length - 1;
      let cursor = workingRoot;
      for (let index = 0; index < depthLimit; index += 1) {
        const segment = segments[index];
        cursor = cursor ? `${cursor}/${segment}` : segment;
        await loadDirectory(cursor, { signal: request.signal });
        if (!request.isCurrent()) return false;
        setExpandedDirectories((prev) => {
          if (!request.isCurrent()) return prev;
          const next = new Set(prev);
          next.add(cursor);
          return next;
        });
      }
      return request.isCurrent();
    },
    [
      activeProjectId,
      beginOpenRequest,
      loadDirectory,
      normalizedRootPath,
      normalizePath,
      setExpandedDirectories,
      setRootPath,
    ],
  );

  const focusDirectory = useCallback(
    async (path: string, request = beginOpenRequest()) => {
      if (!request.isCurrent()) return;
      forgetBinaryPreviewRequest(previewScopeKey);
      const normalized = normalizePath(path);
      const previousRoot = normalizedRootPath;
      const nextEntry =
        findEntryByPath(directoryEntriesRef.current, normalized, getParentPath, normalizePath) ??
        (normalized
          ? {
              name: normalized.split("/").pop() ?? normalized,
              path: normalized,
              kind: "directory" as const,
            }
          : null);

      setActiveFile(null);
      setViewerState((current) => ({
        ...current,
        mode: "directory",
        entry: nextEntry,
        error: null,
      }));
      lastExplorerSelectionRef.current = nextEntry;
      const fetched = await loadDirectory(normalized, { force: true, signal: request.signal });
      if (!request.isCurrent()) return;
      if (!fetched) {
        if (normalized !== previousRoot) {
          setRootPath(previousRoot);
        }
        if (normalized.length > 0) {
          showStatus("Unable to load folder contents.", "error");
        }
        setMobileView("tree");
        return;
      }
      setRootPath(normalized);
      setExpandedDirectories(new Set());
      setSearchTerm("");
      setMobileView("tree");
    },
    [
      beginOpenRequest,
      directoryEntriesRef,
      getParentPath,
      lastExplorerSelectionRef,
      loadDirectory,
      normalizePath,
      normalizedRootPath,
      previewScopeKey,
      setActiveFile,
      setExpandedDirectories,
      setMobileView,
      setRootPath,
      setSearchTerm,
      setViewerState,
      showStatus,
    ],
  );

  const openTextFile = useCallback(
    async (entry: ControllerWorkspaceEntry, options?: { forceFetch?: boolean; preserveDraft?: boolean; request?: FileOpenRequest }) => {
      const request = options?.request ?? beginOpenRequest();
      if (!activeProjectId || !request.isCurrent()) {
        return;
      }
      forgetBinaryPreviewRequest(previewScopeKey);
      setViewerState({ mode: "loading", entry, error: null });

      const existing = workspaceFiles.find((file) => file.id === entry.path);
      const existingGenerated = existing?.generated ?? null;
      const existingModified = existing?.modified ?? null;
      const expectedSize = entry.size ?? existing?.size ?? null;
      const computedShouldForceFetch =
        !existing ||
        (expectedSize !== null &&
          ((existingGenerated === null && existingModified === null) ||
            (existingGenerated !== null && existingGenerated.length === 0 && expectedSize > 0) ||
            (existingModified !== null && existingModified.length === 0 && expectedSize > 0)));

      const shouldForceFetch = options?.forceFetch ?? computedShouldForceFetch;

      let textContent: string | null = shouldForceFetch ? null : existingGenerated;
      let mimeType = entry.mimeType ?? existing?.mimeType ?? null;
      let size = entry.size ?? existing?.size ?? null;

      if (shouldForceFetch) {
        const result = await controllerClient.workspace.files.read({
          projectId: activeProjectId,
          path: entry.path,
          runtimeId: effectiveRuntimeId ?? null,
        });
        if (!request.isCurrent()) return;
        if (!result) {
          setViewerState({ mode: "error", entry, error: "Unable to load file content." });
          showStatus("Unable to load file content.", "error");
          return;
        }
        if (!result.isText) {
          const rawUrl = await controllerClient.workspace.files.getRawUrl({
            projectId: activeProjectId,
            path: entry.path,
            runtimeId: effectiveRuntimeId ?? null,
          });
          if (!request.isCurrent()) return;
          setViewerState({
            mode: "unsupported",
            entry,
            rawUrl,
            error: "This file is binary and cannot be opened in the editor.",
          });
          rememberBinaryPreviewRequest(previewScopeKey, "unsupported", entry);
          return;
        }
        textContent = result.contentText ?? "";
        mimeType = result.mimeType ?? entry.mimeType ?? null;
        size = result.size ?? entry.size ?? null;

        updateWorkspace(
          (current) => {
            if (!request.isCurrent()) return current;
            const filtered = current.files.filter((file) => file.id !== entry.path);
            const directory = getParentPath(entry.path);
            const nextFile: CodeFile = {
              id: entry.path,
              path: entry.path,
              label: entry.name,
              directory,
              kind: "file",
              mimeType: mimeType ?? null,
              size,
              modifiedAt: entry.modified ?? null,
              generated: textContent ?? "",
              modified: textContent ?? "",
            };
            const draft = current.files.find(file => file.id === entry.path);
            if (options?.preserveDraft && draft && draft.modified !== draft.generated) {
              nextFile.generated = draft.generated;
              nextFile.modified = draft.modified;
            }
            return {
              ...current,
              files: [...filtered, nextFile],
              activeFileId: entry.path,
            };
          },
          { recordHistory: false },
        );
      } else {
        updateWorkspace(
          (current) => !request.isCurrent() ? current : ({
            ...current,
            activeFileId: entry.path,
            files: current.files.map((file) =>
              file.id === entry.path
                ? {
                    ...file,
                    label: entry.name,
                    directory: getParentPath(entry.path),
                    mimeType: entry.mimeType ?? file.mimeType ?? null,
                    size: entry.size ?? file.size ?? null,
                    modifiedAt: entry.modified ?? file.modifiedAt ?? null,
                  }
                : file,
            ),
          }),
          { recordHistory: false },
        );
      }

      setActiveFile(entry.path);
      requestUrlPush();
      openFileTab({
        id: entry.path,
        path: entry.path,
        label: entry.name ?? entry.path,
      });
      setViewerState({ mode: "text", entry, error: null });
      if (!isLargeScreen) {
        setMobileView("viewer");
      }
    },
    [
      activeProjectId,
      beginOpenRequest,
      effectiveRuntimeId,
      getParentPath,
      isLargeScreen,
      openFileTab,
      previewScopeKey,
      requestUrlPush,
      setActiveFile,
      setMobileView,
      setViewerState,
      showStatus,
      updateWorkspace,
      workspaceFiles,
    ],
  );

  const openImageFile = useCallback(
    async (entry: ControllerWorkspaceEntry, request = beginOpenRequest()) => {
      if (!activeProjectId || !request.isCurrent()) {
        return;
      }
      setActiveFile(null);
      setViewerState({ mode: "loading", entry, error: null });
      try {
        const rawUrl = await controllerClient.workspace.files.getRawUrl({
          projectId: activeProjectId,
          path: entry.path,
          runtimeId: effectiveRuntimeId ?? null,
        });
        if (!request.isCurrent()) return;
        if (!rawUrl) {
          throw new Error("Missing file URL");
        }
        setViewerState({ mode: "image", entry, imageUrl: rawUrl, error: null });
        rememberBinaryPreviewRequest(previewScopeKey, "image", entry);
        if (!isLargeScreen) {
          setMobileView("viewer");
        }
      } catch (error) {
        if (!request.isCurrent()) return;
        forgetBinaryPreviewRequest(previewScopeKey);
        const message = error instanceof Error ? error.message : "Unable to load image preview.";
        setViewerState({ mode: "error", entry, error: message });
        showStatus(message, "error");
      }
    },
    [
      activeProjectId,
      beginOpenRequest,
      effectiveRuntimeId,
      isLargeScreen,
      previewScopeKey,
      setActiveFile,
      setMobileView,
      setViewerState,
      showStatus,
    ],
  );

  const openUnsupportedFile = useCallback(
    async (entry: ControllerWorkspaceEntry, request = beginOpenRequest()) => {
      if (!activeProjectId || !request.isCurrent()) {
        return;
      }
      setActiveFile(null);
      let rawUrl: string | null;
      try {
        rawUrl = await controllerClient.workspace.files.getRawUrl({
          projectId: activeProjectId,
          path: entry.path,
          runtimeId: effectiveRuntimeId ?? null,
        });
      } catch (error) {
        if (!request.isCurrent()) return;
        forgetBinaryPreviewRequest(previewScopeKey);
        throw error;
      }
      if (!request.isCurrent()) return;
      setViewerState({
        mode: "unsupported",
        entry,
        rawUrl,
        error: "This file type is not supported for inline editing.",
      });
      rememberBinaryPreviewRequest(previewScopeKey, "unsupported", entry);
      if (!isLargeScreen) {
        setMobileView("viewer");
      }
    },
    [
      activeProjectId,
      beginOpenRequest,
      effectiveRuntimeId,
      isLargeScreen,
      previewScopeKey,
      setActiveFile,
      setMobileView,
      setViewerState,
    ],
  );

  useEffect(() => {
    const remembered = readBinaryPreviewRequest(previewScopeKey);
    if (!remembered || !activeProjectId) {
      return;
    }
    const request = beginOpenRequest();
    if (!request.isCurrent()) return;

    let cancelled = false;
    setActiveFile(null);
    setViewerState({ mode: "loading", entry: remembered.entry, error: null });

    void controllerClient.workspace.files
      .getRawUrl({
        projectId: activeProjectId,
        path: remembered.entry.path,
        runtimeId: effectiveRuntimeId ?? null,
      })
      .then((rawUrl) => {
        if (cancelled || !request.isCurrent()) {
          return;
        }
        if (!rawUrl) {
          throw new Error("Missing file URL");
        }
        setViewerState(
          remembered.mode === "image"
            ? { mode: "image", entry: remembered.entry, imageUrl: rawUrl, error: null }
            : {
                mode: "unsupported",
                entry: remembered.entry,
                rawUrl,
                error: "This file type is not supported for inline editing.",
              },
        );
      })
      .catch((error) => {
        if (cancelled || !request.isCurrent()) {
          return;
        }
        forgetBinaryPreviewRequest(previewScopeKey);
        const message =
          error instanceof Error ? error.message : "Unable to restore file preview.";
        setViewerState({ mode: "error", entry: remembered.entry, error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    beginOpenRequest,
    effectiveRuntimeId,
    previewScopeKey,
    setActiveFile,
    setViewerState,
  ]);

  const revealEditorRange = useCallback(
    (range: EditorRevealRange, path?: string | null, request = beginOpenRequest()) => {
      if (!request.isCurrent()) return;
      const normalizedPath = normalizePath(path ?? activeFilePathRef.current ?? "");
      if (!normalizedPath) {
        return;
      }
      pendingEditorRevealRef.current = {
        isCurrent: request.isCurrent,
        path: normalizedPath,
        range: {
          startLine: Math.max(1, Math.floor(range.startLine)),
          endLine: Math.max(Math.max(1, Math.floor(range.startLine)), Math.floor(range.endLine)),
        },
      };
      setPendingEditorRevealEpoch((current) => current + 1);
    },
    [activeFilePathRef, beginOpenRequest, normalizePath],
  );

  useEffect(() => {
    const pendingReveal = pendingEditorRevealRef.current;
    if (
      !pendingReveal ||
      viewerStateState.mode !== "text" ||
      normalizePath(activeFile?.path ?? "") !== pendingReveal.path
    ) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let attempts = 0;
    const maxAttempts = 20;

    const attemptReveal = () => {
      if (cancelled) {
        return;
      }
      const currentPendingReveal = pendingEditorRevealRef.current;
      if (!currentPendingReveal || currentPendingReveal.path !== pendingReveal.path || !currentPendingReveal.isCurrent()) {
        return;
      }
      if (tryRevealEditorRange(currentPendingReveal)) {
        pendingEditorRevealRef.current = null;
        return;
      }
      if (attempts >= maxAttempts) {
        return;
      }
      attempts += 1;
      timeoutId = window.setTimeout(attemptReveal, 50);
    };

    timeoutId = window.setTimeout(attemptReveal, 0);
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeFile?.path,
    normalizePath,
    pendingEditorRevealEpoch,
    tryRevealEditorRange,
    viewerStateState.mode,
  ]);

  const openFileFromEvent = useCallback(
    async (detail: OpenWorkspaceFileEventDetail) => {
      if (!activeProjectId) {
        return;
      }
      if (!detail || typeof detail.path !== "string") {
        return;
      }
      if (detail.projectId && detail.projectId !== activeProjectId) {
        return;
      }

      const normalizedPath = normalizePath(detail.path);
      if (!normalizedPath) {
        return;
      }
      const request = beginOpenRequest(detail.signal);
      if (!request.isCurrent()) return;
      const wantsMarkdownPreview =
        detail.markdownView === "preview" || detail.preferPreview === true;
      const headingSlug =
        typeof detail.headingSlug === "string" && detail.headingSlug.trim().length > 0
          ? detail.headingSlug.trim()
          : null;

      const parentPath = getParentPath(normalizedPath) ?? "";
      try {
        await loadDirectory(parentPath, { force: true, signal: request.signal });
      } catch (error) {
        if (request.isCurrent() && import.meta.env.DEV) {
          console.warn("[files-panel] unable to preload directory for path", parentPath, error);
        }
      }
      if (!request.isCurrent()) return;

      const entry =
        findEntryByPath(directoryEntriesRef.current, normalizedPath, getParentPath, normalizePath) ??
        (() => {
          const parentEntries = directoryEntriesRef.current[parentPath] ?? [];
          const needle = normalizedPath.toLowerCase();
          const matches = parentEntries.filter((candidate) => candidate.path.toLowerCase() === needle);
          return matches.length === 1 ? matches[0] ?? null : null;
        })() ??
        ({
          name: normalizedPath.split("/").pop() ?? normalizedPath,
          path: normalizedPath,
          kind: "file" as const,
        } satisfies ControllerWorkspaceEntry);

      if (entry.kind === "directory") {
        await focusDirectory(entry.path, request);
        return;
      }

      onOpenWorkspaceFileEvent?.(detail);
      if (!await ensureEntryVisible(entry, request)) return;

      try {
        if (isImageEntry(entry)) {
          await openImageFile(entry, request);
        } else if (isLikelyTextEntry(entry)) {
          await openTextFile(entry, { forceFetch: true, preserveDraft: detail.preserveDraft, request });
          if (!request.isCurrent()) return;
          if (wantsMarkdownPreview && isMarkdownWorkspacePath(normalizedPath)) {
            setMarkdownView("preview");
          }
        } else {
          await openUnsupportedFile(entry, request);
        }
      } catch (error) {
        if (request.isCurrent()) console.warn("[files-panel] failed to open file from event", normalizedPath, error);
        return;
      }
      if (!request.isCurrent()) return;

      const startLineCandidate =
        typeof detail.line === "number" && !Number.isNaN(detail.line)
          ? detail.line
          : detail.range && typeof detail.range.from === "number"
            ? detail.range.from
            : null;
      const endLineCandidate =
        detail.range && typeof detail.range.to === "number" ? detail.range.to : startLineCandidate;

      if (startLineCandidate && startLineCandidate > 0) {
        const nextRange = {
          startLine: Math.floor(startLineCandidate),
          endLine:
            endLineCandidate && endLineCandidate > 0
              ? Math.max(Math.floor(startLineCandidate), Math.floor(endLineCandidate))
              : Math.floor(startLineCandidate),
        };
        if (wantsMarkdownPreview && headingSlug) {
          queueMarkdownHeadingJump(headingSlug);
        } else {
          revealEditorRange(nextRange, normalizedPath, request);
        }
      } else if (wantsMarkdownPreview && headingSlug) {
        queueMarkdownHeadingJump(headingSlug);
      }
    },
    [
      activeProjectId,
      beginOpenRequest,
      directoryEntriesRef,
      ensureEntryVisible,
      focusDirectory,
      getParentPath,
      isImageEntry,
      isLikelyTextEntry,
      isMarkdownWorkspacePath,
      loadDirectory,
      normalizePath,
      onOpenWorkspaceFileEvent,
      openImageFile,
      openTextFile,
      openUnsupportedFile,
      queueMarkdownHeadingJump,
      revealEditorRange,
      setMarkdownView,
    ],
  );

  // Keep the listener stable while loaded files and callbacks change. A handoff
  // is acknowledged on acceptance, so retries cannot restart an in-flight read.
  const externalOpenRef = useRef({ activeProjectId, openFileFromEvent, normalizePath, lifetime });
  externalOpenRef.current = { activeProjectId, openFileFromEvent, normalizePath, lifetime };
  const acceptedHandoffsRef = useRef({ lifetime, ids: new Set<string>() });
  if (acceptedHandoffsRef.current.lifetime !== lifetime) {
    acceptedHandoffsRef.current = { lifetime, ids: new Set<string>() };
  }
  useEffect(() => {
    if (typeof window === "undefined" || !acceptExternalOpenEvents) return;
    let disposed = false;
    const runtimeWindow = window as typeof window & {
      __INSTAFY_OPEN_WORKSPACE_FILE_ACK__?: string | null;
      __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: OpenWorkspaceFileEventDetail | null;
    };
    const accept = (detail: OpenWorkspaceFileEventDetail) => {
      const current = externalOpenRef.current;
      if (!detail || typeof detail.path !== "string" || detail.signal?.aborted
        || !current.activeProjectId || (detail.projectId && detail.projectId !== current.activeProjectId)
        || !current.normalizePath(detail.path)) return;
      const handoffId = typeof detail.handoffId === "string" && detail.handoffId ? detail.handoffId : null;
      const accepted = acceptedHandoffsRef.current.ids;
      if (handoffId && accepted.has(handoffId)) return;
      if (handoffId) {
        accepted.add(handoffId);
        if (accepted.size > 64) accepted.delete(accepted.values().next().value!);
        runtimeWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__ = handoffId;
      }
      const pending = runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__;
      if (pending === detail || (handoffId && pending?.handoffId === handoffId)
        || (!handoffId && !pending?.handoffId && pending?.path === detail.path
          && (pending.projectId ?? null) === (detail.projectId ?? null))) {
        runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = null;
      }
      void current.openFileFromEvent(detail).catch((error) => {
        if (!detail.signal?.aborted && mountedRef.current && lifetimeRef.current === current.lifetime) {
          console.warn("[files-panel] failed to open workspace file", error);
        }
      });
    };
    const handler = (event: Event) => accept((event as CustomEvent<OpenWorkspaceFileEventDetail>).detail);
    window.addEventListener("instafy:open-workspace-file", handler);
    // StrictMode may dispose an initial listener before replaying its setup.
    // Do not consume the pending handoff in that discarded effect lifetime.
    queueMicrotask(() => {
      const pending = runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__;
      if (!disposed && pending) accept(pending);
    });
    return () => {
      disposed = true;
      window.removeEventListener("instafy:open-workspace-file", handler);
    };
  }, [acceptExternalOpenEvents, lifetime]);

  useEffect(() => {
    if (!activeFile) {
      return;
    }
    const fallbackEntry = createEntryFromWorkspaceFile(activeFile);
    setViewerState((current) => {
      if (current.mode === "directory") {
        return current;
      }
      if (current.entry?.path === activeFile.path && current.mode === "text") {
        return {
          ...current,
          entry: {
            ...fallbackEntry,
            ...(current.entry ?? {}),
          },
        };
      }
      return current;
    });
  }, [activeFile, setViewerState]);

  return {
    viewerState: viewerStateState,
    viewerStateRef,
    setViewerState,
    ensureEntryVisible,
    focusDirectory,
    openTextFile,
    openImageFile,
    openUnsupportedFile,
    revealEditorRange,
    openFileFromEvent,
  };
}
