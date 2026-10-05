import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { DrawerHeader } from "../../../components/DrawerHeader";
import { SearchInput } from "../../../components/SearchInput";
import { DRAWER_ICON_BUTTON_TONE_CLASS } from "../../../components/listRowStyles";
import type { MobilePageHeader } from "./MobileStudioNavigationHeader";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";

export function FilesExplorerToolbar({
  headerPortalTarget, renderMobileHeader, menuActions, rootPath, onFocusDirectory,
  searchTerm, onSearchTermChange, actions,
}: {
  headerPortalTarget?: HTMLElement | null;
  renderMobileHeader?: (header: MobilePageHeader) => ReactNode;
  menuActions?: MobilePageHeader["menuActions"];
  rootPath: string;
  onFocusDirectory: (path: string) => void;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  actions?: ReactNode;
}) {
  const isLargeScreen = useStudioDesktopLayout();
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // A retained query must always remain visible, including after a resize.
  const showSearch = searchOpen || searchTerm.length > 0;
  const searchLabel = showSearch ? "Clear and close file filter" : "Filter loaded files";
  const closeSearch = () => {
    onSearchTermChange("");
    setSearchOpen(false);
    toggleRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);
  const segments = rootPath.split("/").filter(Boolean);

  const actionsWithSearch = <>
    <IconButton
      ref={toggleRef} variant={showSearch ? "secondary" : "ghost"}
      size="sm" radius="full" aria-label={searchLabel} title={searchLabel}
      aria-expanded={showSearch} aria-controls={showSearch ? "code-search" : undefined}
      data-testid="files-explorer-search-toggle"
      onPress={() => showSearch ? closeSearch() : setSearchOpen(true)}
      className={`max-[899px]:h-11 max-[899px]:w-11 ${DRAWER_ICON_BUTTON_TONE_CLASS}`}
    ><Search className="h-4 w-4" aria-hidden="true" /></IconButton>
    {actions}
  </>;
  const mobileHeader = !isLargeScreen && renderMobileHeader
    ? renderMobileHeader({ title: "Files", actions: actionsWithSearch, menuActions }) : null;
  return <>
    {mobileHeader ? <div className="-mx-4">{mobileHeader}</div> : <DrawerHeader
      title="Files" pageTitle frame="rail" portalTarget={isLargeScreen ? headerPortalTarget : null}
      className={isLargeScreen && headerPortalTarget ? undefined : "-mx-4"}
      actions={actionsWithSearch} />}
    {segments.length > 0 ? <nav aria-label="File location"
      className="mt-2 flex min-h-8 min-w-0 items-center gap-1 overflow-hidden text-xs font-medium text-slate-500 dark:text-slate-400">
      <Button variant="ghost" size="xs" radius="full" onPress={() => onFocusDirectory("")}
        aria-label="Focus root folder" className="shrink-0 px-1">Root</Button>
      {segments.map((segment, index) => {
        const path = segments.slice(0, index + 1).join("/");
        return <span key={path} className="flex min-w-0 items-center gap-1">
          <span aria-hidden="true">/</span>
          {index === segments.length - 1
            ? <span aria-current="location" title={path} className="truncate text-slate-700 dark:text-slate-200">{segment}</span>
            : <Button variant="ghost" size="xs" radius="full" onPress={() => onFocusDirectory(path)}
                className="max-w-32 truncate px-1" title={path}>{segment}</Button>}
        </span>;
      })}
    </nav> : null}
    {showSearch ? <div className="mt-3" data-testid="files-explorer-search-row">
      <SearchInput ref={inputRef} id="code-search" label="Filter loaded files"
        value={searchTerm} onChange={event => onSearchTermChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeSearch();
          }
        }}
        placeholder="Filter name or path" tone="default" radius="xl"
        size={isLargeScreen ? "sm" : "md"}
        className="min-h-10 max-[899px]:min-h-11 pointer-coarse:min-h-11"
        aria-describedby="files-filter-scope" iconTestId="code-search-icon" inputTestId="code-search-input" />
      <p id="files-filter-scope" className="mt-1 text-xs text-slate-500 dark:text-slate-400">Only loaded folders are included.</p>
    </div> : null}
  </>;
}
