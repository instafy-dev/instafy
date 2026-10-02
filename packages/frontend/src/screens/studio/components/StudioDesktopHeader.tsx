import { useEffect, type ReactNode, type Ref } from "react";
import { HomeSimple, NavArrowLeft, Search } from "iconoir-react";
import { normalizeOrgAccent } from "../../../org/orgAccent";
import "../../../components/OrgIdentity.css";
import { Button, IconButton } from "../../../components/Button";

/** Desktop navigation shares one row. Search temporarily expands into that row. */
export function StudioDesktopHeader({ contextRef, drawerHeaderRef, drawerWidth = 0, navigationCollapsed = false, navigationHidden = false, homeOverview = false, orgContext = true, orgName, accentColor, onHomeReturn, searchTriggerRef, searchOpen, onSearch, children }: {
  contextRef: Ref<HTMLDivElement>;
  drawerHeaderRef?: Ref<HTMLDivElement>;
  drawerWidth?: number;
  navigationCollapsed?: boolean;
  navigationHidden?: boolean;
  homeOverview?: boolean;
  orgContext?: boolean;
  orgName?: string;
  accentColor?: string | null;
  onHomeReturn?: () => void;
  searchTriggerRef: Ref<HTMLButtonElement>;
  searchOpen: boolean;
  onSearch: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey ||
        !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k" ||
        document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      onSearch();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onSearch]);

  return <header className="studio-context-header org-context-tint instafy-titlebar-drag"
    data-org-accent={!homeOverview && orgContext && !searchOpen ? normalizeOrgAccent(accentColor) ?? "slate" : undefined} aria-label={homeOverview ? "Home" : "Working context"} data-home-overview={homeOverview} data-search-open={searchOpen}
    data-navigation-collapsed={navigationCollapsed} data-navigation-hidden={navigationHidden}
    style={{ "--studio-drawer-width": `${drawerWidth}px` } as React.CSSProperties}>
    <div className="studio-desktop-context-column">
      {homeOverview && !searchOpen && onHomeReturn ? <IconButton variant="ghost" radius="lg" onPress={onHomeReturn}
        className="!min-h-11 !min-w-11 shrink-0"
        aria-label="Back to previous page" title="Back to previous page" data-testid="home-return-navigation">
        <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
      </IconButton> : null}
      {homeOverview && !searchOpen ? <h1 className="flex min-w-0 items-center gap-2 px-3 text-sm font-semibold" data-testid="studio-home-title">
        <HomeSimple className="h-5 w-5" aria-hidden="true" />Home
      </h1> : null}
      <div ref={contextRef} className="studio-context-slot" hidden={homeOverview && !searchOpen} />
      <Button ref={searchTriggerRef} variant="ghost" size="sm" radius="lg"
        className="studio-desktop-search-trigger" hidden={searchOpen}
        aria-label="Search" aria-keyshortcuts="Meta+k Control+k" title="Search (⌘K / Ctrl+K)"
        data-testid="studio-desktop-search-trigger" onPress={onSearch}>
        <Search className="h-[18px] w-[18px]" aria-hidden="true" />
      </Button>
    </div>
    {!homeOverview && drawerWidth > 0 ? <div ref={drawerHeaderRef} className="studio-desktop-drawer-header"
      hidden={searchOpen} inert={searchOpen || undefined} data-testid="studio-desktop-drawer-header" /> : null}
    {!homeOverview ? <div className="studio-desktop-tabs" hidden={searchOpen} inert={searchOpen || undefined}>
      {children}
    </div> : null}
    {!homeOverview && orgContext && !searchOpen && orgName ? <span className="studio-org-context-name" title={orgName}>{orgName}</span> : null}
  </header>;
}
