import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { controllerClient, type ControllerWorkspaceEntry } from "../../../sdk/instafy";

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
  options?: { forceFetch?: boolean },
) => Promise<void>;

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
  ensureEntryVisible: (entry: ControllerWorkspaceEntry) => Promise<void>;
  openTextFile: OpenTextFile;
  focusEditorWhenReady: () => void;
  onLocalCommit: (rev: string) => void;
  setDirectoryEntries: Dispatch<SetStateAction<Record<string, ControllerWorkspaceEntry[]>>>;
  setExpandedDirectories: Dispatch<SetStateAction<Set<string>>>;
  setSearchTerm: Dispatch<SetStateAction<string>>;
  setMobileView: Dispatch<SetStateAction<"tree" | "viewer">>;
  clearExplorerMenu: () => void;
  readOnly?: boolean;
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
}: UseFilesPanelCreateEntriesOptions) {
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
      void ensureEntryVisible(createdEntry);
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
      await ensureEntryVisible(createdEntry);
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
    setDirectoryEntries,
    showStatus,
    sortEntries,
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
