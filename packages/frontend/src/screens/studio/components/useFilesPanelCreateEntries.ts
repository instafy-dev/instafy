import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { controllerClient, type ControllerWorkspaceEntry } from "../../../sdk/instafy";
import {
  isVersionedFilesMode,
  LEGACY_FILES_VERSIONING,
  type FilesVersioning,
  type OwnRevisions,
} from "./filesVersioning";
import type { OpenTextFileOptions } from "./useFilesPanelViewerState";
import { describeSaveFailure, SAVE_COPY, type SaveCopy } from "./versioningCopy";

export type CreateEntryDraftState = {
  parentPath: string;
  draft: string;
  busy: boolean;
};

type LoadDirectory = (
  path: string,
  options?: { force?: boolean; syncMode?: "background" | "blocking" },
) => Promise<ControllerWorkspaceEntry[] | null>;

type OpenTextFile = (
  entry: ControllerWorkspaceEntry,
  options?: OpenTextFileOptions,
) => Promise<void>;

/** Versioned-mode wiring; absent in legacy mode. */
export type FilesCreateVersionedOptions = {
  ownRevisions: OwnRevisions;
  /** Listing revs and listings, from the explorer. */
  directoryRevsRef: MutableRefObject<Record<string, string | null>>;
  directoryEntriesRef: MutableRefObject<Record<string, ControllerWorkspaceEntry[]>>;
  keepFoldersRef: MutableRefObject<Set<string>>;
  /** True when a buffer already holds this path. */
  hasBuffer: (path: string) => boolean;
  /** Add a never-saved, empty buffer for a new file. */
  createBuffer: (path: string) => void;
  onWriteFailure: (copy: SaveCopy, retry: () => void) => void;
};

type UseFilesPanelCreateEntriesOptions = {
  activeProjectId: string | null;
  effectiveRuntimeId: string | null;
  isLargeScreen: boolean;
  expandedDirectories: Set<string>;
  emptyDirectoryPlaceholder: string;
  normalizePath: (path: string) => string;
  isSafeWorkspaceRelativePath: (path: string) => boolean;
  getParentPath: (path: string) => string | null;
  sortEntries: (entries: ControllerWorkspaceEntry[]) => ControllerWorkspaceEntry[];
  loadDirectory: LoadDirectory;
  showStatus: (
    message: string,
    intent?: "success" | "warning" | "error" | "info",
    durationMs?: number,
  ) => void;
  ensureEntryVisible: (entry: ControllerWorkspaceEntry) => Promise<boolean>;
  openTextFile: OpenTextFile;
  focusEditorWhenReady: () => void;
  onLocalCommit: (rev: string) => void;
  setDirectoryEntries: Dispatch<SetStateAction<Record<string, ControllerWorkspaceEntry[]>>>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  setSearchTerm: Dispatch<SetStateAction<string>>;
  setMobileView: Dispatch<SetStateAction<"tree" | "viewer">>;
  clearExplorerMenu: () => void;
  readOnly?: boolean;
  versioning?: FilesVersioning;
  versionedOptions?: FilesCreateVersionedOptions | null;
};

