import { DARK_DIVIDER_BORDER_CLASS, DARK_PANEL_BG_CLASS, DARK_RAIL_HOVER_CLASS } from "../../../theme/darkSurfaces";
import { useCallback, useState, type ReactNode, type RefObject } from "react";
import { buildMarkdownOutlineTree, type MarkdownOutlineItem, type MarkdownOutlineTreeItem } from "../../../components/markdownOutline";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/Input";
import { Spinner } from "../../../components/Spinner";
import { TreeDisclosureButton, TreeRowMarkerSlot } from "../../../components/TreeDisclosureButton";
import {
  DRAWER_ICON_BUTTON_TONE_CLASS,
  DRAWER_LIST_ROW_TEXT_CLASS,
  LIST_ROW_SURFACE_BASE,
  LIST_ROW_FOCUS_WITHIN_RING,
  listRowSurfaceToneClassName,
} from "../../../components/listRowStyles";
import { type ControllerWorkspaceEntry } from "../../../sdk/instafy";
import { Check, Eye, Folder, Page, Xmark } from "iconoir-react";
import type { CreateEntryDraftState } from "./useFilesPanelCreateEntries";

type DirectoryEntries = Record<string, ControllerWorkspaceEntry[]>;

type FilesExplorerTreeProps = {
  rootPath: string;
  entriesMap: DirectoryEntries;
  expandedDirectories: Set<string>;
  expandedMarkdownPaths: Set<string>;
  markdownOutlines: Record<string, MarkdownOutlineItem[]>;
  markdownOutlineLoadingPaths: Set<string>;
  collapsedMarkdownSectionKeys: Set<string>;
  activePath: string | null;
  dirtyFileIds: Set<string>;
  normalizePath: (path: string) => string;
  isInstafyManagedPath: (path: string) => boolean;
  isMarkdownWorkspacePath: (path: string) => boolean;
  onSelect: (entry: ControllerWorkspaceEntry) => void;
  onToggle: (entry: ControllerWorkspaceEntry) => void;
  onToggleMarkdownOutline: (entry: ControllerWorkspaceEntry) => void;
  onSelectMarkdownSection: (entry: ControllerWorkspaceEntry, section: MarkdownOutlineItem) => void;
  onToggleMarkdownSectionCollapse: (entryPath: string, slug: string) => void;
  onFocus: (path: string) => void;
  onEntryContextMenu: (entry: ControllerWorkspaceEntry, clientX: number, clientY: number) => void;
  createFile: CreateEntryDraftState | null;
  createFileInputRef: RefObject<HTMLInputElement | null>;
  onCreateFileDraftChange: (value: string) => void;
  onCreateFileCommit: () => void;
  onCreateFileCancel: () => void;
  createFolder: CreateEntryDraftState | null;
  createFolderInputRef: RefObject<HTMLInputElement | null>;
  onCreateFolderDraftChange: (value: string) => void;
  onCreateFolderCommit: () => void;
  onCreateFolderCancel: () => void;
  touchDensity?: boolean;
};

const MARKDOWN_OUTLINE_INDENT_REM = 1.625;

