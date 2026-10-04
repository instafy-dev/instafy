import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type SetStateAction } from "react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { controllerClient, type ControllerWorkspaceEntry } from "../../../sdk/instafy";
import {
  addFloatingSurfaceViewportChangeListener,
  clampFloatingSurfacePositionToStudioViewport,
} from "../../../utils/floatingSurfacePosition";
import { raiseWorkspaceFileStaleNotice } from "./workspaceFileStaleNoticeStore";
import type { OpenTextFileOptions, ViewerState } from "./useFilesPanelViewerState";
import type { StudioDirectoryListingListener } from "../useStudioKnownFiles";
import type { CodeFile } from "../../../types";
import {
  advanceListingRevisions,
  EMPTY_DIRECTORY_PLACEHOLDER,
  isVersionedFilesMode,
  LEGACY_FILES_VERSIONING,
  type FilesVersioning,
  type OwnRevisions,
} from "./filesVersioning";
import { describeSaveFailure, SAVE_COPY, type SaveCopy } from "./workspaceSaveCopy";

const runtimeControllerEnabled = controllerClient.core.enabled;

export type DirectoryEntries = Record<string, ControllerWorkspaceEntry[]>;
export type DirectoryStatus = Record<string, "idle" | "loading" | "error">;

export type ExplorerDeleteEntry = {
  path: string;
  kind: "file" | "directory";
  name: string;
};

export type ExplorerMenuState = {
  x: number;
  y: number;
  maxHeight: number;
  targetPath: string;
  deleteEntry: ExplorerDeleteEntry | null;
} | null;

type ViewerActionHandlers = {
  openImageFile: (entry: ControllerWorkspaceEntry) => Promise<void>;
  openTextFile: (
    entry: ControllerWorkspaceEntry,
    options?: OpenTextFileOptions,
  ) => Promise<void>;
  openUnsupportedFile: (entry: ControllerWorkspaceEntry) => Promise<void>;
};

/** Versioned-mode wiring; absent in legacy mode. */
export type FilesTreeVersionedOptions = {
  /** Revisions this tab wrote; their commit events are not reloads. */
  ownRevisions: OwnRevisions;
  /** The open buffer for a path, if any. */
  getBuffer: (path: string) => CodeFile | null;
  /** Drop buffers at or under a deleted path. */
  discardBuffers: (path: string) => void;
  /** Origin reachable and the member may write. */
  writeReady: boolean;
  /** Present a failed write with its copy and action. */
  onWriteFailure: (copy: SaveCopy, retry: () => void) => void;
};

type UseFilesPanelWorkspaceTreeParams = {
  activeFilePath: string | null;
  activeFileDraftRef: RefObject<{ fileId: string | null; value: string | null }>;
  activeFileGeneratedRef: RefObject<{ fileId: string | null; value: string | null }>;
  activeFilePathRef: RefObject<string | null>;
  activeProjectId: string | null;
  dirtyFileIdsRef: RefObject<Set<string>>;
  effectiveRuntimeId: string | null;
  getActiveEditorValue: () => string | null;
  getParentPath: (path: string) => string | null;
  isImageEntry: (entry: ControllerWorkspaceEntry) => boolean;
  isLikelyTextEntry: (entry: ControllerWorkspaceEntry) => boolean;
  isSafeWorkspaceRelativePath: (path: string) => boolean;
  lastLocalCommitRef: RefObject<{ rev: string; at: number } | null>;
  normalizedRootPath: string;
  normalizePath: (path: string) => string;
  runtimeReady: boolean;
  setActiveFile: (fileId: string | null) => void;
  showStatus: (
    message: string,
    intent: "success" | "error" | "warning" | "info",
    durationMs?: number,
  ) => void;
  sortEntries: (entries: ControllerWorkspaceEntry[]) => ControllerWorkspaceEntry[];
  viewerActionsRef: RefObject<ViewerActionHandlers | null>;
  viewerStateRef: RefObject<ViewerState>;
  setViewerStateRef: RefObject<(nextState: SetStateAction<ViewerState>) => void>;
  waitingForPreferredRuntime: boolean;
  workspaceBrowseReady: boolean;
  workspaceOwnerId?: string | null;
  workspaceOwnerKey?: string;
  onDirectoryEntriesLoaded?: StudioDirectoryListingListener;
  readOnly?: boolean;
  /** Legacy unless the default origin keeps every save as a version. */
  versioning?: FilesVersioning;
  versionedOptions?: FilesTreeVersionedOptions | null;
};

export type LoadDirectoryOptions = {
  force?: boolean;
  syncMode?: "background" | "blocking";
  signal?: AbortSignal;
  /** Versioned modes: list at this commit (retried unpinned when unknown). */
  rev?: string | null;
};

type LoadDirectory = (
  path: string,
  options?: LoadDirectoryOptions,
) => Promise<ControllerWorkspaceEntry[] | null>;

type RefreshFromWorkspaceCommit = (
  projectIdFromEvent: string | null | undefined,
  options?: { forceSync?: boolean; rev?: string | null },
) => Promise<void>;