export function useFilesPanelCreateEntries({
  activeProjectId,
  effectiveRuntimeId,
  isLargeScreen,
  expandedDirectories,
  emptyDirectoryPlaceholder,
  normalizePath,
  isSafeWorkspaceRelativePath,
  getParentPath,
  sortEntries,
  loadDirectory,
  showStatus,
  ensureEntryVisible,
  openTextFile,
  focusEditorWhenReady,
  onLocalCommit,
  setDirectoryEntries,
  setExpandedDirectories,
  setSearchTerm,
  setMobileView,
  clearExplorerMenu,
  readOnly = false,
  versioning = LEGACY_FILES_VERSIONING,
  versionedOptions = null,
}: UseFilesPanelCreateEntriesOptions) {
  const versioned = isVersionedFilesMode(versioning) && versionedOptions !== null;
  const versionedMode = versioned ? versioning.mode : "legacy";
  const pinnedOriginId = versioned ? versioning.originId : null;
  const versionedOptionsRef = useRef(versionedOptions);
  versionedOptionsRef.current = versionedOptions;
  const [createFileState, setCreateFileState] = useState<CreateEntryDraftState | null>(null);
  const createFileInputRef = useRef<HTMLInputElement | null>(null);
  const [createFolderState, setCreateFolderState] = useState<CreateEntryDraftState | null>(null);
  const createFolderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!readOnly) {
      return;
    }
    setCreateFileState(null);
    setCreateFolderState(null);
  }, [readOnly]);

  const createFileParentPath = createFileState?.parentPath ?? null;
  const createFileParentExpanded =
    createFileParentPath === null
      ? false
      : createFileParentPath.length === 0 || expandedDirectories.has(createFileParentPath);
  useEffect(() => {
    if (createFileParentPath === null || !createFileParentExpanded) {
      return;
    }
    const node = createFileInputRef.current;
    if (!node) {
      return;
    }
    node.focus();
    node.select?.();
  }, [createFileParentExpanded, createFileParentPath]);

  const createFolderParentPath = createFolderState?.parentPath ?? null;
  const createFolderParentExpanded =
    createFolderParentPath === null
      ? false
      : createFolderParentPath.length === 0 || expandedDirectories.has(createFolderParentPath);
  useEffect(() => {
    if (createFolderParentPath === null || !createFolderParentExpanded) {
      return;
    }
    const node = createFolderInputRef.current;
    if (!node) {
      return;
    }
    node.focus();
    node.select?.();
  }, [createFolderParentExpanded, createFolderParentPath]);

  const handleStartCreateFile = useCallback(
    async (parentPath: string) => {
      if (readOnly) {
        return;
      }
      const normalizedParent = normalizePath(parentPath);
      setSearchTerm("");
      setCreateFolderState(null);
      setCreateFileState({ parentPath: normalizedParent, draft: "", busy: false });
      clearExplorerMenu();
      if (!isLargeScreen) {
        setMobileView("tree");
      }
      if (!normalizedParent) {
        return;
      }
      await loadDirectory(normalizedParent).catch(() => null);
      setExpandedDirectories((prev) => {
        const next = new Set(prev);
        next.add(normalizedParent);
        return next;
      });
    },
    [
      clearExplorerMenu,
      isLargeScreen,
      loadDirectory,
      normalizePath,
      setExpandedDirectories,
      setMobileView,
      setSearchTerm,
      readOnly,
    ],
  );

  const handleCancelCreateFile = useCallback(() => {
    setCreateFileState(null);
  }, []);

  const handleCommitCreateFile = useCallback(async () => {
    if (readOnly || !activeProjectId || !createFileState || createFileState.busy) {
      return;
    }
    const draft = createFileState.draft.trim();
    if (!draft) {
      showStatus("Enter a file name.", "warning", 2500);
      return;
    }
    if (!isSafeWorkspaceRelativePath(draft)) {
      showStatus("File path must not include .. segments.", "warning", 3500);
      return;
    }
    const normalizedParent = normalizePath(createFileState.parentPath);
    const fullPath = normalizePath(normalizedParent ? `${normalizedParent}/${draft}` : draft);
    if (!isSafeWorkspaceRelativePath(fullPath)) {
      showStatus("File path must not include .. segments.", "warning", 3500);
      return;
    }

    const versionedHooks = versioned ? versionedOptionsRef.current : null;
    if (versionedHooks) {
      // A new file is a local buffer until its first Save (no request now);
      // the save sends `expected: {path: null}`, so it cannot overwrite a
      // file that appears meanwhile.
      const parentPath = getParentPath(fullPath) ?? "";
      const listed = versionedHooks.directoryEntriesRef.current[parentPath] ?? [];
      if (versionedHooks.hasBuffer(fullPath) || listed.some((entry) => normalizePath(entry.path) === fullPath)) {
        showStatus("A file with that name already exists.", "warning", 3500);
        return;
      }
      const createdEntry = {
        name: fullPath.split("/").pop() ?? fullPath,
        path: fullPath,
        kind: "file" as const,
      } satisfies ControllerWorkspaceEntry;
      versionedHooks.createBuffer(fullPath);
      setDirectoryEntries((prev) => {
        const existingEntries = prev[parentPath];
        if (!existingEntries || existingEntries.some((entry) => normalizePath(entry.path) === fullPath)) {
          return prev;
        }
        return { ...prev, [parentPath]: sortEntries([...existingEntries, createdEntry]) };
      });
      setCreateFileState(null);
      if (!await ensureEntryVisible(createdEntry)) return;
      await openTextFile(createdEntry, { localBuffer: true });
      focusEditorWhenReady();
      return;
    }

    setCreateFileState((current) => (current ? { ...current, busy: true } : current));
    try {
      const parentPath = getParentPath(fullPath) ?? "";
      const existing = await loadDirectory(parentPath, { force: true });
      if (existing?.some((entry) => normalizePath(entry.path) === fullPath)) {
        showStatus("A file with that name already exists.", "warning", 3500);
        setCreateFileState((current) => (current ? { ...current, busy: false } : current));
        return;
      }

      const response = await controllerClient.workspace.files.write({
        projectId: activeProjectId,
        path: fullPath,
        content: "",
        runtimeId: effectiveRuntimeId ?? null,
      });
      if (!response?.ok) {
        throw new Error("Unable to create file.");
      }
      if (typeof response.rev === "string" && response.rev.trim().length > 0) {
        onLocalCommit(response.rev.trim());
      }

      const createdEntry = {
        name: fullPath.split("/").pop() ?? fullPath,
        path: fullPath,
        kind: "file" as const,
      } satisfies ControllerWorkspaceEntry;

      setDirectoryEntries((prev) => {
        const existingEntries = prev[parentPath] ?? [];
        if (existingEntries.some((entry) => normalizePath(entry.path) === fullPath)) {
          return prev;
        }
        return {
          ...prev,
          [parentPath]: sortEntries([...existingEntries, createdEntry]),
        };
      });

      void loadDirectory(parentPath, { force: true });
      if (!await ensureEntryVisible(createdEntry)) return;
      await openTextFile(createdEntry, { forceFetch: true });
      focusEditorWhenReady();
      showStatus("Created file.", "success", 2000);
      setCreateFileState(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create file.";
      showStatus(message, "error", 4000);
      setCreateFileState((current) => (current ? { ...current, busy: false } : current));
    }
  }, [
    activeProjectId,
    readOnly,
    createFileState,
    effectiveRuntimeId,
    ensureEntryVisible,
    focusEditorWhenReady,
    getParentPath,
    isSafeWorkspaceRelativePath,
    loadDirectory,
    normalizePath,
    onLocalCommit,
    openTextFile,
    setDirectoryEntries,
    showStatus,
    sortEntries,
    versioned,
  ]);

  const handleStartCreateFolder = useCallback(
    async (parentPath: string) => {
      if (readOnly) {
        return;
      }
      const normalizedParent = normalizePath(parentPath);
      setSearchTerm("");
      setCreateFileState(null);
      setCreateFolderState({ parentPath: normalizedParent, draft: "", busy: false });
      clearExplorerMenu();
      if (!isLargeScreen) {
        setMobileView("tree");
      }
      if (!normalizedParent) {
        return;
      }
      await loadDirectory(normalizedParent).catch(() => null);
      setExpandedDirectories((prev) => {
        const next = new Set(prev);
        next.add(normalizedParent);
        return next;
      });
    },
    [
      clearExplorerMenu,
      isLargeScreen,
      loadDirectory,
      normalizePath,
      setExpandedDirectories,
      setMobileView,
      setSearchTerm,
      readOnly,
    ],
  );

  const handleCancelCreateFolder = useCallback(() => {
    setCreateFolderState(null);
  }, []);

  const handleCommitCreateFolder = useCallback(async () => {
    if (readOnly || !activeProjectId || !createFolderState || createFolderState.busy) {
      return;
    }
    const draft = createFolderState.draft.trim();
    if (!draft) {
      showStatus("Enter a folder name.", "warning", 2500);
      return;
    }
    if (!isSafeWorkspaceRelativePath(draft)) {
      showStatus("Folder path must not include .. segments.", "warning", 3500);
      return;
    }
    const normalizedParent = normalizePath(createFolderState.parentPath);
    const folderPath = normalizePath(normalizedParent ? `${normalizedParent}/${draft}` : draft);
    if (!isSafeWorkspaceRelativePath(folderPath)) {
      showStatus("Folder path must not include .. segments.", "warning", 3500);
      return;
    }
    if (!folderPath) {
      showStatus("Enter a folder name.", "warning", 2500);
      return;
    }

    setCreateFolderState((current) => (current ? { ...current, busy: true } : current));
    try {
      const parentPath = getParentPath(folderPath) ?? "";
      const existing = await loadDirectory(parentPath, { force: true });
      if (existing?.some((entry) => normalizePath(entry.path) === folderPath)) {
        showStatus("A folder with that name already exists.", "warning", 3500);
        setCreateFolderState((current) => (current ? { ...current, busy: false } : current));
        return;
      }

      const placeholderPath = normalizePath(`${folderPath}/${emptyDirectoryPlaceholder}`);
      const versionedHooks = versioned ? versionedOptionsRef.current : null;
      if (versionedHooks) {
        // One commit: the placeholder, which must not exist yet, on top of
        // the parent listing's rev (stateless gateway).
        const baseRev = versionedHooks.directoryRevsRef.current[parentPath] ?? null;
        const folderName = folderPath.split("/").pop() ?? folderPath;
        const failCreate = (copy: SaveCopy) => {
          versionedHooks.onWriteFailure(copy, () => {
            setCreateFolderState({ parentPath: normalizedParent, draft, busy: false });
          });
          setCreateFolderState((current) => (current ? { ...current, busy: false } : current));
        };
        if (versionedMode === "stateless" && !baseRev) {
          failCreate({ message: SAVE_COPY.deleteRequiresBaseRev });
          return;
        }
        const result = await controllerClient.workspace.save.changes({
          projectId: activeProjectId,
          originId: pinnedOriginId,
          files: [{ path: placeholderPath, content: "", encoding: "utf8" }],
          expected: { [placeholderPath]: null },
          ...(versionedMode === "stateless" && baseRev ? { baseRev } : {}),
        });
        if (!result.ok) {
          failCreate(describeSaveFailure({ error: result.error, mode: versionedMode, label: folderName, operation: "create" }));
          return;
        }
        // Every Files panel shows the folder and moves its listings past the commit.
        versionedHooks.ownRevisions.recordCommit({
          projectId: activeProjectId,
          originId: pinnedOriginId,
          parentRev: versionedMode === "stateless" ? result.baseRev ?? null : null,
          rev: result.rev ?? null,
          writes: [{ path: placeholderPath, blobOid: null }],
          deletes: [],
        });
        versionedHooks.keepFoldersRef.current.add(folderPath);
      } else {
        const response = await controllerClient.workspace.files.write({
          projectId: activeProjectId,
          path: placeholderPath,
          content: "",
          runtimeId: effectiveRuntimeId ?? null,
        });
        if (!response?.ok) {
          throw new Error("Unable to create folder.");
        }
        if (typeof response.rev === "string" && response.rev.trim().length > 0) {
          onLocalCommit(response.rev.trim());
        }
      }

      const createdEntry = {
        name: folderPath.split("/").pop() ?? folderPath,
        path: folderPath,
        kind: "directory" as const,
      } satisfies ControllerWorkspaceEntry;

      setDirectoryEntries((prev) => {
        const existingEntries = prev[parentPath] ?? [];
        if (
          existingEntries.some(
            (entry) => entry.kind === "directory" && normalizePath(entry.path) === folderPath,
          )
        ) {
          return prev;
        }
        return {
          ...prev,
          [parentPath]: sortEntries([...existingEntries, createdEntry]),
        };
      });

      void loadDirectory(parentPath, { force: true });
      if (!await ensureEntryVisible(createdEntry)) return;
      showStatus("Created folder.", "success", 2000);
      setCreateFolderState(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create folder.";
      showStatus(message, "error", 4000);
      setCreateFolderState((current) => (current ? { ...current, busy: false } : current));
    }
  }, [
    activeProjectId,
    readOnly,
    createFolderState,
    effectiveRuntimeId,
    emptyDirectoryPlaceholder,
    ensureEntryVisible,
    getParentPath,
    isSafeWorkspaceRelativePath,
    loadDirectory,
    normalizePath,
    onLocalCommit,
    pinnedOriginId,
    setDirectoryEntries,
    showStatus,
    sortEntries,
    versioned,
    versionedMode,
  ]);

  return {
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
  };
}