export function FilesExplorerTree({
  rootPath,
  entriesMap,
  expandedDirectories,
  expandedMarkdownPaths,
  markdownOutlines,
  markdownOutlineLoadingPaths,
  collapsedMarkdownSectionKeys,
  activePath,
  dirtyFileIds,
  normalizePath,
  isInstafyManagedPath,
  isMarkdownWorkspacePath,
  onSelect,
  onToggle,
  onToggleMarkdownOutline,
  onSelectMarkdownSection,
  onToggleMarkdownSectionCollapse,
  onFocus,
  onEntryContextMenu,
  createFile,
  createFileInputRef,
  onCreateFileDraftChange,
  onCreateFileCommit,
  onCreateFileCancel,
  createFolder,
  createFolderInputRef,
  onCreateFolderDraftChange,
  onCreateFolderCommit,
  onCreateFolderCancel,
  touchDensity = false,
}: FilesExplorerTreeProps) {
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  const renderNodes = useCallback(
    (path: string, depth: number): ReactNode => {
      const entries = entriesMap[path] ?? [];
      const normalizedPath = normalizePath(path);
      const shouldShowCreateFileRow =
        createFile ? normalizePath(createFile.parentPath) === normalizedPath : false;
      const shouldShowCreateFolderRow =
        createFolder ? normalizePath(createFolder.parentPath) === normalizedPath : false;
      const shouldGroupRootEntries = depth === 0 && normalizedPath.length === 0;
      const instafyEntries = shouldGroupRootEntries
        ? entries.filter((entry) => isInstafyManagedPath(entry.path))
        : [];
      const shouldGroupInstafyEntries = shouldGroupRootEntries && instafyEntries.length > 0;
      const renderedEntries = shouldGroupInstafyEntries
        ? entries.filter((entry) => !isInstafyManagedPath(entry.path))
        : entries;

      if (!shouldShowCreateFileRow && !shouldShowCreateFolderRow && entries.length === 0) {
        return null;
      }

      const markerClassName = touchDensity ? "h-8 w-8" : undefined;
      const disclosureClassName = touchDensity ? "h-8 w-8" : undefined;
      const rowTextClassName = touchDensity ? "text-base leading-6" : DRAWER_LIST_ROW_TEXT_CLASS;
      const rowPaddingClassName = touchDensity ? "px-3.5 py-3" : "px-2.5 py-1.5";
      const createRowClassName = touchDensity ? "px-3.5 py-3 text-base" : "px-2.5 py-1.5 text-sm";

      const renderEntryNode = (
        entry: ControllerWorkspaceEntry,
        nestingDepth: number,
      ): ReactNode => {
        const normalizedEntryPath = normalizePath(entry.path);
        const isExpanded = expandedDirectories.has(normalizedEntryPath);
        const isMarkdownEntry = entry.kind === "file" && isMarkdownWorkspacePath(entry.path);
        const isMarkdownExpanded = expandedMarkdownPaths.has(normalizedEntryPath);
        const markdownOutlineItems = markdownOutlines[normalizedEntryPath] ?? [];
        const markdownOutlineTree = buildMarkdownOutlineTree(markdownOutlineItems);
        const isMarkdownOutlineLoading = markdownOutlineLoadingPaths.has(normalizedEntryPath);
        const isActive = activePath === entry.path;
        const isDirty = dirtyFileIds.has(entry.path);
        const showFocusChip = entry.kind === "directory" && (isExpanded || isActive);

        const renderMarkdownOutlineNodes = (
          nodes: MarkdownOutlineTreeItem[],
          outlineDepth = 1,
        ): ReactNode => (
          <ul className="space-y-1">
            {nodes.map((section) => {
              const sectionKey = `${normalizedEntryPath}:${section.slug}`;
              const hasChildren = section.children.length > 0;
              const isSectionExpanded = !collapsedMarkdownSectionKeys.has(sectionKey);
              const sectionRowSurfaceClassName = `${LIST_ROW_SURFACE_BASE} ${listRowSurfaceToneClassName(false)} ${LIST_ROW_FOCUS_WITHIN_RING} w-full ${touchDensity ? "px-3" : "px-2.5"} text-slate-500 dark:text-slate-400`;

              return (
                <li key={sectionKey}>
                  <div className="group">
                    <div style={{ marginLeft: `${outlineDepth * MARKDOWN_OUTLINE_INDENT_REM}rem` }}>
                      <div
                        className={`grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-1.5 ${sectionRowSurfaceClassName}`}
                      >
                        <TreeRowMarkerSlot>
                          {hasChildren ? (
                            <TreeDisclosureButton
                              expanded={isSectionExpanded}
                              className={disclosureClassName}
                              onPress={() =>
                                onToggleMarkdownSectionCollapse(normalizedEntryPath, section.slug)
                              }
                              label={
                                isSectionExpanded
                                  ? `Collapse ${section.title}`
                                  : `Expand ${section.title}`
                              }
                              title={isSectionExpanded ? "Collapse section" : "Expand section"}
                            />
                          ) : null}
                        </TreeRowMarkerSlot>
                        <button
                          type="button"
                          onClick={() => void onSelectMarkdownSection(entry, section)}
                          className={`min-w-0 rounded-[inherit] border-0 bg-transparent ${touchDensity ? "py-2 text-sm leading-5" : `py-1.5 ${DRAWER_LIST_ROW_TEXT_CLASS}`} text-left text-slate-500 focus-visible:outline-none dark:text-slate-400`}
                          data-testid={`files-markdown-heading-${entry.path.replace(/[^a-zA-Z0-9]/g, "-")}-${section.slug.replace(/[^a-zA-Z0-9]/g, "-")}`}
                        >
                          <span className="truncate">{section.title}</span>
                        </button>
                      </div>
                    </div>
                    {hasChildren && isSectionExpanded ? (
                      <div className="mt-1">
                        {renderMarkdownOutlineNodes(section.children, outlineDepth + 1)}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        );

        return (
          <li key={entry.path}>
            <div className="group">
              <div className="flex items-center">
                <Button
                  onPress={() => {
                    if (entry.kind === "directory") {
                      onToggle(entry);
                    }
                    onSelect(entry);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onEntryContextMenu(entry, event.clientX, event.clientY);
                  }}
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  className={`min-w-0 justify-start text-left ${rowPaddingClassName} ${rowTextClassName} ${listRowSurfaceToneClassName(isActive)} ${LIST_ROW_SURFACE_BASE} ${
                    isActive
                      ? "text-slate-900 dark:text-slate-50"
                      : "text-slate-600 dark:text-slate-300"
                  }`}
                  data-testid={`files-entry-${entry.path.replace(/[^a-zA-Z0-9]/g, "-")}`}
                  aria-expanded={
                    entry.kind === "directory"
                      ? isExpanded
                      : isMarkdownEntry
                        ? isMarkdownExpanded
                        : undefined
                  }
                >
                  <div className="flex w-full min-w-0 items-center justify-between gap-2.5">
                    {entry.kind === "directory" ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <TreeRowMarkerSlot className={markerClassName}>
                          <TreeDisclosureButton expanded={isExpanded} className={disclosureClassName} />
                        </TreeRowMarkerSlot>
                        <span className="truncate">{entry.name}</span>
                      </span>
                    ) : (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        {isMarkdownEntry ? (
                          <TreeRowMarkerSlot className={markerClassName}>
                            <TreeDisclosureButton
                              expanded={isMarkdownExpanded}
                              loading={isMarkdownOutlineLoading}
                              pressElement="span"
                              className={disclosureClassName}
                              onPress={() => void onToggleMarkdownOutline(entry)}
                              label={
                                isMarkdownExpanded
                                  ? `Collapse sections in ${entry.name}`
                                  : `Expand sections in ${entry.name}`
                              }
                              title={isMarkdownExpanded ? "Collapse sections" : "Expand sections"}
                              testId={`files-outline-toggle-${entry.path.replace(/[^a-zA-Z0-9]/g, "-")}`}
                            />
                          </TreeRowMarkerSlot>
                        ) : null}
                        <TreeRowMarkerSlot className={["text-slate-400 dark:text-slate-500", markerClassName].filter(Boolean).join(" ")}>
                          <Page aria-hidden="true" />
                        </TreeRowMarkerSlot>
                        <span className="truncate">{entry.name}</span>
                      </span>
                    )}
                    {isDirty ? (
                      <span className="text-xs text-rose-500 dark:text-rose-400">●</span>
                    ) : null}
                  </div>
                </Button>
                {entry.kind === "directory" ? (
                  <IconButton
                    onPress={() => onFocus(entry.path)}
                    variant="outline"
                    size={touchDensity ? "lg" : "xs"}
                    radius="full"
                    aria-label={`Focus ${entry.name}`}
                    title={`Focus ${entry.name}`}
                    data-testid={`files-focus-${entry.path.replace(/[^a-zA-Z0-9]/g, "-")}`}
                    className={`ml-2 text-slate-600 dark:text-slate-300 ${
                      showFocusChip || touchDensity ? "inline-flex" : "hidden group-hover:inline-flex"
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  </IconButton>
                ) : null}
              </div>
              {entry.kind === "directory" && isExpanded ? (
                <div className={touchDensity ? "mt-1.5 pl-2" : "mt-2 pl-2"}>{renderNodes(normalizedEntryPath, nestingDepth + 1)}</div>
              ) : null}
              {isMarkdownEntry && isMarkdownExpanded ? (
                <div className="mt-2">
                  {isMarkdownOutlineLoading ? (
                    <div className="inline-flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                      <Spinner aria-hidden="true" size="xs" tone="slate" />
                      <span>Loading sections…</span>
                    </div>
                  ) : markdownOutlineTree.length > 0 ? (
                    renderMarkdownOutlineNodes(markdownOutlineTree)
                  ) : (
                    <div className="px-2.5 py-1 text-xs text-slate-400 dark:text-slate-500">
                      No headings in this file yet.
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </li>
        );
      };

      return (
        <ul className={depth === 0 ? (touchDensity ? "space-y-1.5" : "space-y-1") : touchDensity ? "mt-1 space-y-1.5 pl-2" : "mt-1 space-y-1 pl-2"}>
          {shouldShowCreateFolderRow ? (
            <li key={`__create-folder-${normalizedPath || "root"}`}>
              <div className={`flex items-center gap-2 rounded-lg border border-slate-200 bg-white ${createRowClassName} text-slate-700 shadow-sm shadow-slate-900/5 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS} dark:text-slate-100 dark:shadow-none`}>
                <span className={["inline-flex items-center justify-center text-slate-400 dark:text-slate-500", touchDensity ? "h-8 w-8" : "h-5 w-5"].join(" ")}>
                  <Folder aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <Input
                    ref={createFolderInputRef}
                    value={createFolder?.draft ?? ""}
                    onChange={(event) => onCreateFolderDraftChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onCreateFolderCommit();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        onCreateFolderCancel();
                      }
                    }}
                    placeholder="New folder name…"
                    aria-label="New folder name"
                    disabled={createFolder?.busy === true}
                    data-testid="files-explorer-create-folder-input"
                    unstyled
                    className={touchDensity ? "text-base" : "text-sm"}
                  />
                </div>
                <IconButton
                  variant="ghost"
                  size={touchDensity ? "lg" : "xs"}
                  radius="full"
                  aria-label="Create folder"
                  title="Create folder"
                  onPress={onCreateFolderCommit}
                  isDisabled={createFolder?.busy === true}
                  className={`text-slate-500 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-400 ${DARK_RAIL_HOVER_CLASS}`}
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size={touchDensity ? "lg" : "xs"}
                  radius="full"
                  aria-label="Cancel"
                  title="Cancel"
                  onPress={onCreateFolderCancel}
                  isDisabled={createFolder?.busy === true}
                  className={`text-slate-500 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-400 ${DARK_RAIL_HOVER_CLASS}`}
                >
                  <Xmark className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </div>
            </li>
          ) : null}
          {shouldShowCreateFileRow ? (
            <li key={`__create-file-${normalizedPath || "root"}`}>
              <div className={`flex items-center gap-2 rounded-lg border border-slate-200 bg-white ${createRowClassName} text-slate-700 shadow-sm shadow-slate-900/5 ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS} dark:text-slate-100 dark:shadow-none`}>
                <span className={["inline-flex items-center justify-center text-slate-400 dark:text-slate-500", touchDensity ? "h-8 w-8" : "h-5 w-5"].join(" ")}>
                  <Page aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <Input
                    ref={createFileInputRef}
                    value={createFile?.draft ?? ""}
                    onChange={(event) => onCreateFileDraftChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onCreateFileCommit();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        onCreateFileCancel();
                      }
                    }}
                    placeholder="New file name…"
                    aria-label="New file name"
                    disabled={createFile?.busy === true}
                    data-testid="files-explorer-create-file-input"
                    unstyled
                    className={touchDensity ? "text-base" : "text-sm"}
                  />
                </div>
                <IconButton
                  variant="ghost"
                  size={touchDensity ? "lg" : "xs"}
                  radius="full"
                  aria-label="Create file"
                  title="Create file"
                  onPress={onCreateFileCommit}
                  isDisabled={createFile?.busy === true}
                  className={DRAWER_ICON_BUTTON_TONE_CLASS}
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size={touchDensity ? "lg" : "xs"}
                  radius="full"
                  aria-label="Cancel"
                  title="Cancel"
                  onPress={onCreateFileCancel}
                  isDisabled={createFile?.busy === true}
                  className={DRAWER_ICON_BUTTON_TONE_CLASS}
                >
                  <Xmark className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </div>
            </li>
          ) : null}
          {shouldGroupInstafyEntries ? (
            <li key="__settings-section">
              <Button
                onPress={() => setSettingsExpanded((current) => !current)}
                variant="ghost"
                size="sm"
                radius="lg"
                fullWidth
                className={`min-w-0 justify-start text-left ${rowPaddingClassName} ${rowTextClassName} ${LIST_ROW_SURFACE_BASE} text-slate-500 hover:bg-slate-50 data-[hovered]:bg-slate-50 dark:text-slate-400 ${DARK_RAIL_HOVER_CLASS}`}
                data-testid="files-settings-toggle"
                aria-expanded={settingsExpanded}
              >
                <div className="inline-flex w-full min-w-0 items-center gap-1.5">
                  <TreeRowMarkerSlot className={markerClassName}>
                    <TreeDisclosureButton expanded={settingsExpanded} className={disclosureClassName} />
                  </TreeRowMarkerSlot>
                  <span className="inline-flex h-5 items-center truncate text-xxs uppercase tracking-[0.12em] leading-none">
                    Settings
                  </span>
                </div>
              </Button>
              {settingsExpanded ? (
                <ul className="mt-1 space-y-1 pl-2">
                  {instafyEntries.map((entry) => renderEntryNode(entry, depth + 1))}
                </ul>
              ) : null}
            </li>
          ) : null}
          {renderedEntries.map((entry) => renderEntryNode(entry, depth))}
        </ul>
      );
    },
    [
      activePath,
      collapsedMarkdownSectionKeys,
      createFile,
      createFileInputRef,
      createFolder,
      createFolderInputRef,
      dirtyFileIds,
      entriesMap,
      expandedDirectories,
      expandedMarkdownPaths,
      isInstafyManagedPath,
      isMarkdownWorkspacePath,
      markdownOutlineLoadingPaths,
      markdownOutlines,
      normalizePath,
      onCreateFileCancel,
      onCreateFileCommit,
      onCreateFileDraftChange,
      onCreateFolderCancel,
      onCreateFolderCommit,
      onCreateFolderDraftChange,
      onEntryContextMenu,
      onFocus,
      onSelect,
      onSelectMarkdownSection,
      onToggle,
      onToggleMarkdownOutline,
      onToggleMarkdownSectionCollapse,
      touchDensity,
      settingsExpanded,
    ],
  );

  return <>{renderNodes(rootPath, 0)}</>;
}