function clampExplorerMenuPosition(clientX: number, clientY: number) {
  return clampFloatingSurfacePositionToStudioViewport({
    clientX,
    clientY,
    surfaceWidth: 240,
    surfaceHeight: 240,
    padding: 12,
  });
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

export function useFilesPanelWorkspaceTree({
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
  viewerStateRef,
  setViewerStateRef,
  waitingForPreferredRuntime,
  workspaceBrowseReady,
  workspaceOwnerId,
  workspaceOwnerKey,
  onDirectoryEntriesLoaded,
  readOnly = false,
  versioning = LEGACY_FILES_VERSIONING,
  versionedOptions = null,
}: UseFilesPanelWorkspaceTreeParams) {
  const versioned = isVersionedFilesMode(versioning) && versionedOptions !== null;
  const versionedMode = versioned ? versioning.mode : "legacy";
  const pinnedOriginId = versioned ? versioning.originId : null;
  const versionedOptionsRef = useRef(versionedOptions);
  versionedOptionsRef.current = versionedOptions;
  /** `X-Instafy-Rev` of each folder's last listing (versioned modes). */
  const directoryRevsRef = useRef<Record<string, string | null>>({});
  /** Folders whose listing holds the empty-folder placeholder. */
  const keepFoldersRef = useRef<Set<string>>(new Set());
  const [directoryEntries, setDirectoryEntries] = useState<DirectoryEntries>({});
  const directoryEntriesRef = useRef<DirectoryEntries>({});
  const [directoryStatus, setDirectoryStatus] = useState<DirectoryStatus>({});
  const directoryStatusRef = useRef<DirectoryStatus>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const expandedDirectoriesRef = useRef<Set<string>>(new Set());
  const lastExplorerSelectionRef = useRef<ControllerWorkspaceEntry | null>(null);
  const directoryAttemptsRef = useRef<Record<string, number>>({});
  const directoryRequestsRef = useRef(new Map<string, object>());
  const previousRuntimeReadyRef = useRef(runtimeReady);
  const previousWorkspaceBrowseReadyRef = useRef(false);
  const pendingWorkspaceRefreshTimerRef = useRef<number | null>(null);
  const pendingWorkspaceRefreshProjectRef = useRef<string | null>(null);
  const pendingWorkspaceRefreshForceSyncRef = useRef(false);
  const lastWorkspaceFileStaleNoticeRef = useRef<{ path: string; at: number } | null>(null);
  const [explorerMenu, setExplorerMenu] = useState<ExplorerMenuState>(null);
  const explorerMenuRef = useRef<HTMLDivElement | null>(null);
  const requestScope = useMemo(() => ({ activeProjectId, effectiveRuntimeId, workspaceOwnerId, workspaceOwnerKey,
    onDirectoryEntriesLoaded, versionedMode, pinnedOriginId }), [activeProjectId, effectiveRuntimeId,
    workspaceOwnerId, workspaceOwnerKey, onDirectoryEntriesLoaded, versionedMode, pinnedOriginId]);
  const requestScopeRef = useRef(requestScope);
  requestScopeRef.current = requestScope;
  const lifetimeRef = useRef({ active: true, scope: requestScope });

  useEffect(() => {
    directoryEntriesRef.current = directoryEntries;
  }, [directoryEntries]);

  useEffect(() => {
    directoryStatusRef.current = directoryStatus;
  }, [directoryStatus]);

  useEffect(() => {
    const lifetime = { active: true, scope: requestScope };
    lifetimeRef.current = lifetime;
    directoryEntriesRef.current = {};
    directoryStatusRef.current = {};
    directoryAttemptsRef.current = {};
    directoryRevsRef.current = {};
    keepFoldersRef.current = new Set();
    directoryRequestsRef.current.clear();
    setDirectoryEntries({});
    setDirectoryStatus({});
    return () => { lifetime.active = false; };
  }, [requestScope]);

  useEffect(() => {
    expandedDirectoriesRef.current = expandedDirectories;
  }, [expandedDirectories]);

  useEffect(() => {
    if (!explorerMenu) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (explorerMenuRef.current?.contains(target)) {
        return;
      }
      setExplorerMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExplorerMenu(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    const removeViewportChangeListener = addFloatingSurfaceViewportChangeListener(() => {
      setExplorerMenu(null);
    });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      removeViewportChangeListener();
    };
  }, [explorerMenu]);

  const loadDirectory = useCallback<LoadDirectory>(
    async (
      path: string,
      options?: LoadDirectoryOptions,
    ): Promise<ControllerWorkspaceEntry[] | null> => {
      const lifetime = lifetimeRef.current;
      const isOwnerCurrent = () => lifetime.active && lifetimeRef.current === lifetime
        && lifetime.scope === requestScope && requestScopeRef.current === requestScope;
      if (!activeProjectId || !runtimeControllerEnabled || !isOwnerCurrent() || options?.signal?.aborted) {
        return null;
      }

      const normalizedPath = normalizePath(path);
      const existing = directoryEntriesRef.current[normalizedPath];
      const status = directoryStatusRef.current[normalizedPath];

      if (!options?.force && (existing || status === "loading")) {
        return existing ?? null;
      }

      if (!workspaceBrowseReady && !options?.force) {
        return existing ?? null;
      }

      const request = {};
      directoryRequestsRef.current.set(normalizedPath, request);
      const ownsRequest = () => isOwnerCurrent() && directoryRequestsRef.current.get(normalizedPath) === request;
      const isCurrent = () => ownsRequest() && !options?.signal?.aborted;
      const cancelRequest = () => {
        if (!ownsRequest()) return;
        directoryRequestsRef.current.delete(normalizedPath);
        directoryStatusRef.current = { ...directoryStatusRef.current, [normalizedPath]: "idle" };
        setDirectoryStatus((previous) => isOwnerCurrent() ? { ...previous, [normalizedPath]: "idle" } : previous);
      };
      options?.signal?.addEventListener("abort", cancelRequest, { once: true });
      const removeAbortListener = () => options?.signal?.removeEventListener("abort", cancelRequest);

      setDirectoryStatus((prev) => ({
        ...prev,
        [normalizedPath]: "loading",
      }));

      let entries: ControllerWorkspaceEntry[] | null = null;
      let listingRev: string | null = null;
      try {
        if (versioned) {
          // Pinned to the default origin, never `sync=blocking`; a commit
          // that the origin does not know yet is listed unpinned instead.
          const listAt = (rev: string | null) =>
            controllerClient.workspace.files.listAt({
              projectId: activeProjectId,
              path: normalizedPath.length > 0 ? normalizedPath : undefined,
              routing: "default",
              originId: pinnedOriginId,
              ...(rev ? { rev } : {}),
            });
          const pinned = options?.rev?.trim() || null;
          let listing = await listAt(pinned);
          if (pinned && listing && !listing.ok && listing.error.code === "rev_not_found" && isCurrent()) {
            listing = await listAt(null);
          }
          if (listing?.ok) {
            entries = listing.entries;
            listingRev = listing.rev;
          }
        } else {
          entries = await controllerClient.workspace.files.list({
            projectId: activeProjectId,
            path: normalizedPath.length > 0 ? normalizedPath : undefined,
            runtimeId: effectiveRuntimeId ?? null,
            syncMode: options?.syncMode ?? (options?.force ? "blocking" : undefined),
          });
        }
      } catch (error) {
        if (!isCurrent()) { removeAbortListener(); return null; }
        console.warn("[files-panel] directory load failed:", error);
        entries = null;
      }

      if (!isCurrent()) {
        removeAbortListener();
        // Another browse of the same directory may publish first. The original
        // caller can still reveal its file while its workspace/request is valid.
        return isOwnerCurrent() && !options?.signal?.aborted && entries
          ? sortEntries(entries.filter((entry) => !(entry.kind === "file" && entry.name === ".instafy.keep"))) : null;
      }

      if (!entries) {
        const attempts = (directoryAttemptsRef.current[normalizedPath] ?? 0) + 1;
        directoryAttemptsRef.current[normalizedPath] = attempts;
        const delays = [500, 1500, 4000, 8000, 12000, 16000];
        const delay = delays[Math.min(attempts - 1, delays.length - 1)];

        if (attempts < delays.length + 1) {
          setDirectoryStatus((prev) => ({
            ...prev,
            [normalizedPath]: "loading",
          }));
          window.setTimeout(() => {
            removeAbortListener();
            if (isCurrent()) void loadDirectory(normalizedPath, { force: true, signal: options?.signal });
          }, delay);
          return null;
        }

        setDirectoryStatus((prev) => ({
          ...prev,
          [normalizedPath]: "error",
        }));
        removeAbortListener();
        return null;
      }

      const filtered = entries.filter(
        (entry) => !(entry.kind === "file" && entry.name === ".instafy.keep"),
      );
      const sorted = sortEntries(filtered);
      delete directoryAttemptsRef.current[normalizedPath];
      if (versioned) {
        directoryRevsRef.current = { ...directoryRevsRef.current, [normalizedPath]: listingRev };
        if (entries.some((entry) => entry.kind === "file" && entry.name === EMPTY_DIRECTORY_PLACEHOLDER)) {
          keepFoldersRef.current.add(normalizedPath);
        } else {
          keepFoldersRef.current.delete(normalizedPath);
        }
      }
      setDirectoryEntries((prev) => ({
        ...prev,
        [normalizedPath]: sorted,
      }));
      setDirectoryStatus((prev) => ({
        ...prev,
        [normalizedPath]: "idle",
      }));
      onDirectoryEntriesLoaded?.({ projectId: activeProjectId, directory: normalizedPath, entries: sorted });
      removeAbortListener();
      return sorted;
    },
    [activeProjectId, effectiveRuntimeId, normalizePath, onDirectoryEntriesLoaded, pinnedOriginId, requestScope, sortEntries,
      versioned, workspaceBrowseReady],
  );

  useEffect(() => {
    if (!activeProjectId || !runtimeControllerEnabled) {
      return;
    }
    void loadDirectory(normalizedRootPath, { force: true }).catch((error) => {
      console.warn("[files-panel] failed to load directory:", error);
    });
  }, [activeProjectId, loadDirectory, normalizedRootPath]);

  useEffect(() => {
    const wasRuntimeReady = previousRuntimeReadyRef.current;
    previousRuntimeReadyRef.current = runtimeReady;
    if (!activeProjectId || !runtimeControllerEnabled) {
      return;
    }
    if (!runtimeReady || wasRuntimeReady) {
      return;
    }
    void loadDirectory(normalizedRootPath, {
      force: true,
      syncMode: "blocking",
    }).catch((error) => {
      console.warn("[files-panel] failed to reload root directory after runtime recovery:", error);
    });
  }, [activeProjectId, loadDirectory, normalizedRootPath, runtimeReady]);

  useEffect(() => {
    const wasWorkspaceBrowseReady = previousWorkspaceBrowseReadyRef.current;
    previousWorkspaceBrowseReadyRef.current = workspaceBrowseReady;
    if (!activeProjectId || !runtimeControllerEnabled) {
      return;
    }
    if (!workspaceBrowseReady || wasWorkspaceBrowseReady) {
      return;
    }
    void loadDirectory(normalizedRootPath, {
      force: true,
      syncMode: "blocking",
    }).catch((error) => {
      console.warn("[files-panel] failed to reload root directory after origin recovery:", error);
    });
  }, [activeProjectId, loadDirectory, normalizedRootPath, workspaceBrowseReady]);

  useEffect(() => {
    const targetPath = normalizePath(activeFilePath ?? "");
    if (!targetPath) {
      return;
    }
    if (
      normalizedRootPath &&
      targetPath !== normalizedRootPath &&
      !targetPath.startsWith(`${normalizedRootPath}/`)
    ) {
      return;
    }

    const relative = normalizedRootPath
      ? targetPath.slice(normalizedRootPath.length).replace(/^\/+/, "")
      : targetPath;
    if (!relative) {
      return;
    }

    const segments = relative.split("/").filter(Boolean);
    if (segments.length === 0) {
      return;
    }

    setDirectoryEntries((prev) => {
      let next = prev;
      let didChange = false;
      let parentKey = normalizedRootPath;
      let cursor = normalizedRootPath;

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        cursor = cursor ? `${cursor}/${segment}` : segment;
        const isLeaf = index === segments.length - 1;
        const entry = {
          name: segment,
          path: cursor,
          kind: isLeaf ? "file" : "directory",
        } satisfies ControllerWorkspaceEntry;

        const existing = next[parentKey] ?? [];
        if (!existing.some((candidate) => normalizePath(candidate.path) === cursor)) {
          if (!didChange) {
            next = { ...next };
            didChange = true;
          }
          next[parentKey] = sortEntries([...existing, entry]);
        }

        if (!isLeaf) {
          parentKey = cursor;
        }
      }

      return didChange ? next : prev;
    });

    setExpandedDirectories((prev) => {
      let next = prev;
      let didChange = false;
      let cursor = normalizedRootPath;

      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        cursor = cursor ? `${cursor}/${segment}` : segment;
        if (!next.has(cursor)) {
          if (!didChange) {
            next = new Set(prev);
            didChange = true;
          }
          next.add(cursor);
        }
      }

      return didChange ? next : prev;
    });
  }, [activeFilePath, normalizedRootPath, normalizePath, sortEntries]);

  const notifyStaleViewerEntry = useCallback(
    (entry: ControllerWorkspaceEntry, originId?: string | null) => {
      if (!activeProjectId || typeof window === "undefined") {
        return;
      }
      const now = Date.now();
      const lastNotice = lastWorkspaceFileStaleNoticeRef.current;
      const shouldNotify =
        !lastNotice || lastNotice.path !== entry.path || now - lastNotice.at > 2500;
      if (!shouldNotify) {
        return;
      }
      lastWorkspaceFileStaleNoticeRef.current = { path: entry.path, at: now };

      const fileLabel = entry.name ?? entry.path.split("/").pop() ?? entry.path;
      const baseText =
        activeFileGeneratedRef.current.fileId === entry.path &&
        typeof activeFileGeneratedRef.current.value === "string"
          ? activeFileGeneratedRef.current.value
          : "";
      const localText = (() => {
        const fromEditor = getActiveEditorValue();
        if (typeof fromEditor === "string") {
          return fromEditor;
        }
        if (
          activeFileDraftRef.current.fileId === entry.path &&
          typeof activeFileDraftRef.current.value === "string"
        ) {
          return activeFileDraftRef.current.value;
        }
        return baseText;
      })();

      raiseWorkspaceFileStaleNotice({
        projectId: activeProjectId,
        path: entry.path,
        label: fileLabel,
        baseText,
        localText,
        detectedAt: now,
        ...(originId !== undefined ? { originId } : {}),
      });
    },
    [activeProjectId, activeFileDraftRef, activeFileGeneratedRef, getActiveEditorValue],
  );

  const refreshViewerEntryFromWorkspace = useCallback(
    async (entry: ControllerWorkspaceEntry, rev?: string | null) => {
      const viewerActions = viewerActionsRef.current;
      if (!viewerActions || !activeProjectId) {
        return;
      }

      if (isImageEntry(entry)) {
        await viewerActions.openImageFile(entry);
        return;
      }

      if (!isLikelyTextEntry(entry)) {
        await viewerActions.openUnsupportedFile(entry);
        return;
      }

      const versionedHooks = versioned ? versionedOptionsRef.current : null;
      if (versionedHooks) {
        // Compare the open buffer with the new listing: the same blob needs
        // nothing; a changed file is read again at the event's commit when
        // clean, and reported when it has unsaved edits.
        const buffer = versionedHooks.getBuffer(entry.path);
        if (buffer?.isNew === true) {
          return;
        }
        if (buffer?.blobOid && entry.blobOid && buffer.blobOid === entry.blobOid) {
          return;
        }
        if (versionedHooks.ownRevisions.hasWrite(entry.path, entry.blobOid)) {
          // This tab's own save, listed before its response arrived: the
          // save updates the buffer itself.
          return;
        }
        if (dirtyFileIdsRef.current.has(entry.path)) {
          notifyStaleViewerEntry(entry, buffer?.originId ?? null);
          return;
        }
        await viewerActions.openTextFile(entry, { forceFetch: true, rev: rev ?? null });
        return;
      }

      if (dirtyFileIdsRef.current.has(entry.path)) {
        notifyStaleViewerEntry(entry);
        return;
      }

      await viewerActions.openTextFile(entry, { forceFetch: true });
    },
    [
      activeProjectId,
      dirtyFileIdsRef,
      isImageEntry,
      isLikelyTextEntry,
      notifyStaleViewerEntry,
      versioned,
      viewerActionsRef,
    ],
  );

  const refreshFromWorkspaceCommit = useCallback<RefreshFromWorkspaceCommit>(
    async (
      projectIdFromEvent: string | null | undefined,
      options?: { forceSync?: boolean; rev?: string | null },
    ) => {
      if (!runtimeControllerEnabled || !activeProjectId) {
        return;
      }
      if (projectIdFromEvent && projectIdFromEvent !== activeProjectId) {
        return;
      }

      const pathsToRefresh = new Set<string>([normalizedRootPath]);
      expandedDirectoriesRef.current.forEach((path) => {
        if (path) {
          pathsToRefresh.add(path);
        }
      });

      let viewerRev: string | null = null;
      if (versioned) {
        // Every listing is read at one commit: the event's, or (for a manual
        // refresh) whatever the root listing was served from.
        const reload = (path: string, rev: string | null) =>
          loadDirectory(path, { force: true, ...(rev ? { rev } : {}) }).catch((error) => {
            console.warn("[files-panel] failed to refresh directory", path, error);
          });
        let rev = options?.rev?.trim() || null;
        const others = Array.from(pathsToRefresh).filter((path) => path !== normalizedRootPath);
        if (rev) {
          await Promise.all(Array.from(pathsToRefresh).map((path) => reload(path, rev)));
        } else {
          await reload(normalizedRootPath, null);
          rev = directoryRevsRef.current[normalizedRootPath] ?? null;
          await Promise.all(others.map((path) => reload(path, rev)));
        }
        viewerRev = rev;
      } else {
        await Promise.all(
          Array.from(pathsToRefresh).map((path) =>
            loadDirectory(path, {
              force: true,
              syncMode: options?.forceSync ? "blocking" : undefined,
            }).catch((error) => {
              console.warn("[files-panel] failed to refresh directory", path, error);
            }),
          ),
        );
      }

      const currentViewer = viewerStateRef.current;
      if (!currentViewer?.entry) {
        return;
      }

      const latestEntry =
        findEntryByPath(
          directoryEntriesRef.current,
          currentViewer.entry.path,
          getParentPath,
          normalizePath,
        ) ?? currentViewer.entry;

      if (latestEntry.kind === "file") {
        try {
          await refreshViewerEntryFromWorkspace(latestEntry, viewerRev);
        } catch (error) {
          console.warn("[files-panel] failed to refresh viewer after commit", error);
        }
      }
    },
    [
      activeProjectId,
      getParentPath,
      loadDirectory,
      normalizePath,
      normalizedRootPath,
      refreshViewerEntryFromWorkspace,
      versioned,
      viewerStateRef,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined" || !runtimeControllerEnabled) {
      return;
    }

    const clearPendingWorkspaceRefresh = () => {
      if (pendingWorkspaceRefreshTimerRef.current !== null) {
        window.clearTimeout(pendingWorkspaceRefreshTimerRef.current);
        pendingWorkspaceRefreshTimerRef.current = null;
      }
      pendingWorkspaceRefreshProjectRef.current = null;
      pendingWorkspaceRefreshForceSyncRef.current = false;
    };

    const scheduleWorkspaceRefresh = (
      projectIdFromEvent: string | null,
      options?: { forceSync?: boolean },
    ) => {
      pendingWorkspaceRefreshProjectRef.current = projectIdFromEvent;
      pendingWorkspaceRefreshForceSyncRef.current =
        pendingWorkspaceRefreshForceSyncRef.current || options?.forceSync === true;
      if (pendingWorkspaceRefreshTimerRef.current !== null) {
        window.clearTimeout(pendingWorkspaceRefreshTimerRef.current);
      }
      pendingWorkspaceRefreshTimerRef.current = window.setTimeout(() => {
        const pendingProjectId = pendingWorkspaceRefreshProjectRef.current;
        const shouldForceSync = pendingWorkspaceRefreshForceSyncRef.current;
        clearPendingWorkspaceRefresh();
        void refreshFromWorkspaceCommit(pendingProjectId, { forceSync: shouldForceSync });
      }, 350);
    };

    const commitHandler = (event: Event) => {
      const custom = event as CustomEvent<{ projectId?: string | null; data?: unknown }>;
      const projectIdFromEvent =
        custom.detail && typeof custom.detail.projectId === "string"
          ? custom.detail.projectId
          : null;
      const commitData = custom.detail?.data;
      const commitRev =
        commitData &&
        typeof commitData === "object" &&
        typeof (commitData as { rev?: unknown }).rev === "string"
          ? (commitData as { rev: string }).rev.trim()
          : null;

      if (versioned) {
        // This tab's own saves are already on screen; anything else is read
        // at the event's commit.
        if (commitRev && versionedOptionsRef.current?.ownRevisions.has(commitRev)) {
          return;
        }
        clearPendingWorkspaceRefresh();
        void refreshFromWorkspaceCommit(projectIdFromEvent, { rev: commitRev });
        return;
      }

      const lastLocalCommit = lastLocalCommitRef.current;
      if (lastLocalCommit) {
        const ageMs = Date.now() - lastLocalCommit.at;
        if (ageMs > 30_000) {
          lastLocalCommitRef.current = null;
        } else if (commitRev && commitRev === lastLocalCommit.rev) {
          lastLocalCommitRef.current = null;
          return;
        }
      }
      clearPendingWorkspaceRefresh();
      void refreshFromWorkspaceCommit(projectIdFromEvent, { forceSync: true });
    };

    const workspaceChangeHandler = (event: Event) => {
      const custom = event as CustomEvent<{
        projectId?: string | null;
        kind?: string | null;
      }>;
      const eventKind = typeof custom.detail?.kind === "string" ? custom.detail.kind : null;
      if (eventKind && eventKind !== "workspace.file_changed") {
        return;
      }
      const projectIdFromEvent =
        custom.detail && typeof custom.detail.projectId === "string"
          ? custom.detail.projectId
          : null;
      scheduleWorkspaceRefresh(projectIdFromEvent, { forceSync: true });
    };

    window.addEventListener("instafy:workspace-commit", commitHandler as EventListener);
    window.addEventListener("instafy:workspace-change", workspaceChangeHandler as EventListener);
    return () => {
      clearPendingWorkspaceRefresh();
      window.removeEventListener("instafy:workspace-commit", commitHandler as EventListener);
      window.removeEventListener("instafy:workspace-change", workspaceChangeHandler as EventListener);
    };
  }, [lastLocalCommitRef, refreshFromWorkspaceCommit, versioned]);

  const openExplorerMenu = useCallback(
    (params: {
      targetPath: string;
      clientX: number;
      clientY: number;
      deleteEntry?: ExplorerDeleteEntry | null;
    }) => {
      const { x, y, maxHeight } = clampExplorerMenuPosition(params.clientX, params.clientY);
      setExplorerMenu({
        x,
        y,
        maxHeight,
        targetPath: normalizePath(params.targetPath),
        deleteEntry: params.deleteEntry ?? null,
      });
    },
    [normalizePath],
  );

  const handleEntryContextMenu = useCallback(
    (entry: ControllerWorkspaceEntry, clientX: number, clientY: number) => {
      const targetPath =
        entry.kind === "directory" ? normalizePath(entry.path) : getParentPath(entry.path) ?? "";
      if (entry.kind !== "file" && entry.kind !== "directory") {
        openExplorerMenu({ targetPath, clientX, clientY, deleteEntry: null });
        return;
      }
      openExplorerMenu({
        targetPath,
        clientX,
        clientY,
        deleteEntry: {
          path: entry.path,
          kind: entry.kind,
          name: entry.name ?? entry.path,
        },
      });
    },
    [getParentPath, normalizePath, openExplorerMenu],
  );

  /**
   * Versioned-mode delete: one manifest pinned to the default origin. On the
   * stateless gateway it carries the parent listing's rev as `baseRev` (a
   * directory delete needs it) and, for a file, the listed blob as
   * `expected`. A buffer that was never saved is only dropped locally.
   * Returns false when nothing was deleted (the failure is already shown).
   */
  const deleteVersionedEntry = useCallback(
    async (
      entry: ExplorerDeleteEntry,
      normalizedPath: string,
      hooks: FilesTreeVersionedOptions,
    ): Promise<boolean> => {
      if (!activeProjectId) {
        return false;
      }
      if (entry.kind === "file" && hooks.getBuffer(normalizedPath)?.isNew === true) {
        hooks.discardBuffers(normalizedPath);
        return true;
      }
      const parentPath = getParentPath(normalizedPath) ?? "";
      let baseRev = directoryRevsRef.current[parentPath] ?? null;
      if (versionedMode === "stateless" && !baseRev) {
        await loadDirectory(parentPath, { force: true });
        baseRev = directoryRevsRef.current[parentPath] ?? null;
      }
      if (versionedMode === "stateless" && !baseRev) {
        hooks.onWriteFailure({ message: SAVE_COPY.deleteRequiresBaseRev }, () => undefined);
        return false;
      }
      const listed = findEntryByPath(directoryEntriesRef.current, normalizedPath, getParentPath, normalizePath);
      const expected =
        entry.kind === "file" && listed?.blobOid ? { [normalizedPath]: listed.blobOid } : null;
      const result = await controllerClient.workspace.save.changes({
        projectId: activeProjectId,
        originId: pinnedOriginId,
        deletes: [normalizedPath],
        ...(versionedMode === "stateless" && baseRev ? { baseRev } : {}),
        ...(expected ? { expected } : {}),
      });
      if (!result.ok) {
        const copy = describeSaveFailure({
          error: result.error,
          mode: versionedMode,
          label: entry.name,
          operation: "delete",
        });
        hooks.onWriteFailure(copy, () => {
          void handleDeleteExplorerEntryRef.current?.(entry, { confirmed: true });
        });
        return false;
      }
      hooks.ownRevisions.add(result.rev);
      if (versionedMode === "stateless") {
        directoryRevsRef.current = advanceListingRevisions(directoryRevsRef.current, result.baseRev, result.rev);
      }
      hooks.discardBuffers(normalizedPath);
      if (entry.kind === "directory") {
        for (const folder of Array.from(keepFoldersRef.current)) {
          if (folder === normalizedPath || folder.startsWith(`${normalizedPath}/`)) {
            keepFoldersRef.current.delete(folder);
          }
        }
      }
      return true;
    },
    [activeProjectId, getParentPath, loadDirectory, normalizePath, pinnedOriginId, versionedMode],
  );
  const handleDeleteExplorerEntryRef = useRef<
    ((entry: ExplorerDeleteEntry, options?: { confirmed?: boolean }) => Promise<void>) | null
  >(null);

  const handleDeleteExplorerEntry = useCallback(
    async (entry: ExplorerDeleteEntry, options?: { confirmed?: boolean }) => {
      const versionedHooks = versioned ? versionedOptionsRef.current : null;
      const writeReady = versionedHooks ? versionedHooks.writeReady : runtimeReady;
      if (readOnly || !activeProjectId || !writeReady) {
        return;
      }
      const normalizedPath = normalizePath(entry.path);
      if (!normalizedPath) {
        showStatus("Cannot delete the space root.", "warning", 3500);
        return;
      }
      if (!isSafeWorkspaceRelativePath(normalizedPath)) {
        showStatus("Cannot delete an unsafe path.", "warning", 3500);
        return;
      }
      if (typeof window !== "undefined" && options?.confirmed !== true) {
        const label = entry.kind === "directory" ? "folder" : "file";
        const confirmed = window.confirm(`Delete ${label} “${entry.name}”?`);
        if (!confirmed) {
          return;
        }
      }

      try {
        if (versionedHooks) {
          const deleted = await deleteVersionedEntry(entry, normalizedPath, versionedHooks);
          if (!deleted) {
            return;
          }
        } else {
          const response = await controllerClient.workspace.files.delete({
            projectId: activeProjectId,
            path: normalizedPath,
            recursive: entry.kind === "directory",
            runtimeId: effectiveRuntimeId ?? null,
          });
          if (!response?.ok) {
            throw new Error("Unable to delete entry.");
          }
          if (typeof response.rev === "string" && response.rev.trim().length > 0) {
            lastLocalCommitRef.current = { rev: response.rev.trim(), at: Date.now() };
          }
        }

        if (activeFilePathRef.current === entry.path) {
          setActiveFile(null);
          setViewerStateRef.current({ mode: "idle", entry: null, error: null });
        } else {
          setViewerStateRef.current((current) => {
            const currentPath = current.entry?.path;
            if (!currentPath) {
              return current;
            }
            if (
              normalizePath(currentPath) === normalizedPath ||
              normalizePath(currentPath).startsWith(`${normalizedPath}/`)
            ) {
              return { mode: "idle", entry: null, error: null };
            }
            return current;
          });
        }

        setExpandedDirectories((prev) => {
          const next = new Set(prev);
          for (const expanded of next) {
            if (expanded === normalizedPath || expanded.startsWith(`${normalizedPath}/`)) {
              next.delete(expanded);
            }
          }
          return next;
        });

        const parentPath = getParentPath(normalizedPath) ?? "";
        await loadDirectory(parentPath, { force: true });
        showStatus(entry.kind === "directory" ? "Folder deleted." : "File deleted.", "success", 2000);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to delete entry.";
        showStatus(message, "error", 4000);
      }
    },
    [
      activeFilePathRef,
      activeProjectId,
      deleteVersionedEntry,
      effectiveRuntimeId,
      getParentPath,
      isSafeWorkspaceRelativePath,
      lastLocalCommitRef,
      loadDirectory,
      normalizePath,
      readOnly,
      runtimeReady,
      setActiveFile,
      setViewerStateRef,
      showStatus,
      versioned,
    ],
  );

  handleDeleteExplorerEntryRef.current = handleDeleteExplorerEntry;

  // Pressing a folder row flips its disclosure at once and its listing
  // follows. A folder that was never listed is loaded even before the
  // workspace reports ready (as Focus does), so an expanded folder never
  // waits silently on a listing that was skipped or is still retrying.
  const toggleDirectory = useCallback(
    (entry: ControllerWorkspaceEntry) => {
      if (entry.kind !== "directory") {
        return;
      }
      const normalized = normalizePath(entry.path);
      const expanding = !expandedDirectories.has(normalized);
      setExpandedDirectories((prev) => {
        const next = new Set(prev);
        if (expanding) {
          next.add(normalized);
        } else {
          next.delete(normalized);
        }
        return next;
      });
      if (expanding && !directoryEntriesRef.current[normalized]) {
        void loadDirectory(normalized, { force: true, syncMode: "background" });
      }
      setViewerStateRef.current((current) => ({ ...current, entry, mode: "directory", error: null }));
      setActiveFile(null);
    },
    [expandedDirectories, loadDirectory, normalizePath, setActiveFile, setViewerStateRef],
  );

  // One source for the explorer's loading copy, in words a non-technical
  // person can read: the connection details stay in logs.
  const getDirectoryLoadingLabel = useCallback(
    (path: string): string => {
      if (!workspaceBrowseReady) {
        if (waitingForPreferredRuntime) {
          return "Waiting for your chosen machine…";
        }
        return (directoryEntries[path] ?? []).length > 0 ? "Reconnecting to your files…" : "Opening files…";
      }
      return (directoryAttemptsRef.current[path] ?? 0) > 0 ? "Still opening files…" : "Loading files…";
    },
    [directoryEntries, waitingForPreferredRuntime, workspaceBrowseReady],
  );

  // A folder's own state comes first: a listing that gave up says so even
  // while the workspace is still connecting. Without a load in flight, only
  // the root waits on the connection, because it is listed again once the
  // workspace is ready; any other folder would wait on nothing.
  const renderDirectoryStatus = useCallback(
    (path: string): ReactNode => {
      const status = directoryStatus[path];
      if (status === "error") {
        const isRoot = path === normalizedRootPath;
        const folderName = path.split("/").filter(Boolean).pop() ?? path;
        return (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500 dark:text-slate-400">
            {isRoot ? "Couldn't open your files." : "Couldn't open this folder."}
            <Button
              onPress={() => void loadDirectory(path, { force: true })}
              aria-label={isRoot ? "Retry opening your files" : `Retry opening ${folderName}`}
              variant="ghost"
              size="xs"
              radius="full"
              className="px-0 text-rose-500 hover:bg-transparent hover:underline data-[hovered]:bg-transparent"
            >
              Retry
            </Button>
          </span>
        );
      }
      if (status === "loading" || (!workspaceBrowseReady && path === normalizedRootPath)) {
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Spinner aria-hidden="true" size="xs" tone="slate" />
            {getDirectoryLoadingLabel(path)}
          </span>
        );
      }
      return null;
    },
    [directoryStatus, getDirectoryLoadingLabel, loadDirectory, normalizedRootPath, workspaceBrowseReady],
  );

  const resolveCreateEntryParentPath = useCallback(() => {
    const lastSelection = lastExplorerSelectionRef.current;
    if (lastSelection?.kind === "directory" && lastSelection.path) {
      return normalizePath(lastSelection.path);
    }
    if (lastSelection?.kind === "file" && lastSelection.path) {
      return getParentPath(lastSelection.path) ?? normalizedRootPath;
    }
    const viewerEntry = viewerStateRef.current.entry;
    if (viewerEntry?.kind === "directory" && viewerEntry.path) {
      return normalizePath(viewerEntry.path);
    }
    if (viewerEntry?.kind === "file" && viewerEntry.path) {
      return getParentPath(viewerEntry.path) ?? normalizedRootPath;
    }
    const currentActivePath = activeFilePathRef.current;
    if (currentActivePath) {
      return getParentPath(currentActivePath) ?? normalizedRootPath;
    }
    return normalizedRootPath;
  }, [activeFilePathRef, getParentPath, normalizePath, normalizedRootPath, viewerStateRef]);

  return {
    directoryEntries,
    directoryEntriesRef,
    directoryStatus,
    setDirectoryEntries,
    setDirectoryStatus,
    expandedDirectories,
    setExpandedDirectories,
    toggleDirectory,
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
    getDirectoryLoadingLabel,
    resolveCreateEntryParentPath,
    directoryRevsRef,
    keepFoldersRef,
  };
}
