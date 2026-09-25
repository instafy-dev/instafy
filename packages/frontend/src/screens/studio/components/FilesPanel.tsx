import { DARK_DIVIDER_BORDER_CLASS, DARK_DIVIDER_CLASS, DARK_PANEL_BG_CLASS, DARK_PANEL_BORDER_CLASS, DARK_RAIL_HOVER_CLASS } from "../../../theme/darkSurfaces";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState, type JSX, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import { HistoryControls } from "../../../components/HistoryControls";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { DRAWER_ICON_BUTTON_TONE_CLASS, LIST_ROW_SURFACE_BASE, LIST_ROW_FOCUS_RING, listRowSurfaceToneClassName } from "../../../components/listRowStyles";
import { DrawerHeader } from "../../../components/DrawerHeader";
import { Heading } from "../../../components/Heading";
import { MarkdownPreview } from "../../../components/MarkdownPreview";
import { type MarkdownOutlineItem } from "../../../components/markdownOutline";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { SearchInput } from "../../../components/SearchInput";
import { useCode } from "../../../code/useCode";
import { useStatus } from "../../../status/useStatus";
import { useProject } from "../../../projects/useProject";
import {
  controllerClient,
  type ControllerWorkspaceEntry,
  type ControllerWorkspaceWriteResponse,
} from "../../../sdk/instafy";
import type { CodeFile } from "../../../types";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { useTouchLikeInput } from "../../../hooks/useTouchLikeInput";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";
import {
  CloudUpload,
  Collapse,
  Eye,
  FloppyDisk,
  FolderPlus,
  MoreHoriz,
  NavArrowLeft,
  PagePlus,
  Refresh,
  Search,
  Trash,
  Xmark,
} from "iconoir-react";
import { useRuntime } from "../../../runtime/useRuntime";
import { useTheme } from "../../../theme/ThemeProvider";
import { registerProxyInlineCompletionProviders } from "./editorInlineCompletions";
import { ensureStudioMonacoThemes, STUDIO_MONACO_DARK_THEME, STUDIO_MONACO_LIGHT_THEME } from "./monacoThemes";
import {
  useFilesPanelCreateEntries,
} from "./useFilesPanelCreateEntries";
import { useFilesPanelMarkdownState } from "./useFilesPanelMarkdownState";
import { useFilesPanelSaveShortcut } from "./useFilesPanelSaveShortcut";
import {
  type OpenWorkspaceFileEventDetail,
  type ViewerState,
  useFilesPanelViewerState,
} from "./useFilesPanelViewerState";
import { resolveViewerStateWithoutActiveFile } from "./filesPanelViewerSync";
import { FilesExplorerTree } from "./FilesExplorerTree";
import { type DirectoryEntries, useFilesPanelWorkspaceTree } from "./useFilesPanelWorkspaceTree";
import type { FilesPanelMobileView } from "../../studioFilesMobileView";
import { getStudioWorkspaceOwnerKey, type StudioDirectoryListingListener } from "../useStudioKnownFiles";

const ignoreEmbeddedNavigation = () => {};

const runtimeControllerEnabled = controllerClient.core.enabled;

type FilesPanelRenderMode = "workspace" | "portal";

interface FilesPanelProps {
  /** A conversation owns selection; suppress global file-tab navigation. */
  embeddedOpenRequest?: OpenWorkspaceFileEventDetail | null;
  initialRootPath?: string;
  tabsSlot?: ReactNode | null;
  renderMode?: FilesPanelRenderMode;
  previewOwnerId: string | null;
  showExplorer?: boolean;
  explorerPortalTarget?: HTMLDivElement | null;
  mobileView?: FilesPanelMobileView;
  onMobileViewChange?: (value: FilesPanelMobileView) => void;
  onRequestOpenExplorer?: () => void;
  onRequestCloseExplorer?: () => void;
  onDirectoryEntriesLoaded?: StudioDirectoryListingListener;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "ico",
  "avif",
  "svg"
]);

const TEXT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "css",
  "scss",
  "sass",
  "less",
  "pcss",
  "html",
  "htm",
  "md",
  "mdx",
  "txt",
  "yaml",
  "yml",
  "graphql",
  "gql",
  "sql",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "m",
  "mm",
  "swift",
  "sh",
  "bash",
  "zsh",
  "env",
  "lock",
  "toml",
  "ini",
  "conf",
  "config",
  "prisma",
  "php",
  "pl",
  "lua",
  "hs"
]);

const EMPTY_DIRECTORY_PLACEHOLDER = ".instafy.keep";
const INSTAFY_ROOT_ENTRY_NAMES = new Set([".agents", ".instafy", "AGENTS.md", "AGENTS.py", "INSTAFY.md"]);

function normalizePath(path: string): string {
  if (!path) {
    return "";
  }
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isSafeWorkspaceRelativePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) {
    return false;
  }
  const segments = normalized.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function getParentPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (!normalized) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.length <= 1) {
    return "";
  }
  segments.pop();
  return segments.join("/");
}

function getEditorLanguage(path: string | undefined | null): string {
  if (!path) {
    return "plaintext";
  }

  const normalized = normalizePath(path);
  const fileName = normalized.split("/").pop()?.toLowerCase() ?? "";

  if (fileName === "dockerfile" || fileName.endsWith(".dockerfile")) {
    return "dockerfile";
  }

  const extension = extractExtension(fileName)?.toLowerCase() ?? "";

  switch (extension) {
    case "tsx":
      return "typescriptreact";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "jsx":
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "pcss":
      return "css";
    case "scss":
      return "scss";
    case "sass":
      return "sass";
    case "less":
      return "less";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "mdx":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "sql":
      return "sql";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "pl":
      return "perl";
    case "lua":
      return "lua";
    case "m":
    case "mm":
      return "objective-c";
    case "swift":
      return "swift";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "ps1":
      return "powershell";
    case "gql":
    case "graphql":
      return "graphql";
    case "xml":
      return "xml";
    case "ini":
    case "env":
    case "conf":
    case "toml":
      return "ini";
    case "config":
      return "xml";
    default:
      return "plaintext";
  }
}

function shouldShowEditorLineNumbers(path: string | undefined | null): boolean {
  if (!path) {
    return true;
  }

  const normalized = normalizePath(path);
  const fileName = normalized.split("/").pop()?.toLowerCase() ?? "";
  const extension = extractExtension(normalized)?.toLowerCase() ?? "";
  const language = getEditorLanguage(normalized);

  if (
    fileName === "readme" ||
    fileName === "license" ||
    fileName === "copying" ||
    fileName === "notice" ||
    fileName === "authors" ||
    fileName === "changelog" ||
    fileName === "changes"
  ) {
    return false;
  }

  if (extension === "md" || extension === "mdx" || extension === "txt" || extension === "rst") {
    return false;
  }

  if (!extension && (language === "plaintext" || language === "markdown")) {
    return false;
  }

  return true;
}

function isImageEntry(entry: ControllerWorkspaceEntry): boolean {
  const mime = entry.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) {
    return true;
  }
  const extension = entry.extension?.toLowerCase() ?? extractExtension(entry.path);
  return extension ? IMAGE_EXTENSIONS.has(extension) : false;
}

function isLikelyTextEntry(entry: ControllerWorkspaceEntry): boolean {
  if (entry.kind !== "file") {
    return false;
  }
  const mime = entry.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("text/")) {
    return true;
  }
  if (mime === "application/json" || mime === "application/javascript" || mime === "application/typescript") {
    return true;
  }
  const fileName = normalizePath(entry.path).split("/").pop() ?? "";
  if (fileName.startsWith(".")) {
    return true;
  }
  const extension = extractExtension(entry.path);
  if (!extension) {
    return true;
  }
  return TEXT_EXTENSIONS.has(extension);
}

function extractExtension(path: string): string | null {
  const normalized = normalizePath(path);
  if (!normalized) {
    return null;
  }
  const lastSlash = normalized.lastIndexOf("/");
  const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return null;
  }
  return fileName.slice(lastDot + 1).toLowerCase();
}

function createEntryFromCodeFile(file: CodeFile): ControllerWorkspaceEntry {
  return {
    name: file.label ?? (file.path.includes("/") ? file.path.split("/").pop() ?? file.path : file.path),
    path: file.path,
    kind: "file",
    size: file.size ?? null,
    modified: file.modifiedAt ?? null,
    mimeType: file.mimeType ?? null,
    extension: extractExtension(file.path),
    hasChildren: false
  };
}

function isMarkdownWorkspacePath(path: string | undefined | null): boolean {
  if (!path) {
    return false;
  }
  const normalized = normalizePath(path).toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".mdx");
}

function sortEntries(entries: ControllerWorkspaceEntry[]): ControllerWorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === b.kind) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    if (a.kind === "directory") {
      return -1;
    }
    if (b.kind === "directory") {
      return 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function isInstafyManagedPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) {
    return false;
  }
  const [firstSegment] = normalized.split("/");
  if (firstSegment === ".agents" || firstSegment === ".instafy") {
    return true;
  }
  return INSTAFY_ROOT_ENTRY_NAMES.has(normalized);
}

function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  }
  return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}

function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) {
    return "—";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString();
}

export function FilesPanel({
  embeddedOpenRequest,
  initialRootPath,
  tabsSlot = null,
  renderMode = "workspace",
  previewOwnerId,
  showExplorer = true,
  explorerPortalTarget,
  mobileView: controlledMobileView,
  onMobileViewChange,
  onRequestOpenExplorer,
  onRequestCloseExplorer,
  onDirectoryEntriesLoaded,
}: FilesPanelProps) {
  const { workspace, setActiveFile, updateFileContent, updateWorkspace, replaceWorkspace } = useCode();
  const {
    effectiveRuntimeId,
    runtimeReady,
    waitingForPreferredRuntime,
    localWorkspace,
    desktopOrigin,
  } = useRuntime();
  const workspaceOwnerKey = getStudioWorkspaceOwnerKey({ effectiveRuntimeId, localWorkspace, desktopOrigin });
  const { showStatus } = useStatus();
  const { activeProjectId, projectCapabilitiesResolved, canWriteProject } = useProject();
  const projectWriteDisabled =
    projectCapabilitiesResolved === false || canWriteProject === false;
  const { openFileTab, openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const isLargeScreen = useStudioDesktopLayout();
  const touchExplorer = useTouchLikeInput() && !isLargeScreen;
  const { resolvedTheme } = useTheme();
  const [rootPath, setRootPath] = useState<string>(() => normalizePath(initialRootPath ?? ""));
  const [fileViewerReturnTarget, setFileViewerReturnTarget] = useState<"assistant" | null>(null);
  const activeProjectIdRef = useRef<string | null>(activeProjectId ?? null);
  const handleOpenProjects = useCallback(() => {
    openPanelTab("projects", { activate: true });
    onRequestCloseExplorer?.();
  }, [onRequestCloseExplorer, openPanelTab]);

  const handleOpenChat = useCallback(() => {
    setFileViewerReturnTarget(null);
    openPanelTab("chat", { activate: true });
    onRequestCloseExplorer?.();
  }, [onRequestCloseExplorer, openPanelTab]);

  const editorContainerRef = useRef<HTMLElement | null>(null);
  const markdownPreviewContainerRef = useRef<HTMLDivElement | null>(null);
  const rootExplorerMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const inlineCompletionCleanupRef = useRef<(() => void) | null>(null);
  const pendingEditorFocusRef = useRef(false);
  const activeFilePathRef = useRef<string | null>(null);
  const activeFileDraftRef = useRef<{ fileId: string | null; value: string | null }>({
    fileId: null,
    value: null,
  });
  const activeFileGeneratedRef = useRef<{ fileId: string | null; value: string | null }>({
    fileId: null,
    value: null,
  });
  const saveDraftShortcutHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const saveVersionShortcutHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(() => searchTerm.trim().length > 0);
  const lastLocalCommitRef = useRef<{ rev: string; at: number } | null>(null);
  const [activeFileHasVersionChanges, setActiveFileHasVersionChanges] = useState<boolean | null>(null);
  const activeFileVersionEpochRef = useRef(0);
  const viewerStateBridgeRef = useRef<ViewerState>({ mode: "idle", entry: null, error: null });
  const setViewerStateBridgeRef = useRef<
    (nextState: SetStateAction<ViewerState>) => void
  >(() => undefined);
  const viewerActionsRef = useRef<{
    openImageFile: (entry: ControllerWorkspaceEntry) => Promise<void>;
    openTextFile: (
      entry: ControllerWorkspaceEntry,
      options?: { forceFetch?: boolean },
    ) => Promise<void>;
    openUnsupportedFile: (entry: ControllerWorkspaceEntry) => Promise<void>;
  } | null>(null);

  const [uncontrolledMobileView, setUncontrolledMobileView] =
    useState<FilesPanelMobileView>("tree");
  const mobileView = controlledMobileView ?? uncontrolledMobileView;
  const setMobileView = useCallback(
    (value: SetStateAction<FilesPanelMobileView>) => {
      const resolvedValue =
        typeof value === "function"
          ? (value as (current: FilesPanelMobileView) => FilesPanelMobileView)(mobileView)
          : value;
      if (controlledMobileView !== undefined) {
        onMobileViewChange?.(resolvedValue);
        return;
      }
      setUncontrolledMobileView(resolvedValue);
    },
    [controlledMobileView, mobileView, onMobileViewChange],
  );
  const handOffPortalPreview = useCallback(
    (entry: ControllerWorkspaceEntry): boolean => {
      if (
        renderMode !== "portal" ||
        isLargeScreen ||
        !activeProjectId ||
        typeof window === "undefined"
      ) {
        return false;
      }

      const handoffId =
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `workspace-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const detail: OpenWorkspaceFileEventDetail = {
        handoffId,
        path: entry.path,
        projectId: activeProjectId,
      };
      const runtimeWindow = window as typeof window & {
        __INSTAFY_OPEN_WORKSPACE_FILE_ACK__?: string | null;
        __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: OpenWorkspaceFileEventDetail | null;
      };
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
      requestUrlPush();
      openPanelTab("code");
      setMobileView("viewer");
      let attempts = 0;
      const notifyDestination = () => {
        if (runtimeWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__ === handoffId) {
          return;
        }
        window.dispatchEvent(
          new CustomEvent<OpenWorkspaceFileEventDetail>("instafy:open-workspace-file", {
            detail,
          }),
        );
        attempts += 1;
        if (attempts < 30) {
          window.requestAnimationFrame(notifyDestination);
        }
      };
      window.requestAnimationFrame(notifyDestination);
      return true;
    },
    [
      activeProjectId,
      isLargeScreen,
      openPanelTab,
      renderMode,
      requestUrlPush,
      setMobileView,
    ],
  );
  const handleBackToFileList = useCallback(() => {
    setFileViewerReturnTarget(null);
    onRequestOpenExplorer?.();
    if (controlledMobileView === undefined) {
      setUncontrolledMobileView("tree");
    }
  }, [controlledMobileView, onRequestOpenExplorer]);
  const handleMobileViewerBack = useCallback(() => {
    if (fileViewerReturnTarget === "assistant") {
      handleOpenChat();
      return;
    }
    handleBackToFileList();
  }, [fileViewerReturnTarget, handleBackToFileList, handleOpenChat]);
  const handleOpenWorkspaceFileEvent = useCallback((detail: OpenWorkspaceFileEventDetail) => {
    setFileViewerReturnTarget(detail.returnTarget === "assistant" ? "assistant" : null);
  }, []);
  const [saveMode, setSaveMode] = useState<null | "draft" | "version">(null);
  const resetTrackingRef = useRef<{ projectId: string | null; initialRoot: string }>({
    projectId: activeProjectId ?? null,
    initialRoot: normalizePath(initialRootPath ?? "")
  });
  const hasBootstrappedWorkspaceRef = useRef(false);

  const normalizedRootPath = useMemo(() => normalizePath(rootPath), [rootPath]);
  const explorerPortalEnabled = explorerPortalTarget !== null && explorerPortalTarget !== undefined;
  const showExplorerInline = showExplorer && !explorerPortalEnabled;

  const activeFile = useMemo(() => {
    if (!workspace.activeFileId) {
      return null;
    }
    return workspace.files.find((file) => file.id === workspace.activeFileId) ?? null;
  }, [workspace.activeFileId, workspace.files]);

  const {
    markdownView,
    setMarkdownView,
    markdownOutlines,
    markdownOutlineLoadingPaths,
    expandedMarkdownPaths,
    collapsedMarkdownSectionKeys,
    handleToggleMarkdownOutline,
    handleToggleMarkdownSectionCollapse,
    queueMarkdownHeadingJump,
  } = useFilesPanelMarkdownState({
    activeFile,
    activeProjectId,
    effectiveRuntimeId,
    markdownPreviewContainerRef,
    normalizePath,
    isMarkdownWorkspacePath,
  });

  const getActiveEditorValue = useCallback((): string | null => {
    const container = editorContainerRef.current;
    const instance =
      container && (container as unknown as { __studioEditorInstance?: unknown }).__studioEditorInstance
        ? (container as unknown as { __studioEditorInstance?: unknown }).__studioEditorInstance
        : null;

    if (!instance || typeof instance !== "object") {
      return null;
    }

    const directGetValue = (instance as { getValue?: () => string }).getValue;
    if (typeof directGetValue === "function") {
      try {
        const value = directGetValue.call(instance);
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    }

    const model = (instance as { getModel?: () => unknown }).getModel?.();
    const modelGetValue = model && typeof model === "object" ? (model as { getValue?: () => string }).getValue : null;
    if (typeof modelGetValue === "function") {
      try {
        const value = modelGetValue.call(model);
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    }

    return null;
  }, []);

  const getPendingActiveFileContent = useCallback((): string | null => {
    if (!activeFile) {
      return null;
    }
    const fromEditor = getActiveEditorValue();
    if (typeof fromEditor === "string") {
      return fromEditor;
    }
    if (
      activeFileDraftRef.current.fileId === activeFile.id &&
      typeof activeFileDraftRef.current.value === "string"
    ) {
      return activeFileDraftRef.current.value;
    }
    return activeFile.modified;
  }, [activeFile, getActiveEditorValue]);

  useEffect(() => {
    if (!activeFile) {
      activeFileDraftRef.current = { fileId: null, value: null };
      activeFileGeneratedRef.current = { fileId: null, value: null };
      return;
    }
    activeFileDraftRef.current = { fileId: activeFile.id, value: activeFile.modified };
    activeFileGeneratedRef.current = { fileId: activeFile.id, value: activeFile.generated };
  }, [activeFile]);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId ?? null;
  }, [activeProjectId]);

  const activeFilePath = activeFile?.path ?? null;
  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
    const container = editorContainerRef.current;
    if (container) {
      if (activeFilePath) {
        container.setAttribute("data-studio-editor", "true");
        container.setAttribute("data-studio-editor-path", activeFilePath);
      } else {
        container.removeAttribute("data-studio-editor-path");
      }
    }
    if (typeof window === "undefined" || !import.meta.env.DEV) {
      return;
    }
    const registryKey = activeFilePath;
    return () => {
      if (!registryKey) {
        return;
      }
      const globalObject = window as unknown as { __STUDIO_MONACO__?: Map<string, unknown> };
      globalObject.__STUDIO_MONACO__?.delete(registryKey);
    };
  }, [activeFilePath]);

  const dirtyFileIds = useMemo(() => {
    const ids = new Set<string>();
    workspace.files.forEach((file) => {
      if (file.modified !== file.generated) {
        ids.add(file.id);
      }
    });
    return ids;
  }, [workspace.files]);
  const dirtyFileIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    dirtyFileIdsRef.current = dirtyFileIds;
  }, [dirtyFileIds]);

  const workspaceOriginOnline =
    localWorkspace?.status === "online" ||
    localWorkspace?.presenceStatus === "online" ||
    localWorkspace?.presenceStatus === "degraded" ||
    Boolean(
      desktopOrigin?.endpoint &&
        (desktopOrigin.mode ?? "").toLowerCase() === "hosted",
    );
  const workspaceBrowseReady = runtimeReady || workspaceOriginOnline;

  const {
    directoryEntries,
    directoryEntriesRef,
    directoryStatus,
    setDirectoryEntries,
    setDirectoryStatus,
    expandedDirectories,
    setExpandedDirectories,
    lastExplorerSelectionRef,
    loadDirectory,
    explorerMenu,
    explorerMenuRef,
    setExplorerMenu,
    openExplorerMenu,
    handleEntryContextMenu,
    handleDeleteExplorerEntry,
    refreshFromWorkspaceCommit,
    renderDirectoryStatus,
    getDirectoryAttemptCount,
    resolveCreateEntryParentPath,
  } = useFilesPanelWorkspaceTree({
    activeFilePath,
    activeFileDraftRef,
    activeFileGeneratedRef,
    activeFilePathRef,
    activeProjectId,
    dirtyFileIdsRef,
    effectiveRuntimeId,
    getActiveEditorValue,
    getParentPath,
    isImageEntry,
    isLikelyTextEntry,
    isSafeWorkspaceRelativePath,
    lastLocalCommitRef,
    normalizedRootPath,
    normalizePath,
    runtimeReady,
    setActiveFile,
    showStatus,
    sortEntries,
    viewerActionsRef,
    viewerStateRef: viewerStateBridgeRef,
    setViewerStateRef: setViewerStateBridgeRef,
    waitingForPreferredRuntime,
    workspaceBrowseReady,
    workspaceOwnerId: previewOwnerId,
    workspaceOwnerKey,
    onDirectoryEntriesLoaded,
    readOnly: projectWriteDisabled,
  });

  const refreshActiveFileVersionStatus = useCallback(
    async (path: string | null) => {
      const normalizedPath = normalizePath(path ?? "");
      if (!activeProjectId || !runtimeReady || !normalizedPath) {
        setActiveFileHasVersionChanges(null);
        return;
      }
      activeFileVersionEpochRef.current += 1;
      const epoch = activeFileVersionEpochRef.current;

      const status = await controllerClient.workspace.git.fetchStatus({
        projectId: activeProjectId,
        runtimeId: effectiveRuntimeId ?? null,
      }).catch(() => null);

      if (activeFileVersionEpochRef.current !== epoch) {
        return;
      }
      if (!status || !status.supported) {
        setActiveFileHasVersionChanges(null);
        return;
      }

      setActiveFileHasVersionChanges(
        status.dirtyPaths.some((entry) => normalizePath(entry.path) === normalizedPath),
      );
    },
    [activeProjectId, effectiveRuntimeId, runtimeReady],
  );

  useEffect(() => {
    void refreshActiveFileVersionStatus(activeFilePath);
  }, [activeFilePath, refreshActiveFileVersionStatus]);

  const previousIsLargeScreenRef = useRef<boolean | null>(null);
  useEffect(() => {
    const previous = previousIsLargeScreenRef.current;
    previousIsLargeScreenRef.current = isLargeScreen;
    if (isLargeScreen && previous === false) {
      setMobileView("tree");
    }
  }, [isLargeScreen, setMobileView]);

  useEffect(() => {
    if (isLargeScreen) {
      setMobileSearchOpen(false);
      return;
    }
    if (searchTerm.trim().length > 0) {
      setMobileSearchOpen(true);
    }
  }, [isLargeScreen, searchTerm]);

  useEffect(() => {
    if (isLargeScreen || !mobileSearchOpen) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isLargeScreen, mobileSearchOpen]);

  useEffect(() => {
    return () => {
      inlineCompletionCleanupRef.current?.();
      inlineCompletionCleanupRef.current = null;
      const container = editorContainerRef.current;
      if (!container) {
        return;
      }
      container.removeAttribute("data-studio-editor");
      container.removeAttribute("data-studio-editor-path");
      delete (container as unknown as { __studioEditorInstance?: unknown }).__studioEditorInstance;
      editorContainerRef.current = null;
    };
  }, []);

  useEffect(() => {
    hasBootstrappedWorkspaceRef.current = false;
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    if (hasBootstrappedWorkspaceRef.current || embeddedOpenRequest !== undefined) {
      return;
    }
    const activeFileId = workspace.activeFileId;
    const hasActiveFile =
      activeFileId !== null && workspace.files.some((file) => file.id === activeFileId);
    if (hasActiveFile) {
      hasBootstrappedWorkspaceRef.current = true;
      return;
    }
    if (workspace.files.length === 0) {
      hasBootstrappedWorkspaceRef.current = true;
      return;
    }
    replaceWorkspace(
      {
        ...workspace,
        files: [],
        activeFileId: null,
        error: null
      },
      { resetHistory: true, setInitial: true }
    );
    hasBootstrappedWorkspaceRef.current = true;
  }, [activeProjectId, embeddedOpenRequest, replaceWorkspace, workspace]);


  const handleEditorWillMount = useCallback((monaco: Monaco | null) => {
    ensureStudioMonacoThemes(monaco);
    if (monaco && !inlineCompletionCleanupRef.current) {
      inlineCompletionCleanupRef.current = registerProxyInlineCompletionProviders(monaco, {
        getProjectId: () => activeProjectIdRef.current,
        getFilePath: () => activeFilePathRef.current,
      });
    }

    if (monaco?.languages?.typescript) {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ESNext,
        allowNonTsExtensions: true,
        allowJs: true,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
        jsxImportSource: "react",
        esModuleInterop: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        noEmit: true,
        useDefineForClassFields: false,
        allowSyntheticDefaultImports: true
      });
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSuggestionDiagnostics: true,
        diagnosticCodesToIgnore: Array.from([1375, 1378, 2307, 7016, 8010])
      });
      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    }
  }, []);

  const handleEditorDidMount = useCallback(
    (
      editorInstance: {
        getContainerDomNode?: () => HTMLElement | null;
        addCommand?: (keybinding: number, handler: () => void) => unknown;
        focus?: () => void;
      },
      monaco: Monaco | null
    ) => {
      const container = editorInstance?.getContainerDomNode?.();
      if (container) {
        editorContainerRef.current = container;
        container.setAttribute("data-studio-editor", "true");
        if (activeFilePathRef.current) {
          container.setAttribute("data-studio-editor-path", activeFilePathRef.current);
        }
        (container as unknown as { __studioEditorInstance?: typeof editorInstance }).__studioEditorInstance =
          editorInstance;
      }
      if (pendingEditorFocusRef.current && typeof editorInstance?.focus === "function") {
        pendingEditorFocusRef.current = false;
        window.setTimeout(() => {
          try {
            editorInstance.focus?.();
          } catch (error) {
            console.warn("[files-panel] failed to focus editor after mount", error);
          }
        }, 0);
      }
      if (monaco && typeof editorInstance?.addCommand === "function") {
        editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          const handler = saveVersionShortcutHandlerRef.current;
          if (handler) {
            void handler();
          }
        });
        editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
          const handler = saveDraftShortcutHandlerRef.current;
          if (handler) {
            void handler();
          }
        });
      }
      if (typeof window === "undefined" || !import.meta.env.DEV) {
        return;
      }
      const globalObject = window as unknown as {
        __STUDIO_MONACO__?: Map<string, { editor: typeof editorInstance }>;
      };
      if (!globalObject.__STUDIO_MONACO__) {
        globalObject.__STUDIO_MONACO__ = new Map();
      }
      const path = activeFilePathRef.current;
      if (path) {
        globalObject.__STUDIO_MONACO__!.set(path, { editor: editorInstance });
      }
    },
    []
  );

  const focusEditorWhenReady = useCallback(() => {
    pendingEditorFocusRef.current = true;
    if (typeof window === "undefined") {
      return;
    }

    let attempts = 0;
    const maxAttempts = 8;
    const attemptFocus = () => {
      const container = editorContainerRef.current;
      const instance =
        container &&
        (container as unknown as { __studioEditorInstance?: { focus?: () => void } }).__studioEditorInstance
          ? (container as unknown as { __studioEditorInstance?: { focus?: () => void } }).__studioEditorInstance
          : null;

      if (!instance || typeof instance.focus !== "function") {
        if (attempts >= maxAttempts) {
          return;
        }
        attempts += 1;
        window.setTimeout(attemptFocus, 50);
        return;
      }

      pendingEditorFocusRef.current = false;
      try {
        instance.focus();
      } catch (error) {
        console.warn("[files-panel] failed to focus editor", error);
      }
    };

    attemptFocus();
  }, []);

  const {
    viewerState,
    viewerStateRef,
    setViewerState,
    ensureEntryVisible,
    focusDirectory,
    openTextFile,
    openImageFile,
    openUnsupportedFile,
    openFileFromEvent,
  } = useFilesPanelViewerState({
    workspaceOwnerKey,
    acceptExternalOpenEvents: embeddedOpenRequest === undefined && renderMode !== "portal",
    activeFile,
    activeProjectId,
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
    onOpenWorkspaceFileEvent: handleOpenWorkspaceFileEvent,
    openFileTab: embeddedOpenRequest === undefined ? openFileTab : ignoreEmbeddedNavigation,
    previewOwnerId,
    queueMarkdownHeadingJump,
    requestUrlPush: embeddedOpenRequest === undefined ? requestUrlPush : ignoreEmbeddedNavigation,
    setActiveFile,
    setExpandedDirectories,
    setMarkdownView,
    setMobileView,
    setRootPath,
    setSearchTerm,
    showStatus,
    updateWorkspace,
    workspaceFiles: workspace.files,
    activeFilePathRef,
  });

  const embeddedOpenRef = useRef(openFileFromEvent);
  embeddedOpenRef.current = openFileFromEvent;
  useEffect(() => {
    if (!embeddedOpenRequest) return;
    const abort = new AbortController();
    void embeddedOpenRef.current({ ...embeddedOpenRequest, preserveDraft: true, signal: abort.signal });
    return () => abort.abort();
  }, [embeddedOpenRequest, effectiveRuntimeId, workspaceOwnerKey]);

  useEffect(() => {
    viewerStateBridgeRef.current = viewerState;
  }, [viewerState]);

  useEffect(() => {
    setViewerStateBridgeRef.current = setViewerState;
  }, [setViewerState]);

  useEffect(() => {
    viewerActionsRef.current = {
      openImageFile,
      openTextFile,
      openUnsupportedFile,
    };
  }, [openImageFile, openTextFile, openUnsupportedFile]);

  useEffect(() => {
    const normalizedInitial = normalizePath(initialRootPath ?? "");
    const nextProjectId = activeProjectId ?? null;
    const previous = resetTrackingRef.current;
    const projectChanged = previous.projectId !== nextProjectId;
    const rootChanged = previous.initialRoot !== normalizedInitial;
    resetTrackingRef.current = { projectId: nextProjectId, initialRoot: normalizedInitial };

    if (!projectChanged && !rootChanged) {
      return;
    }

    const shouldPreserveSelection =
      !projectChanged &&
      normalizedInitial.length === 0 &&
      (workspace.activeFileId !== null || workspace.files.length > 0);

    if (shouldPreserveSelection) {
      return;
    }

    setActiveFile(null);
    setDirectoryEntries({});
    setDirectoryStatus({});
    setExpandedDirectories(new Set());
    setRootPath(normalizedInitial);
    setSearchTerm("");
    setViewerState({ mode: "idle", entry: null, error: null });
    setMobileView("tree");
  }, [
    activeProjectId,
    initialRootPath,
    setActiveFile,
    setDirectoryEntries,
    setDirectoryStatus,
    setExpandedDirectories,
    setMobileView,
    setViewerState,
    workspace.activeFileId,
    workspace.files.length,
  ]);

  const {
    createFileState,
    createFileInputRef,
    setCreateFileState,
    createFolderState,
    createFolderInputRef,
    setCreateFolderState,
    handleStartCreateFile,
    handleCancelCreateFile,
    handleCommitCreateFile,
    handleStartCreateFolder,
    handleCancelCreateFolder,
    handleCommitCreateFolder,
  } = useFilesPanelCreateEntries({
    activeProjectId,
    effectiveRuntimeId,
    isLargeScreen,
    expandedDirectories,
    emptyDirectoryPlaceholder: EMPTY_DIRECTORY_PLACEHOLDER,
    normalizePath,
    isSafeWorkspaceRelativePath,
    getParentPath,
    sortEntries,
    loadDirectory,
    showStatus,
    ensureEntryVisible,
    openTextFile,
    focusEditorWhenReady,
    onLocalCommit: (rev) => {
      lastLocalCommitRef.current = { rev, at: Date.now() };
    },
    setDirectoryEntries,
    setExpandedDirectories,
    setSearchTerm,
    setMobileView,
    clearExplorerMenu: () => setExplorerMenu(null),
    readOnly: projectWriteDisabled,
  });

  const handleSelectMarkdownSection = useCallback(
    async (entry: ControllerWorkspaceEntry, section: MarkdownOutlineItem) => {
      await openFileFromEvent({
        path: entry.path,
        projectId: activeProjectId,
        markdownView: markdownView === "preview" ? "preview" : "edit",
        headingSlug: section.slug,
        line: section.line,
      });
    },
    [activeProjectId, markdownView, openFileFromEvent]
  );

  useFilesPanelSaveShortcut({ editorContainerRef, markdownPreviewContainerRef, viewerStateRef,
    saveDraftHandlerRef: saveDraftShortcutHandlerRef, saveVersionHandlerRef: saveVersionShortcutHandlerRef });

  const handleSelectEntry = useCallback(
    async (entry: ControllerWorkspaceEntry, options?: { viaSearch?: boolean }) => {
      lastExplorerSelectionRef.current = entry;
      setFileViewerReturnTarget(null);
      if (entry.kind === "directory") {
        if (options?.viaSearch) {
          if (!await ensureEntryVisible(entry)) return;
        }
        setViewerState({ mode: "directory", entry, error: null });
        if (!isLargeScreen) {
          setMobileView("tree");
          await focusDirectory(entry.path);
        }
        return;
      }

      if (options?.viaSearch) {
        if (!await ensureEntryVisible(entry)) return;
      }

      if (isImageEntry(entry)) {
        if (handOffPortalPreview(entry)) {
          return;
        }
        await openImageFile(entry);
        if (!isLargeScreen && !onMobileViewChange) {
          onRequestCloseExplorer?.();
        }
        return;
      }

      if (isLikelyTextEntry(entry)) {
        await openTextFile(entry);
        if (!isLargeScreen && !onMobileViewChange) {
          onRequestCloseExplorer?.();
        }
        return;
      }

      if (handOffPortalPreview(entry)) {
        return;
      }
      await openUnsupportedFile(entry);
      if (!isLargeScreen && !onMobileViewChange) {
        onRequestCloseExplorer?.();
      }
    },
    [
      ensureEntryVisible,
      focusDirectory,
      handOffPortalPreview,
      isLargeScreen,
      lastExplorerSelectionRef,
      onMobileViewChange,
      onRequestCloseExplorer,
      openImageFile,
      openTextFile,
      setFileViewerReturnTarget,
      setMobileView,
      setViewerState,
      openUnsupportedFile
    ]
  );

  const handleToggleDirectory = useCallback(
    async (entry: ControllerWorkspaceEntry) => {
      if (entry.kind !== "directory") {
        return;
      }
      const normalized = normalizePath(entry.path);
      const isExpanded = expandedDirectories.has(normalized);
      if (isExpanded) {
        setExpandedDirectories((prev) => {
          const next = new Set(prev);
          next.delete(normalized);
          return next;
        });
      } else {
        await loadDirectory(normalized);
        setExpandedDirectories((prev) => {
          const next = new Set(prev);
          next.add(normalized);
          return next;
        });
      }
      setViewerState((current) => ({
        ...current,
        entry: entry,
        mode: "directory",
        error: null
      }));
      setActiveFile(null);
    },
    [expandedDirectories, loadDirectory, setActiveFile, setViewerState, setExpandedDirectories]
  );

  const openChanges = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent("instafy:open-source-control"));
  }, []);

  const writeActiveFileToWorkspace = useCallback(async (): Promise<ControllerWorkspaceWriteResponse> => {
    if (!activeProjectId || !activeFile) {
      throw new Error("Missing active file.");
    }
    if (!runtimeReady) {
      throw new Error("Runtime not ready yet.");
    }
    if (projectWriteDisabled) {
      throw new Error("This space is read-only. Ask an admin for edit access.");
    }
    const pendingContent = getPendingActiveFileContent() ?? activeFile.modified;

    const response: ControllerWorkspaceWriteResponse | null =
      await controllerClient.workspace.files.write({
      projectId: activeProjectId,
      path: activeFile.path,
      content: pendingContent,
      runtimeId: effectiveRuntimeId ?? null
      });
    if (!response || !response.ok) {
      throw new Error("Controller rejected the write request.");
    }
    if (typeof response.rev === "string" && response.rev.trim().length > 0) {
      lastLocalCommitRef.current = { rev: response.rev.trim(), at: Date.now() };
    }
    const appliedAt = new Date().toISOString();
    updateWorkspace(
      (current) => ({
        ...current,
        files: current.files.map((file) =>
          file.id === activeFile.id
            ? {
                ...file,
                generated: pendingContent,
                modified: file.modified === activeFile.generated ? pendingContent : file.modified,
                size: response.size,
                modifiedAt: appliedAt
              }
            : file
        ),
        lastAppliedAt: appliedAt
      }),
      { recordHistory: false }
    );
    activeFileDraftRef.current = { fileId: activeFile.id, value: pendingContent };
    setDirectoryEntries((prev) =>
      updateEntryMetadata(prev, activeFile.path, {
        size: response.size,
        modified: appliedAt
      })
    );
    return response;
  }, [
    activeFile,
    activeProjectId,
    effectiveRuntimeId,
    getPendingActiveFileContent,
    runtimeReady,
    projectWriteDisabled,
    setDirectoryEntries,
    updateWorkspace,
  ]);

  const handleSaveDraft = useCallback(async () => {
    if (!activeProjectId || !activeFile || projectWriteDisabled) {
      return;
    }
    const pendingContent = getPendingActiveFileContent() ?? activeFile.modified;
    if (saveMode || pendingContent === activeFile.generated) {
      return;
    }
    setSaveMode("draft");
    try {
      await writeActiveFileToWorkspace();
      setActiveFileHasVersionChanges(true);
      void refreshActiveFileVersionStatus(activeFile.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save draft.";
      showStatus(message, "error", 4500);
    } finally {
      setSaveMode(null);
    }
  }, [
    activeFile,
    activeProjectId,
    getPendingActiveFileContent,
    refreshActiveFileVersionStatus,
    projectWriteDisabled,
    saveMode,
    showStatus,
    writeActiveFileToWorkspace,
  ]);

  const handleSaveVersion = useCallback(async () => {
    if (!activeProjectId || !activeFile || projectWriteDisabled) {
      return;
    }
    if (saveMode) {
      return;
    }
    const pendingContent = getPendingActiveFileContent() ?? activeFile.modified;
    const hasUnsavedEdits = pendingContent !== activeFile.generated;
    if (!hasUnsavedEdits && activeFileHasVersionChanges === false) {
      return;
    }
    setSaveMode("version");
    try {
      if (hasUnsavedEdits) {
        await writeActiveFileToWorkspace();
        setActiveFileHasVersionChanges(true);
      }

      const fileLabel = activeFile.label ?? activeFile.path.split("/").pop() ?? activeFile.path;
      const result = await controllerClient.workspace.git.syncToRemote({
        projectId: activeProjectId,
        runtimeId: effectiveRuntimeId ?? null,
        message: `Save version: ${fileLabel}`,
        paths: [activeFile.path]
      });

      if (!result?.ok) {
        const detail =
          typeof result?.error === "string" && result.error.trim().length > 0
            ? result.error.trim()
            : null;

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("instafy:workspace-git-sync-result", {
              detail: {
                projectId: activeProjectId,
                ok: false,
                conflict: result?.conflict === true,
                error: detail
              }
            })
          );
        }

        if (result?.conflict) {
          showStatus(detail ? `Conflicts detected. ${detail}` : "Conflicts detected while saving a version.", "error", 8000, {
            actionLabel: "Resolve",
            onAction: openChanges
          });
          openChanges();
        } else {
          showStatus(detail ? `Unable to save version. ${detail}` : "Unable to save version.", "error", 6500);
        }
        return;
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("instafy:workspace-git-sync-result", {
            detail: { projectId: activeProjectId, ok: true, conflict: false, error: null }
          })
        );
      }
      setActiveFileHasVersionChanges(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save version.";
      showStatus(message, "error", 4500);
    } finally {
      setSaveMode(null);
    }
  }, [
    activeFile,
    activeProjectId,
    activeFileHasVersionChanges,
    effectiveRuntimeId,
    getPendingActiveFileContent,
    openChanges,
    projectWriteDisabled,
    saveMode,
    showStatus,
    writeActiveFileToWorkspace
  ]);

  saveDraftShortcutHandlerRef.current = handleSaveDraft;
  saveVersionShortcutHandlerRef.current = handleSaveVersion;

  const handleChangeActiveFile = useCallback(
    (value: string | undefined) => {
      if (!activeFile || projectWriteDisabled) {
        return;
      }
      const nextValue = value ?? "";
      activeFileDraftRef.current = { fileId: activeFile.id, value: nextValue };
      updateFileContent(activeFile.id, nextValue);
    },
    [activeFile, projectWriteDisabled, updateFileContent]
  );

  const breadcrumbs = useMemo(() => {
    const segments = normalizedRootPath ? normalizedRootPath.split("/") : [];
    const crumbs: Array<{ label: string; path: string }> = [];
    let cursor = "";
    segments.forEach((segment) => {
      cursor = cursor ? `${cursor}/${segment}` : segment;
      crumbs.push({ label: segment, path: cursor });
    });
    return crumbs;
  }, [normalizedRootPath]);

  const normalizedSearch = searchTerm.trim().toLowerCase();

  const searchResults = useMemo(() => {
    if (!normalizedSearch) {
      return [];
    }
    const visited = new Set<string>();
    const results: ControllerWorkspaceEntry[] = [];
    const traverse = (path: string) => {
      if (visited.has(path)) {
        return;
      }
      visited.add(path);
      const entries = directoryEntries[path];
      if (!entries) {
        return;
      }
      entries.forEach((entry) => {
        const haystack = `${entry.name} ${entry.path}`.toLowerCase();
        if (haystack.includes(normalizedSearch)) {
          results.push(entry);
        }
        if (entry.kind === "directory") {
          traverse(normalizePath(entry.path));
        }
      });
    };
    traverse(normalizedRootPath);
    return results;
  }, [directoryEntries, normalizedRootPath, normalizedSearch]);

  const activePath = viewerState.entry?.path ?? activeFile?.path ?? null;

  const rootDirectoryStatus = directoryStatus[normalizedRootPath];
  const showRootDirectoryErrorCard = workspaceBrowseReady && rootDirectoryStatus === "error";
  const rootEntries = directoryEntries[normalizedRootPath] ?? [];
  const rootLoadingLabel = !workspaceBrowseReady
    ? waitingForPreferredRuntime
      ? "Waiting for preferred runtime…"
      : "Connecting to workspace origin…"
    : getDirectoryAttemptCount(normalizedRootPath) > 0
      ? "Connecting to workspace origin…"
      : "Loading files…";
  const showCenteredRootLoading =
    !showRootDirectoryErrorCard &&
    !normalizedSearch &&
    rootEntries.length === 0 &&
    (!workspaceBrowseReady || rootDirectoryStatus === "loading");
  const rootDirectoryStatusNode = showRootDirectoryErrorCard
    ? null
    : showCenteredRootLoading
      ? null
      : renderDirectoryStatus(normalizedRootPath);

  useEffect(() => {
    if (!showRootDirectoryErrorCard) {
      return;
    }
    const retryTimer = window.setTimeout(() => {
      void loadDirectory(normalizedRootPath, { force: true });
    }, 5000);
    return () => {
      window.clearTimeout(retryTimer);
    };
  }, [loadDirectory, normalizedRootPath, showRootDirectoryErrorCard]);

  const handleToggleMobileSearch = useCallback(() => {
    if (mobileSearchOpen) {
      if (searchTerm.trim().length > 0) {
        setSearchTerm("");
      }
      setMobileSearchOpen(false);
      return;
    }
    setMobileSearchOpen(true);
  }, [mobileSearchOpen, searchTerm]);

  const handleOpenRootExplorerMenu = useCallback(() => {
    const buttonBounds = rootExplorerMenuButtonRef.current?.getBoundingClientRect();
    openExplorerMenu({
      targetPath: resolveCreateEntryParentPath(),
      clientX: buttonBounds ? buttonBounds.left : window.innerWidth - 24,
      clientY: buttonBounds ? buttonBounds.bottom + 8 : 72,
    });
  }, [openExplorerMenu, resolveCreateEntryParentPath]);

  const showInlineSearch = isLargeScreen || mobileSearchOpen || touchExplorer;
  const showBreadcrumbs = isLargeScreen || (!mobileSearchOpen && !touchExplorer);
  const rootLabel = normalizedRootPath ? breadcrumbs[breadcrumbs.length - 1]?.label ?? normalizedRootPath : "Root";
  const fileExplorerSubtitle = `${rootLabel} · ${rootEntries.length} ${rootEntries.length === 1 ? "item" : "items"}`;

  const treeContent = (
    <div
      className="flex h-full min-h-0 flex-col px-4 pb-3"
      data-testid="files-explorer-tree"
    >
      <DrawerHeader
        title="Files"
        frame="rail"
        className="-mx-4"
        actions={
          <>
            {!isLargeScreen && !touchExplorer ? (
              <IconButton
                variant={mobileSearchOpen ? "secondary" : "ghost"}
                size="sm"
                radius="full"
                aria-label={mobileSearchOpen ? "Close file search" : "Search files"}
                title={mobileSearchOpen ? "Close search" : "Search files"}
                data-testid="files-explorer-search-toggle"
                onPress={handleToggleMobileSearch}
                className={[
                  "h-11 w-11 shadow-none",
                  mobileSearchOpen
                    ? "bg-slate-100 text-slate-900 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-100"
                    : DRAWER_ICON_BUTTON_TONE_CLASS,
                ].join(" ")}
              >
                <Search className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="New file"
              title="New file"
              data-testid="files-explorer-new-file"
              onPress={() => void handleStartCreateFile(resolveCreateEntryParentPath())}
              isDisabled={projectWriteDisabled || !runtimeReady || createFileState?.busy === true || createFolderState?.busy === true}
              className={`max-[899px]:h-11 max-[899px]:w-11 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
            >
              <PagePlus className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <IconButton
              ref={rootExplorerMenuButtonRef}
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="More file actions"
              title="More"
              data-testid={touchExplorer ? "files-explorer-touch-actions" : "files-explorer-actions"}
              onPress={handleOpenRootExplorerMenu}
              className={`max-[899px]:h-11 max-[899px]:w-11 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
            >
              <MoreHoriz className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            {onRequestCloseExplorer ? (
              <IconButton
                variant="ghost"
                size="sm"
                radius="full"
                aria-label="Close file explorer"
                title="Close"
                data-testid="files-explorer-close"
                onPress={onRequestCloseExplorer}
                className={`max-[899px]:h-11 max-[899px]:w-11 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
              >
                <Xmark className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
          </>
        }
      />
      {touchExplorer ? (
        <Text variant="caption" tone="muted" className="mb-2 truncate">{fileExplorerSubtitle}</Text>
      ) : null}
      {showBreadcrumbs ? (
        <nav aria-label="File location" className="flex min-w-0 items-center gap-1 overflow-hidden mb-2 min-h-6 text-xs font-medium text-slate-500 dark:text-slate-400">
          {breadcrumbs.length === 0 ? (
            <span className="truncate text-slate-700 dark:text-slate-200">/</span>
          ) : (
            <Button
              onPress={() => focusDirectory("")}
              variant="ghost"
              size="xs"
              radius="full"
              className="shrink-0 px-0 text-slate-500 hover:bg-transparent hover:text-slate-800 data-[hovered]:bg-transparent dark:text-slate-400 dark:hover:text-slate-100"
              aria-label="Focus root folder"
            >
              /
            </Button>
          )}
          {breadcrumbs.map((crumb, index) => {
            const isLast = index === breadcrumbs.length - 1;
            return (
              <span key={crumb.path} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <span className="shrink-0 text-slate-300 dark:text-slate-700">/</span> : null}
                {isLast ? (
                  <span className="truncate text-slate-700 dark:text-slate-200">{crumb.label}</span>
                ) : (
                  <Button
                    onPress={() => focusDirectory(crumb.path)}
                    variant="ghost"
                    size="xs"
                    radius="full"
                    className="max-w-[10rem] truncate px-0 text-slate-500 hover:bg-transparent hover:text-slate-800 data-[hovered]:bg-transparent dark:text-slate-400 dark:hover:text-slate-100"
                  >
                    {crumb.label}
                  </Button>
                )}
              </span>
            );
          })}
        </nav>
      ) : null}

      {showRootDirectoryErrorCard ? (
        <Card
          tone="muted"
          radius="2xl"
          shadow="none"
          padding="sm"
          className="mt-2 border border-rose-200/60 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/10"
        >
          <Text variant="caption" tone="subtle" className="text-xxs">
            Unable to load files right now. Retrying in the background. You can retry now, or switch back to chat.
          </Text>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              onPress={() => void loadDirectory(normalizedRootPath, { force: true })}
              variant="outline"
              size="xs"
              radius="full"
            >
              Retry
            </Button>
            <Button
              onPress={handleOpenChat}
              variant="outline"
              size="xs"
              radius="full"
            >
              Back to Assistant
            </Button>
          </div>
        </Card>
      ) : null}

      {projectWriteDisabled ? (
        <div
          className="mt-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100"
          data-testid="files-read-only-notice"
          role="status"
        >
          Read-only — you can browse files, but you can’t edit, create, or delete them.
        </div>
      ) : null}

      {showInlineSearch ? (
        <div
          className="mt-1 flex items-center gap-2"
          data-testid="files-explorer-search-row"
        >
          <div className="min-w-0 flex-1">
            <SearchInput
              ref={searchInputRef}
              id="code-search"
              label="Search files"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search name or path"
              tone="default"
              radius="xl"
              size={isLargeScreen ? "sm" : "md"}
              className="min-h-10 max-[899px]:min-h-11 pointer-coarse:min-h-11"
              iconTestId="code-search-icon"
              inputTestId="code-search-input"
            />
          </div>
          {!isLargeScreen && !touchExplorer ? (
            <IconButton
              onPress={handleToggleMobileSearch}
              variant="ghost"
              size="xs"
              radius="full"
              aria-label="Cancel file search"
              title="Cancel search"
              data-testid="files-explorer-search-cancel"
              className={`h-11 w-11 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      ) : null}

      <div
        className="mt-3 min-h-0 flex-1 overflow-y-auto"
        onContextMenu={(event) => {
          event.preventDefault();
          openExplorerMenu({ targetPath: normalizedRootPath, clientX: event.clientX, clientY: event.clientY });
        }}
      >
        {showCenteredRootLoading ? (
          <div className="flex h-full min-h-[220px] items-center justify-center">
            <LoadingStatus>{rootLoadingLabel}</LoadingStatus>
          </div>
        ) : normalizedSearch ? (
          <ul className={touchExplorer ? "space-y-1.5" : "space-y-1"}>
            {searchResults.length === 0 ? (
              <li>
                <Card
                  tone="muted"
                  radius="2xl"
                  shadow="none"
                  padding="sm"
                  className="py-1.5 text-xs text-slate-500"
                >
                  No files matched “{searchTerm}”.
                </Card>
              </li>
            ) : (
                searchResults.map((entry) => (
                  <li key={entry.path}>
                    <Button
                      onPress={() => handleSelectEntry(entry, { viaSearch: true })}
                      variant="ghost"
                      size="sm"
                      radius="2xl"
                      fullWidth
                      className={`flex-col items-start justify-start gap-1 text-left ${touchExplorer ? "px-3.5 py-3 text-base" : "px-3 py-1.5"} ${listRowSurfaceToneClassName(activePath === entry.path)} ${LIST_ROW_SURFACE_BASE} ${LIST_ROW_FOCUS_RING}`}
                      data-testid={`files-entry-${entry.path.replace(/[^a-zA-Z0-9]/g, "-")}`}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span>{entry.name}</span>
                        {dirtyFileIds.has(entry.path) ? <span className="text-xs text-rose-500">●</span> : null}
                      </div>
                      <Text as="p" variant="caption" tone="subtle" className="w-full break-words">
                        {entry.path}
                      </Text>
                    </Button>
                  </li>
                ))
            )}
          </ul>
        ) : (
            <FilesExplorerTree
              rootPath={normalizedRootPath}
              entriesMap={directoryEntries}
              expandedDirectories={expandedDirectories}
              expandedMarkdownPaths={expandedMarkdownPaths}
              markdownOutlines={markdownOutlines}
              markdownOutlineLoadingPaths={markdownOutlineLoadingPaths}
              collapsedMarkdownSectionKeys={collapsedMarkdownSectionKeys}
              activePath={activePath}
              dirtyFileIds={dirtyFileIds}
              normalizePath={normalizePath}
              isInstafyManagedPath={isInstafyManagedPath}
              isMarkdownWorkspacePath={isMarkdownWorkspacePath}
              onSelect={handleSelectEntry}
              onToggle={handleToggleDirectory}
              onToggleMarkdownOutline={handleToggleMarkdownOutline}
              onSelectMarkdownSection={handleSelectMarkdownSection}
              onToggleMarkdownSectionCollapse={handleToggleMarkdownSectionCollapse}
              onFocus={focusDirectory}
              onEntryContextMenu={handleEntryContextMenu}
              createFile={createFileState}
              createFileInputRef={createFileInputRef}
              onCreateFileDraftChange={(value) =>
                setCreateFileState((current) => (current ? { ...current, draft: value } : current))
              }
              onCreateFileCommit={handleCommitCreateFile}
              onCreateFileCancel={handleCancelCreateFile}
              createFolder={createFolderState}
              createFolderInputRef={createFolderInputRef}
              onCreateFolderDraftChange={(value) =>
                setCreateFolderState((current) => (current ? { ...current, draft: value } : current))
              }
              onCreateFolderCommit={handleCommitCreateFolder}
              onCreateFolderCancel={handleCancelCreateFolder}
              touchDensity={touchExplorer}
            />
          )}
        </div>
      {rootDirectoryStatusNode ? (
        <div className={`mt-2 border-t border-slate-200/70 px-1 pt-1.5 ${DARK_DIVIDER_BORDER_CLASS}`}>
          <div className="min-h-[1rem]">{rootDirectoryStatusNode}</div>
        </div>
      ) : null}

      {explorerMenu ? (
          <div
            ref={explorerMenuRef}
            className="fixed z-[80] w-60 overflow-y-auto"
            style={{
              left: explorerMenu.x,
              top: explorerMenu.y,
              maxHeight: explorerMenu.maxHeight,
            }}
            data-testid="files-explorer-menu"
          >
              <Surface tone="floating" radius="2xl" shadow="lg" className="p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  className="justify-start gap-2"
                  onPress={() => {
                    setExplorerMenu(null);
                    void handleStartCreateFile(explorerMenu.targetPath);
                  }}
                  isDisabled={projectWriteDisabled || !runtimeReady || createFileState?.busy === true || createFolderState?.busy === true}
                  data-testid="files-explorer-menu-new-file"
                >
                  <PagePlus className="h-4 w-4" aria-hidden="true" />
                  New file
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  className="justify-start gap-2"
                  onPress={() => {
                    setExplorerMenu(null);
                    void handleStartCreateFolder(explorerMenu.targetPath);
                  }}
                  isDisabled={projectWriteDisabled || !runtimeReady || createFileState?.busy === true || createFolderState?.busy === true}
                  data-testid="files-explorer-menu-new-folder"
                >
                  <FolderPlus className="h-4 w-4" aria-hidden="true" />
                  New folder
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  className="justify-start gap-2"
                onPress={() => {
                  setExplorerMenu(null);
                  void refreshFromWorkspaceCommit(null);
                }}
                isDisabled={!workspaceBrowseReady}
                  data-testid="files-explorer-menu-refresh"
                >
                  <Refresh className="h-4 w-4" aria-hidden="true" />
                  Refresh
                </Button>
                <div className={`my-1 h-px bg-slate-200 ${DARK_DIVIDER_CLASS}`} />
                <Button
                variant="ghost"
                size="sm"
                radius="lg"
                fullWidth
                className="justify-start gap-2"
                onPress={() => {
                  setExpandedDirectories(new Set());
                  setExplorerMenu(null);
                }}
                  data-testid="files-explorer-menu-collapse-all"
                >
                  <Collapse className="h-4 w-4" aria-hidden="true" />
                  Collapse all
                </Button>
                {explorerMenu.deleteEntry ? (
                  <>
                    <div className={`my-1 h-px bg-slate-200 ${DARK_DIVIDER_CLASS}`} />
                    <Button
                      variant="ghost"
                      size="sm"
                      radius="lg"
                      fullWidth
                      className="justify-start gap-2 text-rose-600 hover:bg-rose-50 data-[hovered]:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10 dark:data-[hovered]:bg-rose-500/10"
                      onPress={() => {
                        const deleteTarget = explorerMenu.deleteEntry;
                        setExplorerMenu(null);
                        if (deleteTarget) {
                          void handleDeleteExplorerEntry(deleteTarget);
                        }
                      }}
                      isDisabled={projectWriteDisabled || !runtimeReady}
                      data-testid="files-explorer-menu-delete"
                    >
                      <Trash className="h-4 w-4" aria-hidden="true" />
                      Delete…
                    </Button>
                  </>
                ) : null}
              </Surface>
            </div>
          ) : null}
        </div>
      );

  const viewerHeader = useMemo(
    () => {
      const normalizeHeaderPath = (value: string) =>
        value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const extractBaseName = (value: string) => {
        const normalized = normalizeHeaderPath(value);
        if (!normalized) {
          return value;
        }
        const parts = normalized.split("/");
        return parts[parts.length - 1] ?? value;
      };
      const extractDisplayPath = (value: string) => {
        const normalized = normalizeHeaderPath(value);
        if (!normalized) {
          return null;
        }
        const parts = normalized.split("/");
        if (parts.length <= 1) {
          return null;
        }
        return normalized;
      };

      const rawPath = viewerState.entry?.path ?? activeFile?.path ?? "";
      const rawTitle = viewerState.entry?.name ?? activeFile?.label ?? "";
      const titleCandidate = rawTitle.trim().length > 0 ? rawTitle : rawPath;
      const title = titleCandidate.trim().length > 0 ? extractBaseName(titleCandidate) : "Select a file";
      const subtitle = rawPath.trim().length > 0 ? extractDisplayPath(rawPath) : null;
      const mobileViewerBackTarget =
        embeddedOpenRequest === undefined && !isLargeScreen && mobileView === "viewer"
          ? fileViewerReturnTarget === "assistant"
            ? "assistant"
            : showExplorerInline
              ? "file_list"
              : null
          : null;
      const mobileViewerBackLabel =
        mobileViewerBackTarget === "assistant" ? "Back to Assistant" : "Back to file list";

      return (
        <header className={`flex items-center justify-between gap-2 border-b border-slate-200/70 px-4 py-2.5 ${DARK_DIVIDER_BORDER_CLASS}`}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {mobileViewerBackTarget ? (
                <IconButton
                  onPress={handleMobileViewerBack}
                  variant="ghost"
                  size="sm"
                  radius="full"
                  aria-label={mobileViewerBackLabel}
                  title={mobileViewerBackLabel}
                  className="-ml-1 shrink-0"
                  data-testid={
                    mobileViewerBackTarget === "assistant"
                      ? "files-back-to-assistant-button"
                      : "files-back-button"
                  }
                >
                  <NavArrowLeft className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ) : null}
              {embeddedOpenRequest === undefined && isLargeScreen && activePath && fileViewerReturnTarget === "assistant" ? (
                <Button
                  onPress={handleOpenChat}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  aria-label="Back to Assistant"
                  title="Back to Assistant"
                  className="-ml-1 shrink-0 text-slate-500 hover:bg-slate-100 hover:text-slate-800 data-[hovered]:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100 dark:data-[hovered]:bg-slate-900"
                >
                  <NavArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  Assistant
                </Button>
              ) : null}
              <Heading level={3} variant="subtitle" className="truncate">
                {title}
              </Heading>
              {projectWriteDisabled ? (
                <Badge
                  tone="warning"
                  size="xs"
                  data-testid="files-viewer-read-only-badge"
                  title="You can review files but cannot change them"
                >
                  Read-only
                </Badge>
              ) : null}
            </div>
            {subtitle ? (
              <Text variant="caption" tone="muted" className="truncate">
                {subtitle}
              </Text>
            ) : null}
          </div>
          {viewerState.mode === "text" && activeFile ? (
            <div className="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
              {!projectWriteDisabled ? <HistoryControls /> : null}
              {isMarkdownWorkspacePath(activeFile.path) ? (
                isLargeScreen ? (
                  <Button
                    onPress={() => setMarkdownView((current) => (current === "preview" ? "edit" : "preview"))}
                    variant={markdownView === "preview" ? "secondary" : "outline"}
                    size="sm"
                    radius="full"
                    title={markdownView === "preview" ? "Back to the editor" : "Preview markdown"}
                    className="min-w-[6.5rem]"
                  >
                    <Eye className="h-4 w-4" aria-hidden="true" />
                    {markdownView === "preview" ? "Edit" : "Preview"}
                  </Button>
                ) : (
                  <IconButton
                    onPress={() => setMarkdownView((current) => (current === "preview" ? "edit" : "preview"))}
                    variant={markdownView === "preview" ? "secondary" : "outline"}
                    size="sm"
                    radius="full"
                    aria-label={markdownView === "preview" ? "Back to the editor" : "Preview markdown"}
                    title={markdownView === "preview" ? "Back to the editor" : "Preview markdown"}
                  >
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                )
              ) : null}
              <IconButton
                onPress={handleSaveDraft}
                isDisabled={projectWriteDisabled || activeFile.modified === activeFile.generated}
                variant="outline"
                size="sm"
                radius="full"
                data-testid="code-save-draft-button"
                aria-label={saveMode === "draft" ? "Saving draft" : "Save draft"}
                title={saveMode === "draft" ? "Saving draft…" : "Save draft"}
                className={saveMode === "draft" ? "pointer-events-none opacity-80" : undefined}
              >
                {saveMode === "draft" ? (
                  <Refresh className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FloppyDisk className="h-4 w-4" aria-hidden="true" />
                )}
              </IconButton>
              <IconButton
                onPress={handleSaveVersion}
                isDisabled={
                  projectWriteDisabled ||
                  (activeFile.modified === activeFile.generated && activeFileHasVersionChanges === false)
                }
                variant="primary"
                size="sm"
                radius="full"
                data-testid="code-save-button"
                aria-label={saveMode === "version" ? "Saving version" : "Save version"}
                title={saveMode === "version" ? "Saving version…" : "Save version"}
                className={saveMode === "version" ? "pointer-events-none opacity-90" : undefined}
              >
                {saveMode === "version" ? (
                  <Refresh className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CloudUpload className="h-4 w-4" aria-hidden="true" />
                )}
              </IconButton>
            </div>
          ) : (
            <div className="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
              {!projectWriteDisabled ? <HistoryControls /> : null}
            </div>
          )}
        </header>
      );
    },
    [
      activeFile,
      activePath,
      embeddedOpenRequest,
      fileViewerReturnTarget,
      handleOpenChat,
      handleMobileViewerBack,
      handleSaveDraft,
      handleSaveVersion,
      isLargeScreen,
      mobileView,
      projectWriteDisabled,
      showExplorerInline,
      activeFileHasVersionChanges,
      saveMode,
      viewerState,
      markdownView,
      setMarkdownView
    ]
  );

  const renderTextViewer = useCallback(() => {
    if (!activeFile) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
          Select a file to start editing.
        </div>
      );
    }
    activeFilePathRef.current = activeFile.path ?? null;
    const isMarkdown = isMarkdownWorkspacePath(activeFile.path);
    if (isMarkdown && markdownView === "preview") {
      return (
        <div ref={markdownPreviewContainerRef} className="h-full overflow-y-auto px-6 py-5">
          <MarkdownPreview value={activeFile.modified} />
        </div>
      );
    }
    const editorKey = activeFile.path ?? "files-editor";
    return (
      <Editor
        key={editorKey}
        loading={
          <div className="flex h-full items-center justify-center">
            <LoadingStatus>Loading file…</LoadingStatus>
          </div>
        }
        path={activeFile.path}
        defaultLanguage={getEditorLanguage(activeFile.path)}
        theme={resolvedTheme === "dark" ? STUDIO_MONACO_DARK_THEME : STUDIO_MONACO_LIGHT_THEME}
        value={activeFile.modified}
        onChange={handleChangeActiveFile}
        options={{
          readOnly: projectWriteDisabled,
          domReadOnly: projectWriteDisabled,
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular",
          fontSize: 14,
          lineNumbers: shouldShowEditorLineNumbers(activeFile.path) ? "on" : "off",
          inlineSuggest: { enabled: true },
          quickSuggestions: { other: true, comments: true, strings: true },
          suggestOnTriggerCharacters: true,
          wordBasedSuggestions: "off",
          tabCompletion: "on",
          acceptSuggestionOnEnter: "smart",
          suggest: {
            preview: false,
            selectionMode: "whenQuickSuggestion",
          },
          // Curly quotes and other common prose punctuation should not look like editor errors.
          unicodeHighlight: {
            nonBasicASCII: false,
            ambiguousCharacters: false,
            invisibleCharacters: true,
          },
          automaticLayout: true,
          smoothScrolling: true,
          scrollBeyondLastLine: false
        }}
        beforeMount={handleEditorWillMount}
        onMount={handleEditorDidMount}
        wrapperProps={{
        "data-testid": "monaco-editor",
        "data-file": activeFile.path
      }}
    />
    );
  }, [activeFile, handleChangeActiveFile, handleEditorDidMount, handleEditorWillMount, markdownView, projectWriteDisabled, resolvedTheme]);

  const viewerBody = useMemo(() => {
    switch (viewerState.mode) {
      case "loading":
        return (
          <div className="flex h-full items-center justify-center">
            <LoadingStatus>Loading file…</LoadingStatus>
          </div>
        );
      case "text":
        return renderTextViewer();
      case "image":
        return viewerState.imageUrl ? (
          <div className={`flex h-full items-center justify-center bg-slate-50 ${DARK_PANEL_BG_CLASS}`}>
            <img
              src={viewerState.imageUrl}
              alt={viewerState.entry?.name ?? "Preview"}
              className={`max-h-full max-w-full rounded-xl border border-slate-200 bg-white shadow-sm ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS}`}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Unable to load image preview.
          </div>
        );
      case "unsupported":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <Badge size="sm" className="px-4 py-2 text-sm text-slate-600">
              {viewerState.entry?.mimeType ?? "Unsupported file type"}
            </Badge>
            <Text as="p" variant="body" tone="muted" className="max-w-sm">
              This file cannot be opened directly in the studio. Download it or open it in a new tab to preview.
            </Text>
            <div className="flex gap-3">
              <a
                href={viewerState.rawUrl ?? "#"}
                target="_blank"
                rel="noreferrer"
                className={`rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 ${DARK_PANEL_BORDER_CLASS} dark:text-slate-200 ${DARK_RAIL_HOVER_CLASS}`}
              >
                Open in new tab
              </a>
            </div>
          </div>
        );
      case "directory":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-slate-500">
            <Text as="p" variant="body" tone="inherit">
              Focus on this folder to browse its contents independently or keep using the space root tree.
            </Text>
            <div className="flex gap-3">
              <Button
                onPress={() => focusDirectory(viewerState.entry?.path ?? "")}
                variant="outline"
                size="sm"
                radius="full"
              >
                Focus here
              </Button>
              {normalizedRootPath ? (
                <Button
                  onPress={() => focusDirectory("")}
                  variant="outline"
                  size="sm"
                  radius="full"
                >
                  Reset to space root
                </Button>
              ) : null}
            </div>
          </div>
        );
      case "error":
        return (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-rose-500">
            {viewerState.error ?? "Something went wrong while opening this file."}
          </div>
        );
      default:
        return (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Select a file to start editing.
          </div>
        );
    }
  }, [focusDirectory, normalizedRootPath, renderTextViewer, viewerState]);

  const viewerPanel = useMemo(
    () => (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {viewerHeader}
        <div className={`flex-1 min-h-0 overflow-hidden bg-white ${DARK_PANEL_BG_CLASS}`}>{viewerBody}</div>
        {viewerState.entry && viewerState.entry.kind === "file" ? (
          <footer className={`border-t border-slate-200/70 px-4 py-2.5 text-xs text-slate-500 ${DARK_DIVIDER_BORDER_CLASS} dark:text-slate-400`}>
            <div className="flex flex-wrap items-center gap-4">
              <span>Size · {formatFileSize(viewerState.entry.size ?? activeFile?.size ?? null)}</span>
              <span>Modified · {formatTimestamp(viewerState.entry.modified ?? activeFile?.modifiedAt ?? null)}</span>
              {viewerState.entry.mimeType ? <span>MIME · {viewerState.entry.mimeType}</span> : null}
            </div>
          </footer>
        ) : null}
      </div>
    ),
    [activeFile, viewerBody, viewerHeader, viewerState.entry]
  );

  useEffect(() => {
    setViewerState((current) => {
      if (!activeFile) {
        return resolveViewerStateWithoutActiveFile(current);
      }
      if (current.mode === "loading" && current.entry?.path === activeFile.path) {
        return current;
      }
      const entryFromDirectory =
        findEntryByPath(directoryEntriesRef.current, activeFile.path) ??
        (current.entry?.path === activeFile.path ? current.entry : null);
      const nextEntry = entryFromDirectory ?? createEntryFromCodeFile(activeFile);
      const shouldUpdate =
        current.mode !== "text" ||
        !current.entry ||
        current.entry.path !== nextEntry.path ||
        current.entry.name !== nextEntry.name ||
        current.entry.size !== nextEntry.size ||
        current.entry.modified !== nextEntry.modified ||
        current.entry.mimeType !== nextEntry.mimeType;
      if (!shouldUpdate) {
        return current;
      }
      return {
        mode: "text",
        entry: nextEntry,
        error: null
      };
    });
  }, [activeFile, directoryEntries, directoryEntriesRef, setViewerState]);

  if (!runtimeControllerEnabled) {
    const message = (
      <Surface
        tone="default"
        radius="2xl"
        shadow="none"
        className="flex h-full flex-col gap-4 p-4 text-sm text-slate-600 dark:text-slate-300"
      >
        <div className="flex items-center justify-end">
          {onRequestCloseExplorer ? (
            <IconButton
              variant="ghost"
              size="xs"
              radius="full"
              aria-label="Close file explorer"
              title="Close"
              data-testid="files-explorer-close"
              onPress={onRequestCloseExplorer}
              className={`h-10 w-10 text-slate-500 hover:bg-slate-200/70 data-[hovered]:bg-slate-200/70 dark:text-slate-400 ${DARK_RAIL_HOVER_CLASS}  lg:h-6 lg:w-6`}
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Text variant="body" tone="subtle" className="max-w-[22rem]">
            Connect the runtime controller to browse space files.
          </Text>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onPress={handleOpenChat} variant="outline" size="sm" radius="full">
              Back to Assistant
            </Button>
          </div>
        </div>
      </Surface>
    );

    if (renderMode === "portal") {
      return showExplorer && explorerPortalTarget && typeof document !== "undefined"
        ? createPortal(message, explorerPortalTarget)
        : null;
    }

    return message;
  }

  if (!activeProjectId) {
    const message = (
      <Surface
        tone="default"
        radius="2xl"
        shadow="none"
        className="flex h-full flex-col gap-4 p-4 text-sm text-slate-600 dark:text-slate-300"
      >
        <div className="flex items-center justify-end">
          {onRequestCloseExplorer ? (
            <IconButton
              variant="ghost"
              size="xs"
              radius="full"
              aria-label="Close file explorer"
              title="Close"
              data-testid="files-explorer-close"
              onPress={onRequestCloseExplorer}
              className={`h-10 w-10 text-slate-500 hover:bg-slate-200/70 data-[hovered]:bg-slate-200/70 dark:text-slate-400 ${DARK_RAIL_HOVER_CLASS}  lg:h-6 lg:w-6`}
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Text variant="body" tone="subtle" className="max-w-[22rem]">
            Select or create a space to view its files.
          </Text>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onPress={handleOpenProjects} variant="primary" size="sm" radius="full">
              Browse spaces
            </Button>
            <Button onPress={handleOpenChat} variant="outline" size="sm" radius="full">
              Back to Assistant
            </Button>
          </div>
        </div>
      </Surface>
    );

    if (renderMode === "portal") {
      return showExplorer && explorerPortalTarget && typeof document !== "undefined"
        ? createPortal(message, explorerPortalTarget)
        : null;
    }

    return message;
  }

  const explorerPortal =
    showExplorer && explorerPortalEnabled && explorerPortalTarget && typeof document !== "undefined"
      ? createPortal(treeContent, explorerPortalTarget)
      : null;

  let mainContent: JSX.Element;
  if (!isLargeScreen) {
    if (!showExplorerInline) {
      mainContent = (
        <div className="flex h-full min-h-0 flex-col">
          {tabsSlot}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex flex-1 min-h-0 overflow-hidden">{viewerPanel}</div>
          </div>
        </div>
      );
    } else {
      mainContent = (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          {mobileView === "tree" ? treeContent : viewerPanel}
        </div>
      );
    }
  } else if (!showExplorerInline) {
    mainContent = (
      <div className="flex h-full min-h-0 flex-col">
        {tabsSlot}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex flex-1 min-h-0 overflow-hidden">{viewerPanel}</div>
        </div>
      </div>
    );
  } else {
    mainContent = (
      <div className="flex h-full min-h-0 overflow-hidden">
        <div className={`w-[260px] flex-shrink-0 border-r border-slate-200/70 bg-slate-50/40 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS} lg:w-[300px] xl:w-[340px]`}>
          {treeContent}
        </div>
        <div className={`flex-1 min-w-0 flex flex-col bg-white ${DARK_PANEL_BG_CLASS}`}>
          {tabsSlot}
          <div className="flex-1 min-h-0 flex flex-col">{viewerPanel}</div>
        </div>
      </div>
    );
  }

  if (renderMode === "portal") {
    return explorerPortal;
  }

  return (
    <>
      {explorerPortal}
      {mainContent}
    </>
  );
}

function updateEntryMetadata(
  map: DirectoryEntries,
  path: string,
  metadata: Partial<Pick<ControllerWorkspaceEntry, "size" | "modified">>
): DirectoryEntries {
  const parent = getParentPath(path) ?? "";
  const entries = map[parent];
  if (!entries) {
    return map;
  }
  return {
    ...map,
    [parent]: entries.map((entry) =>
      entry.path === path
        ? {
            ...entry,
            size: metadata.size ?? entry.size,
            modified: metadata.modified ?? entry.modified
          }
        : entry
    )
  };
}

function findEntryByPath(map: DirectoryEntries, path: string): ControllerWorkspaceEntry | null {
  const normalized = normalizePath(path);
  const entries = map[getParentPath(normalized) ?? ""];
  if (!entries) {
    return null;
  }
  return entries.find((entry) => normalizePath(entry.path) === normalized) ?? null;
}
